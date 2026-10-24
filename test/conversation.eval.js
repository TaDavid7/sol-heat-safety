// Conversation evals against the real Claude API (a few cents per run).
// Each case plays a worker through a full call and checks the final level.
//   npm run test:eval
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.SOL_LOG ||= path.join(os.tmpdir(), `sol-eval-${process.pid}.jsonl`);
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const calls = await import("../src/calls.js");
const world = await import("../src/world.js");
const { setOverride } = await import("../src/weather.js");
setOverride(104);

// worker lines: string = speech (optionally {text, confidence}), null = silence
const CASES = [
  { name: "feels fine", worker: "tom", reason: "routine", lines: ["I'm good, drinking water, no headache."], expect: ["ok"] },
  { name: "headache → warning", worker: "maria", reason: "routine", lines: ["Me duele la cabeza y estoy un poco mareada."], expect: ["warning", "emergency"] },
  { name: "refuses overdue break → warning", worker: "ana", reason: "break_overdue", lines: ["Estoy bien.", "No, no puedo parar ahora, tengo que terminar la fila."], expect: ["warning"] },
  { name: "confused, slurred → emergency", worker: "jose", reason: "not_moving", lines: [{ text: "qué… dónde… el sol está… no sé", confidence: 0.31 }, { text: "mmm… sí sí sí… agua", confidence: 0.28 }], expect: ["emergency"] },
  { name: "silence → emergency", worker: "luis", reason: "not_moving", lines: [null, null], expect: ["emergency"] },
  { name: "coworker collapsed → emergency", worker: "rosa", reason: "routine", lines: ["Yo estoy bien pero mi compañero se cayó y no se mueve!"], expect: ["emergency"] },
  { name: "switches to English", worker: "maria", reason: "routine", lines: ["Can we speak English? I feel fine, thanks."], expect: ["ok"], lang: "en" },
];

for (const c of CASES) {
  test(c.name, { skip: !hasKey && "no ANTHROPIC_API_KEY" , timeout: 120_000 }, async () => {
    const w = world.findWorker(c.worker);
    Object.assign(w, { callId: null, hold: false, status: "unknown" });
    const call = calls.place(w, c.reason);
    let r = await calls.answer(call);
    const log = [`Sol: ${r.say}`];
    for (const line of c.lines) {
      if (r.ended) break;
      const turn = line === null ? { silence: true } : typeof line === "string" ? { text: line } : line;
      log.push(`Worker: ${line === null ? "(silence)" : turn.text}`);
      r = await calls.hear(call, turn);
      log.push(`Sol: ${r.say}`);
    }
    // Keep the call going with neutral replies until Sol reports (as a real call would).
    for (let i = 0; !r.ended && i < 4; i++) {
      r = await calls.hear(call, c.lines.at(-1) === null ? { silence: true } : { text: "okay" });
      log.push(`Sol: ${r.say}`);
    }
    calls.endCall(call, "eval ended");
    console.log(`\n[${c.name}] → ${call.report.level} (Claude proposed ${call.report.proposed})\n  ` + log.join("\n  "));
    assert.ok(c.expect.includes(call.report.level), `expected ${c.expect.join("/")}, got ${call.report.level}`);
    if (c.lang) assert.equal(call.lang, c.lang);
  });
}
