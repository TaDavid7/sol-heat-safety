import readline from "node:readline";
import { config } from "./config.js";
import { bus } from "./events.js";
import { answer, hear, endCall, missed, place, liveCalls } from "./calls.js";
import { handleSupervisorSms, pendingEmergency, acknowledge } from "./escalate.js";
import { sched } from "./scheduler.js";
import { clock, workers, findWorker, snapshot } from "./world.js";
import { setOverride, temperature, refresh } from "./weather.js";
import { usage } from "./sol.js";

// Backstage console: a colored live event log (projected for judges) plus simulator
// commands. When Twilio isn't configured, worker calls ring here and you play the worker.

const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = c(2), bold = c(1), cyan = c(36), yellow = c(33), red = c(31), green = c(32), magenta = c(35), inv = c(7);
const LEVEL = { ok: green, warning: yellow, emergency: red };

let rl;
let phone = null; // the terminal-transport call currently ringing or active
let busy = false;

function print(line) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(line);
  rl?.prompt(true);
}

const FORMAT = {
  clock: (e) => dim(`── ${e.time} · ${e.tempF}°F · ${workers.length} workers: ${e.ok || 0} ok, ${e.warning || 0} warning, ${e.emergency || 0} emergency ──`),
  trigger: (e) => magenta(`⚡ ${e.worker}: ${e.reason}`) + dim(` (no shade ${e.minutesSinceBreak} min, still ${e.minutesStationary} min, ${e.tempF}°F)`),
  call_placed: (e) => `📞 Sol is calling ${bold(e.worker)} · ${e.reason}${e.retry ? " (retry)" : ""} · via ${e.transport}`,
  call_inbound: (e) => `📞 ${bold(e.worker)} called the Sol line`,
  call_answered: (e) => dim(`   ${e.worker} picked up`),
  sol_said: (e) => cyan(`   Sol › ${e.text}`) + (e.failsafe ? red(" [fail-safe]") : ""),
  worker_said: (e) => `   ${e.worker.split(" ")[0]} › ${e.text}` + (e.confidence ? dim(` (${Number(e.confidence).toFixed(2)})`) : ""),
  report: (e) => LEVEL[e.level](`   📋 report_status: ${e.level.toUpperCase()}`) + dim(` · ${e.symptoms} · took_break=${e.took_break}`) +
    (e.proposed !== e.level ? yellow(` · raised from ${e.proposed} (${e.floors.join(", ") || e.source})`) : "") + (e.source !== "claude" ? dim(` · by ${e.source}`) : ""),
  call_ended: (e) => dim(`   call ended · ${e.worker} · ${e.level}`),
  call_missed: (e) => yellow(`   ✗ ${e.worker} did not answer (${e.status})`),
  retry_scheduled: (e) => dim(`   will retry ${e.worker} in ${e.inSec}s`),
  alert: (e) => LEVEL[e.level](bold(`🚨 ALERT #${e.alertId} ${e.level.toUpperCase()} · ${e.worker} · ${e.symptoms}`)),
  sms_out: (e) => yellow(`   📟 SMS → ${e.to}: `) + e.text,
  sms_in: (e) => yellow(`   📟 SMS ← ${e.from}: `) + e.text,
  supervisor_call: (e) => red(`   ☎  Calling ${config.supervisorName} (attempt ${e.attempt}/${e.of}): `) + dim(`"${e.text}"`),
  alert_ack: (e) => green(`✅ ${config.supervisorName} pressed 1: on the way to ${e.worker}`),
  alert_resolved: (e) => green(`✅ ${e.worker} marked safe; normal check-ins resume`),
  stuck: (e) => inv(red(` STUCK `)) + red(bold(` ${e.text}`)),
  system_alert: (e) => inv(red(" SYSTEM ")) + " " + red(e.text),
  claude_error: (e) => red(`   Claude error: ${e.error}`),
  twilio_error: (e) => red(`   Twilio error: ${e.error}`),
  weather_error: () => dim("   (weather fetch failed; using fallback temperature)"),
};

