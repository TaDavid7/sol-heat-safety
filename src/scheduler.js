import { config } from "./config.js";
import { log } from "./events.js";
import * as sol from "./sol.js";
import { place, liveCalls, callsLastHour, singlePhone } from "./calls.js";
import { systemAlert } from "./escalate.js";
import { clock, workers, advance, simulate, inShade, minutesSince, now } from "./world.js";
import { temperature } from "./weather.js";

// The rules engine. Deterministic code decides WHEN to call; Claude only runs the call.

export const sched = { userPaused: false, routine: config.routineCalls, budgetTripped: false };

export function decide(w, temp) {
  if (w.hold || w.callId || w.retryPending) return null;
  const sinceCall = minutesSince(w.lastCallAt);
  if (!inShade(w) && minutesSince(w.lastMovedAt) >= config.notMovingMin && sinceCall >= 15) return "not_moving";
  if (minutesSince(w.lastShadeAt) >= config.breakOverdueMin && sinceCall >= 20) return "break_overdue";
  if (w.status === "warning" && sinceCall >= config.warningFollowUpMin) return "routine";
  if (sched.routine && sinceCall >= (temp >= config.highHeatF ? config.routineEveryHighHeatMin : config.routineEveryMin)) return "routine";
  return null;
}

function overBudget() {
  if (callsLastHour() >= config.maxCallsPerHour) return `call cap reached (${config.maxCallsPerHour}/hour)`;
  if (sol.usage.costUsd >= config.maxSpendUsd) return `Claude spend cap reached ($${config.maxSpendUsd})`;
  return null;
}

let lastTick = Date.now();
let lastHour = null;

function tick() {
  const realDt = Date.now() - lastTick;
  lastTick = Date.now();

  // Freeze sim time during a call so a slow conversation doesn't fast-forward the field.
  const frozen = sched.userPaused || (clock.speed > 1 && liveCalls().length > 0);
  if (!frozen) {
    const before = now();
    advance(realDt);
    if (config.simulate) simulate((now() - before) / 60000);
  }

  const hour = new Date(now()).getHours();
  if (hour !== lastHour) {
    lastHour = hour;
    const counts = { ok: 0, warning: 0, emergency: 0, unknown: 0 };
    for (const w of workers) counts[w.status] = (counts[w.status] || 0) + 1;
    log("clock", { time: new Date(now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), tempF: temperature(), ...counts });
  }

  const temp = temperature();
  if (temp < config.heatTriggerF) return;

  const over = overBudget();
  if (over) {
    if (!sched.budgetTripped) systemAlert(`${over}. Automatic check-in calls are paused; open alerts still escalate.`);
    sched.budgetTripped = true;
    return;
  }
  sched.budgetTripped = false;

  for (const w of workers) {
    if (singlePhone() && liveCalls().length) return;
    const reason = decide(w, temp);
    if (!reason) continue;
    log("trigger", {
      worker: w.name, reason, tempF: temp,
      minutesSinceBreak: Math.round(minutesSince(w.lastShadeAt)),
      minutesStationary: Math.round(minutesSince(w.lastMovedAt)),
    });
    place(w, reason);
  }
}

export function startScheduler() {
  // stagger first routine check-ins so the whole crew isn't called at once
  for (const w of workers) w.lastCallAt ??= now() - Math.random() * config.routineEveryMin * 60000;
  setInterval(tick, 1000);
}
