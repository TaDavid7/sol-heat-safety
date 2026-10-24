import express from "express";
import { config } from "./config.js";
import { log } from "./events.js";
import * as twilio from "./twilio.js";
import { calls, answer, hear, endCall, missed, failSafe, filler, startInbound, findByTwilioSid, lastWorkerCalled } from "./calls.js";
import { acknowledge, handleSupervisorSms, crewSummary, openAlerts, pendingEmergency } from "./escalate.js";
import { workers, findWorker, workerByPhone, ingestGps, snapshot, clock, farm } from "./world.js";
import { temperature, temperatureSource } from "./weather.js";
import { usage } from "./sol.js";

export const router = express.Router();
const xml = (res, body) => res.type("text/xml").send(body);
const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));
const HANG_UP = "<Response><Hangup/></Response>";

function twiml(call, { say, ended }) {
  if (!ended) return twilio.sayAndListen(say, call.lang, `/twilio/gather?call=${call.id}`);
  endCall(call, "completed"); // report is in; free the line now rather than waiting for the status callback
  return twilio.sayAndHangUp(say, call.lang);
}

// Twilio gives a webhook ~15 s. Past 13 s, speak the fail-safe line rather than error out.
const TWILIO_BUDGET_MS = 13000;
const inTime = async (call, promise) => (await Promise.race([promise, timeout(TWILIO_BUDGET_MS)])) || failSafe(call, "Claude timed out");

// ---------- Twilio webhooks ----------
router.use("/twilio", (req, res, next) => {
  if (config.twilio.skipValidation || twilio.validSignature(req)) return next();
  log("twilio_rejected", { path: req.path });
  res.status(403).send("invalid signature");
});

const callFor = (req) => calls.get(req.query.call) || findByTwilioSid(req.body.CallSid);

// Outbound call answered (after the trial-account keypress).
router.post("/twilio/voice", async (req, res) => {
  const call = callFor(req);
  if (!call || call.status === "ended") return xml(res, HANG_UP);
  call.twilioSid ||= req.body.CallSid;
  xml(res, twiml(call, await inTime(call, answer(call))));
});

// Speech (or silence) arrived. Start Claude now, cover the wait with a filler, then redirect.
router.post("/twilio/gather", (req, res) => {
  const call = callFor(req);
  if (!call || call.status === "ended") return xml(res, HANG_UP);
  const text = req.body.SpeechResult || "";
  call.pending = hear(call, { text, confidence: req.body.Confidence, silence: !text });
  const redirect = `<Redirect method="POST">${twilio.url(`/twilio/reply?call=${call.id}`)}</Redirect>`;
  xml(res, `<Response>${text ? twilio.say(filler(call), call.lang) : ""}${redirect}</Response>`);
});

router.post("/twilio/reply", async (req, res) => {
  const call = callFor(req);
  if (!call || !call.pending) return xml(res, HANG_UP);
  const result = await inTime(call, call.pending);
  call.pending = null;
  if (call.status === "ended" && !result.say) return xml(res, HANG_UP);
  xml(res, twiml(call, result));
});

// Final call status. Calls that were never answered count as missed.
router.post("/twilio/status", (req, res) => {
  const call = callFor(req);
  if (call && call.status !== "ended") {
    if (call.status === "ringing") missed(call, req.body.CallStatus);
    else endCall(call, "call dropped before Sol could confirm they are okay");
  }
  res.sendStatus(204);
});

// Someone dialed Sol's number.
router.post("/twilio/inbound", async (req, res) => {
  const from = req.body.From;
  if (from && from === config.supervisorPhone) {
    const pending = pendingEmergency();
    const summary = crewSummary().replace(/^Sol: /, "This is Sol. ");
    if (!pending) return xml(res, twilio.sayAndHangUp(summary, "en"));
    return xml(res, twilio.sayAndAskDigit(`${summary} Press 1 if you are going to ${pending.worker.name} now.`, `/twilio/ack?alert=${pending.id}`));
  }

  let w = workerByPhone(from);
  if (!w && from && from === config.demoPhone) w = findWorker(config.demoWorkerId) || lastWorkerCalled || workers[0];
  if (!w) w = { id: "unknown", name: "Unknown caller", language: "Spanish", phone: from, stub: true, status: "unknown" };
  if (w.callId) return xml(res, twilio.sayAndHangUp(w.language === "English" ? "Sol is already on a call with you. Please try again in a minute." : "Sol ya está en una llamada con usted. Intente de nuevo en un minuto.", w.language === "English" ? "en" : "es"));

  const call = startInbound(w, "twilio", req.body.CallSid);
  xml(res, twiml(call, await inTime(call, answer(call))));
});

// Supervisor pressed a key on an emergency call.
router.post("/twilio/ack", (req, res) => {
  if (req.body.Digits === "1" && acknowledge(req.query.alert)) {
    return xml(res, twilio.sayAndHangUp("Thank you. Sol logged that you are on the way. Text OK and their name when they are safe.", "en"));
  }
  xml(res, twilio.sayAndHangUp("No confirmation received. Sol will call again, or text OK and their name when they are safe.", "en"));
});

// Supervisor text message: OK <name> · STATUS · 1
router.post("/twilio/sms", (req, res) => {
  if (req.body.From !== config.supervisorPhone) return xml(res, "<Response/>");
  log("sms_in", { from: config.supervisorName, text: req.body.Body });
  const reply = handleSupervisorSms(req.body.Body);
  log("sms_out", { to: config.supervisorName, text: reply });
  xml(res, `<Response><Message>${reply.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</Message></Response>`);
});

// ---------- Machine APIs (no human UI) ----------
router.post("/api/gps", (req, res) => {
  if (config.gpsToken && req.get("Authorization") !== `Bearer ${config.gpsToken}`) return res.sendStatus(401);
  const pings = Array.isArray(req.body) ? req.body : [req.body];
  let accepted = 0;
  for (const p of pings) {
    const w = findWorker(p.worker_id);
    if (w && Number.isFinite(+p.lat) && Number.isFinite(+p.lng)) { ingestGps(w, +p.lat, +p.lng); accepted++; }
  }
  res.json({ accepted });
});

router.get("/api/state", (req, res) => {
  res.json({
    farm: farm.name, simTime: new Date(clock.t).toISOString(), speed: clock.speed,
    temperatureF: temperature(), temperatureSource: temperatureSource(),
    workers: workers.map(snapshot), alerts: openAlerts().map(({ timer, ...a }) => a), usage,
  });
});
