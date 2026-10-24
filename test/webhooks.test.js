// Webhook + escalation tests with Claude stubbed. No network, no Twilio account.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

Object.assign(process.env, {
  TWILIO_SKIP_VALIDATION: "1",
  TWILIO_AUTH_TOKEN: "test-token",
  PUBLIC_URL: "https://sol.example",
  SUPERVISOR_PHONE: "+15550000002",
  RETRY_AFTER_SEC: "0",
  ACK_TIMEOUT_SEC: "0.02",
  MAX_PAGES: "3",
  SOL_LOG: path.join(os.tmpdir(), `sol-test-${process.pid}.jsonl`),
  ANTHROPIC_API_KEY: "test",
});

const express = (await import("express")).default;
const { router } = await import("../src/routes.js");
const sol = await import("../src/sol.js");
const calls = await import("../src/calls.js");
const world = await import("../src/world.js");
const esc = await import("../src/escalate.js");
const twilio = await import("../src/twilio.js");
const { bus } = await import("../src/events.js");

// ---- fake Claude: each test queues responses ----
let queue = [];
sol.setClient({ beta: { messages: { create: async () => {
  const next = queue.shift();
  if (!next) throw new Error("fake Claude: no response queued");
  if (next instanceof Error) throw next;
  return { usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: next.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content: next };
} } } });
const say = (text) => ({ type: "text", text });
let toolN = 0;
const report = (level, symptoms = "none", took_break = "yes") => ({ type: "tool_use", id: `t${++toolN}`, name: "report_status", input: { worker_id: "x", level, symptoms, took_break } });

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(router);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const post = async (p, form = {}) => (await fetch(base + p, { method: "POST", body: new URLSearchParams(form) })).text();
const events = [];
bus.on("log", (e) => events.push(e));

function fresh(w) {
  Object.assign(w, { callId: null, hold: false, status: "unknown", retryPending: false, lastReport: null });
  esc.alerts.length = 0;
  events.length = 0;
  queue = [];
}

test("outbound call: greeting, filler while thinking, warning texts supervisor, hangs up", async () => {
  const w = world.findWorker("ana");
  fresh(w);
  const call = calls.place(w, "break_overdue");

  queue.push([say("Hola Ana, soy Sol. ¿Cómo se siente?")]);
  const voice = await post(`/twilio/voice?call=${call.id}`, { CallSid: "CA1" });
  assert.match(voice, /<Gather input="speech" language="es-US"/);
  assert.match(voice, /Hola Ana/);

  queue.push([say("Por favor descanse en la sombra."), report("warning", "headache", "yes")], [say("Su supervisor va a venir. Adiós.")]);
  const gather = await post(`/twilio/gather?call=${call.id}`, { SpeechResult: "me duele la cabeza", Confidence: "0.8" });
  assert.match(gather, /<Say[^>]*>(Ajá|Mm-hm|Ok)…<\/Say><Redirect/);

  const reply = await post(`/twilio/reply?call=${call.id}`);
  assert.match(reply, /<Hangup\/>/);
  assert.match(reply, /descanse/);
  assert.equal(w.status, "warning");
  assert.equal(esc.alerts[0].level, "warning");
  assert.ok(events.some((e) => e.type === "sms_out" && /SOL WARNING – Ana Ruiz/.test(e.text)));
  assert.ok(w.goingToShade, "sim worker heads to shade");

  await post(`/twilio/status?call=${call.id}`, { CallStatus: "completed" });
  assert.equal(call.status, "ended");
  assert.equal(w.callId, null);
});

test("two silences floor the level to emergency even if Claude says ok; supervisor is paged", async () => {
  const w = world.findWorker("jose");
  fresh(w);
  const call = calls.place(w, "not_moving");
  queue.push([say("Hola José…")]);
  await post(`/twilio/voice?call=${call.id}`);

  queue.push([say("¿José? ¿Me escucha?")]);
  const g = await post(`/twilio/gather?call=${call.id}`, { SpeechResult: "" });
  assert.doesNotMatch(g, /<Say/, "no filler after silence");
  await post(`/twilio/reply?call=${call.id}`);

  queue.push([report("ok", "none", "no")], [say("La ayuda viene.")]);
  await post(`/twilio/gather?call=${call.id}`, { SpeechResult: "" });
  await post(`/twilio/reply?call=${call.id}`);

  assert.equal(call.report.level, "emergency");
  assert.equal(call.report.proposed, "ok");
  assert.equal(w.hold, true);
  assert.ok(events.some((e) => e.type === "supervisor_call"));
});

test("unacknowledged emergency re-pages then goes STUCK; SMS OK resolves", async () => {
  const w = world.findWorker("jose");
  await new Promise((r) => setTimeout(r, 200));
  const a = esc.alerts.find((x) => x.workerId === w.id && x.level === "emergency");
  assert.equal(a.state, "stuck");
  assert.equal(a.pages, 3);
  assert.ok(events.some((e) => e.type === "stuck"));

  const reply = await post("/twilio/sms", { From: "+15550000002", Body: "ok jose" });
  assert.match(reply, /José Hernández marked safe/);
  assert.equal(w.hold, false);
  assert.equal(a.state, "resolved");
});

test("pressing 1 acknowledges and stops paging", async () => {
  const w = world.findWorker("luis");
  fresh(w);
  const call = calls.place(w, "not_moving");
  calls.endCall(call, "call dropped before Sol could confirm they are okay"); // dropped mid-call → emergency
  const a = esc.alerts.at(-1);
  assert.equal(a.level, "emergency");
  const twiml = await post(`/twilio/ack?alert=${a.id}`, { Digits: "1" });
  assert.match(twiml, /on the way/);
  assert.equal(a.state, "acknowledged");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.pages, 1, "no more pages after ack");
});

