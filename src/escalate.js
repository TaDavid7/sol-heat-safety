import { config } from "./config.js";
import { log } from "./events.js";
import * as twilio from "./twilio.js";
import { workers, describeLocation, mapsLink, findWorker, now } from "./world.js";

// Alerts and the supervisor side: SMS, emergency calls that repeat until someone
// presses 1, SMS commands (OK <name>, STATUS), and a spoken crew summary.

export const alerts = []; // { id, workerId, level, symptoms, state: open|acknowledged|resolved|stuck, pages, createdAt }
let nextId = 1;
const RANK = { ok: 0, warning: 1, emergency: 2 };
const es = config.supervisorLanguage === "es";
const firstName = (w) => w.name.split(" ")[0];
const replyName = (w) => firstName(w).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const where = (w) => (w.stub ? `unregistered caller ${w.phone || ""}`.trim() : describeLocation(w));
const Where = (w) => where(w).replace(/^./, (c) => c.toUpperCase()); // sentence start

async function deliver(kind, fn) {
  if (!twilio.enabled || !config.supervisorPhone) return; // terminal mode: the log line is the delivery
  try { await fn(); } catch (err) { log("twilio_error", { kind, error: err.message }); }
}

export function sms(text) {
  log("sms_out", { to: config.supervisorName, text });
  return deliver("sms", () => twilio.sendSms(config.supervisorPhone, text));
}

function emergencyScript(a, w) {
  return es
    ? `Emergencia de calor de Sol. ${w.name}, ${where(w)}. Señales: ${a.symptoms}. Si su vida corre peligro, llame al 911 ahora. Presione 1 si va en camino.`
    : `Sol heat-safety emergency. ${w.name}, ${where(w)}. Signs: ${a.symptoms}. If this is life-threatening, call 911 now. Press 1 if you are going to them.`;
}

function pageSupervisor(a, w) {
  a.pages++;
  const text = emergencyScript(a, w);
  log("supervisor_call", { alertId: a.id, attempt: a.pages, of: config.maxPages, text });
  deliver("call", () =>
    twilio.placeCall(config.supervisorPhone, { twiml: twilio.sayAndAskDigit(text, `/twilio/ack?alert=${a.id}`, config.supervisorLanguage) }),
  );
  a.timer = setTimeout(() => repage(a, w), config.ackTimeoutSec * 1000);
  a.timer.unref?.();
}

// The system knows when it is stuck: after maxPages with no acknowledgement it stops
// dialing and says so loudly, instead of looping forever.
function repage(a, w) {
  if (a.state !== "open") return;
  if (a.pages < config.maxPages) {
    sms(`SOL EMERGENCY (reminder ${a.pages + 1}/${config.maxPages}) – ${w.name} still needs help. Reply OK ${replyName(w)} when safe.`);
    return pageSupervisor(a, w);
  }
  a.state = "stuck";
  log("stuck", { alertId: a.id, worker: w.name, text: `Nobody confirmed the emergency for ${w.name} after ${a.pages} calls.` });
  sms(`SOL STUCK – no one has confirmed help for ${w.name} after ${a.pages} calls. Go to ${where(w)} now or call 911. ${mapsLink(w)}`);
}

// Called from report_status. Returns the tool_result text Sol sees, so what Sol tells
// the worker matches what actually happened.
export function escalate(w, report) {
  const open = alerts.find((a) => a.worker === w && (a.state === "open" || a.state === "acknowledged" || a.state === "stuck"));
  // a calmer call never hides an alert a human hasn't closed yet
  w.status = open && RANK[open.level] > RANK[report.level] ? open.level : report.level;
  if (report.level === "ok") return "Recorded: ok. No alert sent. Say one short closing line.";

  if (open && RANK[open.level] >= RANK[report.level]) {
    open.symptoms = report.symptoms;
    return `Recorded: ${report.level}. The supervisor already has an open alert for this worker. Say one short closing line.`;
  }
  if (open) close(open, "superseded");

  const a = { id: String(nextId++), workerId: w.id, worker: w, level: report.level, symptoms: report.symptoms, state: "open", pages: 0, createdAt: Date.now() };
  alerts.push(a);
  log("alert", { alertId: a.id, worker: w.name, level: a.level, symptoms: a.symptoms });
  const map = w.stub ? "" : ` ${mapsLink(w)}`;

  if (a.level === "warning") {
    sms(`SOL WARNING – ${w.name}: ${a.symptoms}. ${Where(w)}.${map} Sol told them to rest in shade. Reply OK ${replyName(w)} after you check on them.`);
    return "Recorded: warning. The supervisor was sent a text and will check on them. Say one short closing line.";
  }

  w.hold = true; // no more automatic calls until a human resolves it
  sms(`SOL EMERGENCY – ${w.name}: ${a.symptoms}. ${Where(w)}.${map} Call 911 if life-threatening. Reply OK ${replyName(w)} when safe.`);
  pageSupervisor(a, w);
  return "Recorded: emergency. The supervisor is being called right now and is coming. Say one short closing line: help is coming, do not be alone, stay in the shade if you can.";
}

