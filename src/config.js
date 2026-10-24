// All tunables in one place. Values come from .env (see .env.example).
const env = process.env;
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));

const simulate = bool(env.SIMULATE, true);

export const config = {
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || "").replace(/\/$/, ""),

  farm: {
    name: env.FARM_NAME || "Sunrise Farms",
    lat: num(env.FARM_LAT, 33.6803), // Coachella Valley, CA
    lng: num(env.FARM_LNG, -116.1739),
  },

  // GPS simulation (turn off when real trackers post to /api/gps)
  simulate,
  simSpeed: num(env.SIM_SPEED, simulate ? 30 : 1), // sim seconds per real second

  // Call policy. Thresholds follow the prompt (2h break rule) and Cal/OSHA heat triggers.
  heatTriggerF: num(env.HEAT_TRIGGER_F, 80), // no calls below this
  highHeatF: num(env.HIGH_HEAT_F, 95), // routine check-ins get more frequent above this
  breakOverdueMin: num(env.BREAK_OVERDUE_MIN, 120),
  notMovingMin: num(env.NOT_MOVING_MIN, 10),
  routineCalls: bool(env.ROUTINE_CALLS, !simulate),
  routineEveryMin: num(env.ROUTINE_EVERY_MIN, 120),
  routineEveryHighHeatMin: num(env.ROUTINE_EVERY_HIGH_HEAT_MIN, 60),
  warningFollowUpMin: num(env.WARNING_FOLLOW_UP_MIN, 20),

  // Guardrails so Sol can run unsupervised
  maxCallsPerHour: num(env.MAX_CALLS_PER_HOUR, 40),
  maxSpendUsd: num(env.MAX_SPEND_USD, 20),
  maxWorkerTurns: num(env.MAX_WORKER_TURNS, 6),
  ringTimeoutSec: num(env.RING_TIMEOUT_SEC, 45),
  retryAfterSec: num(env.RETRY_AFTER_SEC, simulate ? 30 : 120),
  claudeTimeoutMs: num(env.CLAUDE_TIMEOUT_MS, 12000),
  ackTimeoutSec: num(env.ACK_TIMEOUT_SEC, 120),
  maxPages: num(env.MAX_PAGES, 3),

  model: env.SOL_MODEL || "claude-opus-5-5",

  twilio: {
    sid: env.TWILIO_ACCOUNT_SID || "",
    token: env.TWILIO_AUTH_TOKEN || "",
    from: env.TWILIO_FROM || "",
    skipValidation: bool(env.TWILIO_SKIP_VALIDATION, false),
  },
  supervisorPhone: env.SUPERVISOR_PHONE || "",
  supervisorName: env.SUPERVISOR_NAME || "Supervisor",
  supervisorLanguage: env.SUPERVISOR_LANGUAGE === "es" ? "es" : "en",
  demoPhone: env.DEMO_PHONE || "", // routes every worker call to one phone for demos
  demoWorkerId: env.DEMO_WORKER_ID || "", // who an inbound call from DEMO_PHONE is (default: last worker called)
  gpsToken: env.GPS_TOKEN || "",
};