function statusTable() {
  const rows = workers.map(snapshot).map((s) => {
    const st = (LEVEL[s.status] || dim)(s.status.padEnd(9));
    return `  ${s.name.padEnd(16)} ${st} ${String(s.minutesSinceBreak).padStart(4)} min since shade  ${String(s.minutesStationary).padStart(3)} min still  ${s.behavior.padEnd(12)} ${dim(s.location)}${s.hold ? red(" HOLD") : ""}${s.onCall ? cyan(" ON CALL") : ""}`;
  });
  const t = new Date(clock.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return [bold(`${t} · ${temperature()}°F · speed ${clock.speed}x${sched.userPaused ? " · PAUSED" : ""} · routine ${sched.routine ? "on" : "off"} · Claude $${usage.costUsd.toFixed(3)}`), ...rows].join("\n");
}

const HELP = `
${bold("Simulator")}   /status   /temp <F>|auto   /speed <n>   /pause
            /stop <name>  (stops moving)   /skip <name>  (skips breaks)   /normal <name>
            /call <name> [not_moving|break_overdue|routine]   /routine on|off
${bold("Supervisor")}  /sms <text>  (e.g. /sms OK JOSE, /sms STATUS)   /ack  (press 1)
${bold("On a call")}   Enter answers · type to speak · /silent · /hangup · /decline
            /quit`;

async function onPhone(line) {
  const call = phone;
  busy = true;
  try {
    let result;
    if (call.status === "ringing") {
      if (line === "/decline" || line === "/hangup") return missed(call, "declined");
      if (line === "/silent") return print(dim("(still ringing: press Enter to answer)"));
      result = await answer(call);
    } else if (line === "/hangup") {
      return endCall(call, "worker hung up before Sol could confirm they are okay");
    } else {
      result = await hear(call, line === "/silent" ? { silence: true } : { text: line });
    }
    if (result.ended) endCall(call, "completed");
  } finally {
    busy = false;
  }
}

function setBehavior(name, behavior) {
  const w = findWorker(name);
  if (!w) return print(red(`No worker "${name}". Try: ${workers.map((x) => x.name.split(" ")[0]).join(", ")}`));
  w.source = "sim";
  w.behavior = behavior;
  w.goingToShade = false;
  w.breakUntil = null;
  print(dim(`${w.name} → ${behavior}`));
}

async function command(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "help": return print(HELP);
    case "status": return print(statusTable());
    case "temp":
      if (arg === "auto") { setOverride(null); await refresh(); }
      else if (arg && Number.isFinite(Number(arg))) setOverride(Number(arg));
      else return print(red("Usage: /temp 104  or  /temp auto"));
      return print(dim(`temperature ${temperature()}°F`));
    case "speed": clock.speed = Math.max(1, Number(arg) || 1); return print(dim(`speed ${clock.speed}x`));
    case "pause": sched.userPaused = !sched.userPaused; return print(dim(sched.userPaused ? "paused" : "resumed"));
    case "stop": return setBehavior(arg, "stops_moving");
    case "skip": return setBehavior(arg, "skips_breaks");
    case "normal": return setBehavior(arg, "normal");
    case "routine": sched.routine = arg !== "off"; return print(dim(`routine calls ${sched.routine ? "on" : "off"}`));
    case "call": {
      const [name, reason = "routine"] = rest;
      const w = findWorker(name);
      if (!w) return print(red(`No worker "${name}"`));
      if (w.callId || liveCalls().length) return print(red("A call is already in progress."));
      return place(w, reason);
    }
    case "sms": return print(yellow("   📟 reply: ") + handleSupervisorSms(arg));
    case "ack": {
      const a = pendingEmergency();
      return a ? acknowledge(a.id) : print(dim("No emergency waiting for confirmation."));
    }
    case "quit": case "exit": process.exit(0);
    default: return print(red(`Unknown command /${cmd}. /help`));
  }
}

export function startTerminal() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "sol> " });
  bus.on("log", (e) => FORMAT[e.type] && print(FORMAT[e.type](e)));
  bus.on("ring", (call) => {
    phone = call;
    const lang = call.lang === "es" ? "Spanish" : "English";
    print(inv(bold(` ☎  PHONE A RINGING `)) + bold(` You are ${call.worker.name} (${lang}). Press Enter to answer, /decline to ignore.`));
  });
  bus.on("ended", (call) => { if (phone === call) phone = null; });

  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (busy) return print(dim("(Sol is thinking…)"));
    try {
      const isPhoneCmd = ["/silent", "/hangup", "/decline"].includes(line);
      if (phone && (!line.startsWith("/") || isPhoneCmd)) await onPhone(line);
      else if (line.startsWith("/")) await command(line);
      else if (line) print(dim("No call right now. /help for commands."));
    } catch (err) {
      print(red(err.stack || String(err)));
    }
    rl.prompt();
  });

  print(bold(`\n☀  Sol heat-safety line · ${config.farm.name}`) + dim(`  (${config.simulate ? `simulated field, ${clock.speed}x` : "live GPS"})`));
  print(HELP);
  print(statusTable());
  rl.prompt();
}