function close(a, state) {
  clearTimeout(a.timer);
  a.state = state;
}

// Pressing 1 works on an open or STUCK alert, and pressing it twice is harmless.
export function acknowledge(alertId) {
  const a = alerts.find((x) => x.id === alertId);
  if (!a) return false;
  if (a.state === "acknowledged") return true;
  if (a.state !== "open" && a.state !== "stuck") return false;
  close(a, "acknowledged");
  log("alert_ack", { alertId: a.id, worker: a.worker.name });
  return true;
}

export function resolve(w) {
  const mine = alerts.filter((a) => a.worker === w && a.state !== "resolved" && a.state !== "superseded");
  for (const a of mine) close(a, "resolved");
  w.hold = false;
  w.status = "ok";
  w.lastCallAt = now(); // don't call them again the instant they're cleared
  log("alert_resolved", { worker: w.name, alerts: mine.map((a) => a.id) });
  return mine.length;
}

export const openAlerts = () => alerts.filter((a) => a.state === "open" || a.state === "acknowledged" || a.state === "stuck");
export const pendingEmergency = () => openAlerts().find((a) => (a.state === "open" || a.state === "stuck") && a.level === "emergency");

// Supervisor SMS commands: OK [name] · STATUS · 1
export function handleSupervisorSms(body) {
  const text = String(body || "").trim();
  if (/^(status|estado)$/i.test(text)) return crewSummary();
  if (/^1$/.test(text)) {
    const a = pendingEmergency();
    return a && acknowledge(a.id) ? "Sol: logged that you are on the way." : "Sol: no emergency is waiting for confirmation.";
  }
  const ok = text.match(/^ok\b\s*(.*)$/i);
  if (ok) {
    // people with open alerts, including unregistered callers (who aren't in the roster)
    const flagged = [...new Set(openAlerts().map((a) => a.worker))];
    let w = null;
    if (ok[1]) {
      w = findWorker(ok[1]) || flagged.find((x) => replyName(x) === replyName({ name: ok[1] }));
      if (!w) return `Sol: I don't know a worker called "${ok[1]}".`;
    } else {
      if (flagged.length === 0) return "Sol: there are no open alerts.";
      if (flagged.length > 1) return "Sol: more than one alert is open. Reply " + flagged.map((x) => `OK ${replyName(x)}`).join(" or ") + ".";
      w = flagged[0];
    }
    resolve(w);
    return `Sol: ${w.name} marked safe. Normal check-ins resume.`;
  }
  return "Sol commands: OK <name> marks a worker safe. STATUS gives a crew summary.";
}

export function crewSummary() {
  const callers = [...new Set(openAlerts().map((a) => a.worker))].filter((w) => w.stub);
  const em = [...workers, ...callers].filter((w) => w.status === "emergency");
  const wa = [...workers, ...callers].filter((w) => w.status === "warning");
  const parts = [`${workers.length} workers.`];
  if (em.length) parts.push(`${em.length} emergency: ` + em.map((w) => `${w.name}, ${w.lastReport?.symptoms || "unknown"}, ${where(w)}`).join("; ") + ".");
  if (wa.length) parts.push(`${wa.length} warning: ` + wa.map((w) => `${w.name}, ${w.lastReport?.symptoms || "unknown"}`).join("; ") + ".");
  if (!em.length && !wa.length) parts.push("No open warnings or emergencies.");
  return "Sol: " + parts.join(" ");
}

export function systemAlert(text) {
  log("system_alert", { text });
  sms(`SOL SYSTEM – ${text}`);
}
