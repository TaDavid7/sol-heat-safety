// Pre-recorded demo calls (no phones needed).
//   npm run demo:audio      → demo/audio/*.wav + demo/audio/transcript.md
//
// 1. Runs the real Sol engine with live Claude on scripted English worker lines, so every
//    word Sol says, every alert level, and every supervisor message is genuine output.
// 2. Voices it with Windows text-to-speech (Sol = Zira, worker = David).
// 3. Adds phone sounds and mixes each scenario into one telephone-quality WAV.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "audio");
const WORK = path.join(here, "..", "data", "tts"); // scratch WAVs (gitignored)
process.env.SOL_LOG ||= path.join(here, "..", "data", "demo-events.jsonl");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const calls = await import("../src/calls.js");
const world = await import("../src/world.js");
const { setOverride } = await import("../src/weather.js");
const { bus } = await import("../src/events.js");
const { acknowledge, alerts } = await import("../src/escalate.js");
setOverride(104);

// ---------------------------------------------------------------- scenarios
const SCENARIOS = [
  {
    id: "1-warning-call",
    title: "Warning: Tom has a headache and is overdue for a break",
    worker: "tom",
    reason: "break_overdue",
    setup: (w) => { w.lastShadeAt = world.now() - 125 * 60000; },
    lines: ["Hey. Honestly, I've got a headache, and I feel a little dizzy.", "Okay. I'll head to the shade tent now."],
  },
  {
    id: "2-emergency-call",
    title: "Emergency: José stopped moving and sounds confused",
    worker: "jose",
    reason: "not_moving",
    setup: (w) => { w.language = "English"; w.lastMovedAt = world.now() - 12 * 60000; },
    lines: ["Uh... what?... where... I don't... the sun is...", null, null], // null = silence
    confused: true,
  },
];

async function runScenario(sc) {
  const w = world.findWorker(sc.worker);
  sc.setup(w);
  const events = [];
  const onLog = (e) => events.push(e);
  bus.on("log", onLog);

  const call = calls.place(w, sc.reason);
  let r = await calls.answer(call);
  const turns = [{ who: "sol", text: r.say }];
  const script = [...sc.lines];
  while (!r.ended) {
    const line = script.length ? script.shift() : sc.confused ? null : "Okay.";
    turns.push({ who: "worker", text: line, silence: line === null });
    turns.push({ who: "filler", text: line === null ? null : calls.filler(call) });
    r = await calls.hear(call, line === null ? { silence: true } : { text: line });
    turns.push({ who: "sol", text: r.say });
    if (turns.length > 40) break;
  }
  calls.endCall(call, "demo ended");
  bus.off("log", onLog);
  return {
    ...sc, workerName: w.name, turns, report: call.report,
    sms: events.filter((e) => e.type === "sms_out").map((e) => e.text),
    supervisorCall: events.find((e) => e.type === "supervisor_call")?.text,
  };
}

// ---------------------------------------------------------------- audio
const RATE = 8000;
const sec = (s) => Math.round(s * RATE);
const VOICE = { sol: "Microsoft Zira Desktop", worker: "Microsoft David Desktop" };
const xml = (s) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

