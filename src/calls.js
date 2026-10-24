import crypto from "node:crypto";
import { config } from "./config.js";
import { bus, log } from "./events.js";
import * as sol from "./sol.js";
import * as twilio from "./twilio.js";
import { escalate } from "./escalate.js";
import { workers, farm, now, minutesSince } from "./world.js";
import { temperature } from "./weather.js";

// Call lifecycle and the conversation loop. Transport-agnostic: Twilio routes and
// the terminal simulator both drive calls through answer() / hear() / endCall().

export const calls = new Map();
const starts = []; // real timestamps of placed calls, for the per-hour cap
const RANK = { ok: 0, warning: 1, emergency: 2 };
const langCode = (language) => (/^span|^es/i.test(language) ? "es" : "en");
const LANG_NAME = { es: "Spanish", en: "English" };

const FILLERS = { es: ["Ajá…", "Mm-hm…", "Ok…"], en: ["Okay…", "Mm-hm…", "Got it…"] };
export const filler = (call) => FILLERS[call.lang][Math.floor(Math.random() * 3)];

const FAILSAFE = {
  es: "Perdón, tengo problemas con la línea. Por favor descanse en la sombra y tome agua. Su supervisor va a venir a verle.",
  en: "Sorry, I'm having trouble with the line. Please rest in the shade and drink water. Your supervisor will come check on you.",
};

export const callsLastHour = () => {
  while (starts.length && Date.now() - starts[0] > 3600_000) starts.shift();
  return starts.length;
};
export const liveCalls = () => [...calls.values()].filter((c) => c.status === "ringing" || c.status === "active");
export let lastWorkerCalled = null;

// One physical phone (demo) or the terminal can only take one worker call at a time.
export const singlePhone = () => !twilio.enabled || Boolean(config.demoPhone);

// Every call has exactly one watchdog: ring timeout while ringing, idle timeout once
// answered. A lost Twilio callback or an abandoned terminal call can't block the line.
const CALL_IDLE_SEC = 90;
function arm(call, sec, fn) {
  clearTimeout(call.timer);
  call.timer = setTimeout(fn, sec * 1000);
  call.timer.unref?.();
}
const armIdle = (call) => arm(call, CALL_IDLE_SEC, () => endCall(call, "call went quiet before Sol could confirm they are okay"));

function newCall(w, reason, direction, transport, extra = {}) {
  const call = {
    id: crypto.randomUUID().slice(0, 8), workerId: w.id, worker: w, reason, direction, transport,
    status: "ringing", lang: langCode(w.language), messages: [], transcript: [],
    silences: 0, workerTurns: 0, report: null, createdAt: Date.now(), ...extra,
  };
  calls.set(call.id, call);
  w.callId = call.id;
  return call;
}

export function place(w, reason, { retry = false } = {}) {
  const transport = twilio.enabled && (config.demoPhone || w.phone) ? "twilio" : "terminal";
  const call = newCall(w, reason, "outbound", transport, { retry });
  w.lastCallAt = now();
  w.lastCallReason = reason;
  lastWorkerCalled = w;
  starts.push(Date.now());
  log("call_placed", { callId: call.id, worker: w.name, reason, transport, retry });

  if (transport === "twilio") {
    twilio
      .placeCall(config.demoPhone || w.phone, { url: twilio.url(`/twilio/voice?call=${call.id}`), statusPath: `/twilio/status?call=${call.id}` })
      .then((r) => (call.twilioSid = r.sid))
      .catch((err) => { log("twilio_error", { callId: call.id, error: err.message }); missed(call, "failed"); });
    arm(call, config.ringTimeoutSec + 30, () => call.status === "ringing" && missed(call, "no status from Twilio"));
  } else {
    bus.emit("ring", call);
    arm(call, config.ringTimeoutSec, () => call.status === "ringing" && missed(call, "no-answer"));
  }
  return call;
}

export function startInbound(w, transport, twilioSid) {
  const call = newCall(w, "worker_called_in", "inbound", transport, { twilioSid });
  if (!w.stub) w.lastCallAt = now();
  log("call_inbound", { callId: call.id, worker: w.name });
  return call;
}

export const findByTwilioSid = (sid) => [...calls.values()].find((c) => c.twilioSid === sid);

function promptVars(call) {
  const w = call.worker;
  return {
    farm_name: farm.name,
    temperature: temperature(),
    language: LANG_NAME[call.lang],
    minutes_since_break: w.stub ? "unknown" : Math.round(minutesSince(w.lastShadeAt)),
    minutes_stationary: w.stub ? "unknown" : Math.round(minutesSince(w.lastMovedAt)),
    call_reason: call.reason,
    worker_id: w.id,
    worker_name: w.stub ? "unknown caller (ask their name)" : w.name,
  };
}

export function answer(call) {
  armIdle(call);
  call.status = "active";
  call.answeredAt = Date.now();
  call.system = sol.buildSystem(promptVars(call));
  log("call_answered", { callId: call.id, worker: call.worker.name });
  const opener = call.direction === "inbound" ? "[The worker called the Sol line.]" : "[The worker picked up the phone.]";
  return converse(call, opener);
}