test("missed call retries once, then escalates", async () => {
  const w = world.findWorker("tom");
  fresh(w);
  const first = calls.place(w, "routine");
  await post(`/twilio/status?call=${first.id}`, { CallStatus: "no-answer" });
  assert.equal(w.status, "unknown", "first miss only schedules a retry");
  await new Promise((r) => setTimeout(r, 20));
  const retry = calls.calls.get(w.callId);
  assert.ok(retry?.retry);
  await post(`/twilio/status?call=${retry.id}`, { CallStatus: "no-answer" });
  assert.equal(w.status, "emergency");
  assert.match(esc.alerts.at(-1).symptoms, /did not answer two calls/);
});

test("Claude failure speaks the fail-safe line and raises a warning", async () => {
  const w = world.findWorker("rosa");
  fresh(w);
  const call = calls.place(w, "routine");
  queue.push(new Error("overloaded"));
  const voice = await post(`/twilio/voice?call=${call.id}`);
  assert.match(voice, /descanse en la sombra/);
  assert.match(voice, /<Hangup\/>/);
  assert.equal(w.status, "warning");
});

test("supervisor SMS STATUS and inbound status call", async () => {
  const status = await post("/twilio/sms", { From: "+15550000002", Body: "STATUS" });
  assert.match(status, /6 workers/);
  const ignored = await post("/twilio/sms", { From: "+15559999999", Body: "OK" });
  assert.equal(ignored, "<Response/>");
  const voice = await post("/twilio/inbound", { From: "+15550000002" });
  assert.match(voice, /This is Sol\. 6 workers/);
});

test("Twilio signature validation", () => {
  const params = { CallSid: "CA9", SpeechResult: "hola" };
  const data = "https://sol.example/twilio/gather?call=abc" + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const sig = crypto.createHmac("sha1", "test-token").update(data).digest("base64");
  const req = (s) => ({ get: () => s, body: params, originalUrl: "/twilio/gather?call=abc" });
  assert.equal(twilio.validSignature(req(sig)), true);
  assert.equal(twilio.validSignature(req("forged")), false);
});

test("GPS ingest updates shade time", async () => {
  const w = world.findWorker("maria");
  const tent = world.farm.shade[0];
  const { lat, lng } = world.toLatLng(tent.x, tent.y);
  const res = await fetch(base + "/api/gps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ worker_id: "w1", lat, lng }) });
  assert.deepEqual(await res.json(), { accepted: 1 });
  assert.equal(w.source, "gps");
  assert.equal(world.inShade(w), true);
  assert.equal(Math.round(world.minutesSince(w.lastShadeAt)), 0);
});

test("a later calm call never hides an open emergency; pressing 1 works even after STUCK", async () => {
  const w = world.findWorker("maria");
  fresh(w);
  const first = calls.place(w, "not_moving");
  calls.endCall(first, "call dropped before Sol could confirm they are okay");
  assert.equal(w.status, "emergency");

  w.hold = false; // pretend a manual call goes through anyway
  const second = calls.place(w, "routine");
  queue.push([say("Hola María.")]);
  await post(`/twilio/voice?call=${second.id}`);
  queue.push([say("Qué bueno."), report("ok")]);
  await post(`/twilio/gather?call=${second.id}`, { SpeechResult: "estoy bien" });
  await post(`/twilio/reply?call=${second.id}`);
  assert.equal(w.status, "emergency", "ok report must not downgrade the open alert");

  await new Promise((r) => setTimeout(r, 200));
  const a = esc.alerts.find((x) => x.worker === w);
  assert.equal(a.state, "stuck");
  assert.match(await post(`/twilio/ack?alert=${a.id}`, { Digits: "1" }), /on the way/);
  assert.equal(a.state, "acknowledged");
  assert.match(await post(`/twilio/ack?alert=${a.id}`, { Digits: "1" }), /on the way/, "second press is harmless");
});

test("a call that never reports is cut off by the turn cap", async () => {
  const w = world.findWorker("tom");
  fresh(w);
  const call = calls.place(w, "routine");
  queue.push([say("Hi Tom.")]);
  await calls.answer(call);
  let r;
  for (let i = 0; i < 8; i++) {
    queue.push([say("Tell me more.")]);
    r = await calls.hear(call, { text: "blah" });
  }
  assert.equal(r.ended, true);
  assert.equal(call.report.source, "failsafe");
  queue = [];
});

test("unregistered caller: emergency can be resolved by SMS", async () => {
  esc.alerts.length = 0;
  queue.push([say("Sol aquí, ¿qué pasa?")]);
  const voice = await post("/twilio/inbound", { From: "+15557770000", CallSid: "CA77" });
  assert.match(voice, /Sol aquí/);
  queue.push([say("La ayuda viene."), report("emergency", "coworker collapsed", "no")]);
  await post("/twilio/gather", { CallSid: "CA77", SpeechResult: "mi compañero se cayó" });
  assert.equal(esc.alerts.at(-1).level, "emergency");
  assert.match(await post("/twilio/sms", { From: "+15550000002", Body: "STATUS" }), /Unknown caller/);
  assert.match(await post("/twilio/sms", { From: "+15550000002", Body: "OK" }), /marked safe/);
});