function ssml(text, voice, { slow = false } = {}) {
  // "..." becomes a real pause, which is what makes the confused worker sound confused
  const body = xml(text).split(/\s*(?:\.\.\.|…)\s*/).join(' <break time="700ms"/> ');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="${slow ? "slow" : "medium"}">${body}</prosody></voice></speak>`;
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  let i = 12;
  while (i < buf.length - 8) {
    const id = buf.toString("ascii", i, i + 4), size = buf.readUInt32LE(i + 4);
    if (id === "data") return new Int16Array(buf.buffer.slice(buf.byteOffset + i + 8, buf.byteOffset + i + 8 + size));
    i += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

function writeWav(file, samples) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + samples.length * 2, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(samples.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]));
}

const tone = (freqs, dur, amp = 5000) => {
  const n = sec(dur), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 80, (n - i) / 80); // soft edges, no clicks
    out[i] = Math.round(amp * env * freqs.reduce((s, f) => s + Math.sin((2 * Math.PI * f * i) / RATE), 0) / freqs.length);
  }
  return out;
};
const silence = (dur) => new Int16Array(sec(dur));
const cat = (...parts) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
// phone ringing: two short warbling bursts per ring
const warble = (dur) => { const out = []; for (let t = 0; t < dur; t += 0.05) out.push(tone([Math.round(t / 0.05) % 2 ? 1000 : 800], 0.05, 4500)); return cat(...out); };
const ring = (times = 2) => cat(...Array.from({ length: times }, () => cat(warble(0.4), silence(0.2), warble(0.4), silence(1.4))));
const hangup = () => cat(silence(0.4), ...Array.from({ length: 3 }, () => cat(tone([480, 620], 0.25), silence(0.25))));
const dtmf1 = () => cat(silence(0.3), tone([697, 1209], 0.2, 7000), silence(0.6));
const chime = () => cat(silence(0.8), tone([1319], 0.12, 4000), tone([1760], 0.18, 4000), silence(0.5));
const hiss = (samples, amp = 90) => samples.map((s) => Math.max(-32768, Math.min(32767, s + Math.round((Math.random() - 0.5) * amp))));

const forSpeech = (text) => text.replace(/https?:\/\/\S+/g, "map link.").replace(/–/g, ",").replace(/\bSOL\b/g, "Sol");

// ---------------------------------------------------------------- main
console.log("Running live Sol calls (Claude)...");
const results = [];
for (const sc of SCENARIOS) {
  const r = await runScenario(sc);
  console.log(`  ${r.id}: ${r.report.level} (${r.report.symptoms})`);
  results.push(r);
}
// the supervisor answers the emergency page and presses 1
const emergency = results.find((r) => r.supervisorCall);
const pending = alerts.find((a) => a.level === "emergency");
if (pending) acknowledge(pending.id);
const ackLine = "Thank you. Sol logged that you are on the way. Text OK and their name when they are safe.";

// text-to-speech jobs
const jobs = [];
const say = (text, voice, opts) => {
  const file = path.join(WORK, `clip-${jobs.length}.wav`);
  jobs.push({ file, ssml: ssml(text, voice, opts) });
  return file;
};
const timelines = {};
for (const r of results) {
  const tl = [{ sfx: "ring" }];
  for (const t of r.turns) {
    if (t.who === "worker") tl.push(t.silence ? { pause: 6 } : { clip: say(t.text, VOICE.worker, { slow: r.confused }) });
    else if (t.who === "filler") { if (t.text) tl.push({ pause: 0.3 }, { clip: say(t.text, VOICE.sol) }); }
    else if (t.text) tl.push({ pause: 0.5 }, { clip: say(t.text, VOICE.sol) });
  }
  tl.push({ sfx: "hangup" });
  for (const m of r.sms) tl.push({ sfx: "chime" }, { clip: say(`New text message to the supervisor. ${forSpeech(m)}`, VOICE.sol) });
  timelines[r.id] = tl;
}
if (emergency) {
  timelines["3-supervisor-call"] = [
    { sfx: "ring" }, { pause: 0.4 }, { clip: say(emergency.supervisorCall, VOICE.sol) }, { sfx: "dtmf1" },
    { clip: say(ackLine, VOICE.sol) }, { sfx: "hangup" },
  ];
}

console.log(`Synthesizing ${jobs.length} voice clips (Windows TTS)...`);
const jobFile = path.join(WORK, "jobs.json");
fs.writeFileSync(jobFile, JSON.stringify(jobs), "utf8");
execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "tts.ps1"), jobFile], { stdio: "inherit" });

const SFX = { ring, hangup, dtmf1, chime };
const render = (tl) => hiss(cat(...tl.map((s) => (s.sfx ? SFX[s.sfx]() : s.pause ? silence(s.pause) : readWav(s.clip)))));
const files = [];
for (const [id, tl] of Object.entries(timelines)) {
  const audio = render(tl);
  const file = path.join(OUT, `${id}.wav`);
  writeWav(file, audio);
  files.push({ id, file, seconds: audio.length / RATE });
}
writeWav(path.join(OUT, "sol-demo-full.wav"), cat(...files.flatMap((f) => [readWav(f.file), silence(2.5)])));

// transcript for the presenter
const md = ["# Sol demo recordings", "", "Generated by `npm run demo:audio`. Sol's lines, alert levels and supervisor messages are real output from the live system; the worker lines are scripted.", ""];
for (const r of results) {
  const f = files.find((x) => x.id === r.id);
  md.push(`## ${r.id}.wav (${Math.round(f.seconds)} s): ${r.title}`, "");
  for (const t of r.turns) {
    if (t.who === "sol") md.push(`- **Sol:** ${t.text}`);
    else if (t.who === "worker") md.push(`- **${r.workerName.split(" ")[0]}:** ${t.silence ? "*(silence)*" : t.text}`);
  }
  md.push("", `**Result:** \`report_status\` = **${r.report.level.toUpperCase()}** (${r.report.symptoms})${r.report.proposed !== r.report.level ? `, raised from ${r.report.proposed} by a safety rule` : ""}`, "");
  for (const m of r.sms) md.push(`**Text to supervisor:** ${m}`, "");
}
if (emergency) {
  const f = files.find((x) => x.id === "3-supervisor-call");
  md.push(`## 3-supervisor-call.wav (${Math.round(f.seconds)} s): Sol calls the supervisor`, "", `- **Sol:** ${emergency.supervisorCall}`, "- *(supervisor presses 1)*", `- **Sol:** ${ackLine}`, "");
}
md.push("## sol-demo-full.wav", "", "All of the above back to back, with short gaps.", "");
fs.writeFileSync(path.join(OUT, "transcript.md"), md.join("\n"));

for (const f of files) console.log(`  ${path.relative(process.cwd(), f.file)}  ${f.seconds.toFixed(1)} s`);
console.log(`  ${path.relative(process.cwd(), path.join(OUT, "sol-demo-full.wav"))}`);
console.log(`Claude cost: $${(await import("../src/sol.js")).usage.costUsd.toFixed(3)}`);
process.exit(0);