// One worker utterance (or silence) in, one Sol reply out.
export function hear(call, { text, confidence, silence }) {
  const said = String(text || "").trim();
  armIdle(call);
  call.workerTurns++;
  let content;
  if (silence || !said) {
    call.silences++;
    content = "[silence]";
  } else {
    content = confidence != null && confidence !== "" ? `[heard, confidence ${Number(confidence).toFixed(2)}] "${said}"` : `[heard] "${said}"`;
  }
  call.transcript.push({ who: "worker", text: said || "(silence)" });
  log("worker_said", { callId: call.id, worker: call.worker.name, text: said || "(silence)", confidence });
  return converse(call, content);
}

async function converse(call, userContent) {
  call.messages.push({ role: "user", content: userContent });
  if (call.workerTurns >= config.maxWorkerTurns + 2 && !call.report) return failSafe(call, "turn cap reached without a report");
  if (call.workerTurns >= config.maxWorkerTurns && !call.report) {
    // operator nudge, appended (history stays append-only)
    call.messages.push({ role: "system", content: "Time is up. Call report_status now with the most serious level that fits, then say goodbye in one sentence." });
  }

  const spoken = [];
  try {
    for (let i = 0; i < 3; i++) {
      // once the report is in, the closing line only gets a short wait; a local goodbye beats dead air
      const resp = await sol.ask(call.system, call.messages, call.report ? 5000 : undefined);
      call.messages.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason === "refusal") throw new Error("model declined");
      for (const b of resp.content) if (b.type === "text" && b.text.trim()) spoken.push(b.text.trim());

      const uses = resp.content.filter((b) => b.type === "tool_use");
      if (!uses.length) break;
      const results = uses.map((u) => ({
        type: "tool_result",
        tool_use_id: u.id,
        content: u.name === "report_status" ? applyReport(call, u.input, "claude") : `Unknown tool ${u.name}`,
        is_error: u.name !== "report_status",
      }));
      call.messages.push({ role: "user", content: results });
      if (call.report && spoken.length) break; // Sol already said its piece; skip a second round trip
    }
  } catch (err) {
    log("claude_error", { callId: call.id, error: err.message });
    if (!call.report) return failSafe(call, err.message);
    // the report is already recorded and escalated: just close politely below
  }
  if (call.status === "ended") return { say: "", ended: true }; // fail-safe already took over

  let say = spoken.join(" ");
  call.lang = sol.detectLang(say, call.lang);
  if (!say) say = call.report ? (call.lang === "es" ? "Cuídese. Adiós." : "Take care. Goodbye.") : (call.lang === "es" ? "¿Me escucha?" : "Can you hear me?");
  call.transcript.push({ who: "sol", text: say });
  log("sol_said", { callId: call.id, text: say });
  return { say, ended: !!call.report };
}

export function failSafe(call, why) {
  if (call.status === "ended") return { say: "", ended: true };
  const say = FAILSAFE[call.lang];
  log("failsafe", { callId: call.id, why });
  if (!call.report) applyReport(call, { level: "warning", symptoms: "Sol could not finish the call, check on them in person", took_break: "no" }, "failsafe");
  call.transcript.push({ who: "sol", text: say });
  log("sol_said", { callId: call.id, text: say, failsafe: true });
  return { say, ended: true };
}

// Claude proposes, rules can only raise. Both levels are logged.
export function applyReport(call, input, source) {
  const w = call.worker;
  const proposed = RANK[input?.level] != null ? input.level : "emergency";
  let level = proposed;
  const floors = [];
  if (call.silences >= 2) { level = "emergency"; floors.push("2+ silences"); }
  if (call.reason === "break_overdue" && input?.took_break === "no" && level === "ok") { level = "warning"; floors.push("skipped overdue break"); }

  if (call.report && RANK[call.report.level] >= RANK[level]) return "Already recorded. Say one short closing line.";
  call.report = { level, proposed, floors, symptoms: input?.symptoms || "none", took_break: input?.took_break || "no", source };
  w.lastReport = { ...call.report, at: now() };
  log("report", { callId: call.id, worker: w.name, ...call.report });

  // sim workers follow Sol's advice and head to shade
  if (!w.stub && w.source === "sim" && (call.report.took_break === "yes" || level === "warning")) w.goingToShade = true;
  return escalate(w, call.report);
}

export function endCall(call, why) {
  if (call.status === "ended") return;
  clearTimeout(call.timer);
  call.status = "ended";
  if (call.worker.callId === call.id) call.worker.callId = null;
  if (!call.report) applyReport(call, { level: "emergency", symptoms: why, took_break: "no" }, "system");
  log("call_ended", { callId: call.id, worker: call.worker.name, level: call.report.level });
  bus.emit("ended", call);
}

// Never answered (no-answer, busy, failed, or trial notice not passed).
export function missed(call, status) {
  if (call.status === "ended") return;
  clearTimeout(call.timer);
  call.status = "ended";
  const w = call.worker;
  if (w.callId === call.id) w.callId = null;
  log("call_missed", { callId: call.id, worker: w.name, status, retry: call.retry });

  if (!call.retry) {
    w.retryPending = true;
    log("retry_scheduled", { worker: w.name, inSec: config.retryAfterSec });
    const retry = () => {
      if (singlePhone() && liveCalls().length) return setTimeout(retry, 5000).unref?.(); // the one phone is busy
      w.retryPending = false;
      if (!w.callId && !w.hold) place(w, call.reason, { retry: true });
    };
    setTimeout(retry, config.retryAfterSec * 1000).unref?.();
  } else {
    applyReport(call, { level: "emergency", symptoms: "did not answer two calls in a row", took_break: "no" }, "system");
  }
  bus.emit("ended", call);
}

export const workerById = (id) => workers.find((w) => w.id === id);
