import { config } from "./config.js";

// The world model: a sim-able clock, the field, and where each worker is.
// Positions are kept in local meters (x east, y north) from the farm origin;
// real GPS pings are converted on the way in.

export const clock = { t: Date.now(), speed: config.simSpeed, paused: false };
export const now = () => clock.t;
export const minutesSince = (t) => (t == null ? Infinity : Math.max(0, (clock.t - t) / 60000));

export function advance(realMs) {
  if (!clock.paused) clock.t += realMs * clock.speed;
}

export const farm = {
  ...config.farm,
  width: 400,
  height: 260,
  rowSpacing: 20,
  shade: [
    { id: "A", label: "Shade tent A", x: 30, y: 30, r: 15 },
    { id: "B", label: "Shade tent B", x: 370, y: 230, r: 15 },
  ],
};

const M_PER_DEG = 111320;
export function toLatLng(x, y) {
  const lat = farm.lat + y / M_PER_DEG;
  const lng = farm.lng + x / (M_PER_DEG * Math.cos((farm.lat * Math.PI) / 180));
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
}
export function fromLatLng(lat, lng) {
  return {
    x: (lng - farm.lng) * M_PER_DEG * Math.cos((farm.lat * Math.PI) / 180),
    y: (lat - farm.lat) * M_PER_DEG,
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const nearestShade = (w) => farm.shade.reduce((best, s) => (dist(w, s) < dist(w, best) ? s : best));
export const inShade = (w) => farm.shade.some((s) => dist(w, s) <= s.r);

// behavior: normal | skips_breaks | stops_moving   (sim only; real GPS workers have source "gps")
function seed(id, name, language, row, x, minutesSinceBreak, behavior = "normal") {
  const y = row * farm.rowSpacing;
  return {
    id, name, language, phone: "",
    x, y, row, dir: Math.random() < 0.5 ? -1 : 1,
    source: "sim", behavior,
    breakEvery: 80 + Math.random() * 30, // sim workers take a shade break every ~1.5h
    breakUntil: null, goingToShade: false,
    lastShadeAt: clock.t - minutesSinceBreak * 60000,
    lastMovedAt: clock.t, anchor: { x, y },
    status: "unknown", hold: false, callId: null,
    lastCallAt: null, lastCallReason: null, lastReport: null,
  };
}

export const workers = [
  seed("w1", "María López", "Spanish", 3, 120, 40),
  seed("w2", "José Hernández", "Spanish", 5, 220, 25),
  seed("w3", "Ana Ruiz", "Spanish", 8, 300, 105, "skips_breaks"),
  seed("w4", "Luis Ramírez", "Spanish", 10, 80, 60),
  seed("w5", "Tom Nguyen", "English", 6, 330, 15),
  seed("w6", "Rosa Martínez", "Spanish", 11, 180, 70),
];

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function findWorker(q) {
  if (!q) return null;
  const f = fold(q.trim());
  return workers.find((w) => w.id === f || fold(w.name) === f || fold(w.name).split(" ")[0] === f) || null;
}
export const workerByPhone = (phone) => workers.find((w) => w.phone && w.phone === phone) || null;

// Single entry point for a position update, simulated or real.
export function updatePosition(w, x, y) {
  w.x = x;
  w.y = y;
  if (inShade(w)) w.lastShadeAt = clock.t;
  if (dist(w, w.anchor) > 6) {
    w.anchor = { x, y };
    w.lastMovedAt = clock.t;
  }
}

export function ingestGps(w, lat, lng) {
  const { x, y } = fromLatLng(lat, lng);
  w.source = "gps";
  updatePosition(w, x, y);
}

function stepToward(w, tx, ty, meters) {
  const d = Math.hypot(tx - w.x, ty - w.y);
  if (d <= meters) return updatePosition(w, tx, ty);
  updatePosition(w, w.x + ((tx - w.x) / d) * meters, w.y + ((ty - w.y) / d) * meters);
}

// Advance simulated workers by dtMin minutes of sim time.
export function simulate(dtMin) {
  for (const w of workers) {
    if (w.source !== "sim" || w.behavior === "stops_moving") continue;

    if (w.breakUntil) {
      if (clock.t < w.breakUntil) { updatePosition(w, w.x, w.y); continue; }
      w.breakUntil = null;
    }

    const wantsBreak = w.behavior === "normal" && minutesSince(w.lastShadeAt) >= w.breakEvery;
    if (w.goingToShade || wantsBreak) {
      w.goingToShade = true;
      const s = nearestShade(w);
      stepToward(w, s.x, s.y, 60 * dtMin);
      if (inShade(w)) {
        w.goingToShade = false;
        w.breakUntil = clock.t + 10 * 60000;
      }
      continue;
    }

    const rowY = w.row * farm.rowSpacing;
    if (Math.abs(w.y - rowY) > 1) { stepToward(w, w.x, rowY, 60 * dtMin); continue; }

    // picking along the row
    // turn around at the row ends, keeping the full distance walked (clamping would read as "not moving")
    let x = w.x + w.dir * 4 * dtMin;
    const lo = 15, hi = farm.width - 15;
    if (x < lo) { x = lo + (lo - x); w.dir = 1; }
    if (x > hi) { x = hi - (x - hi); w.dir = -1; }
    updatePosition(w, x, rowY);
  }
}

export function describeLocation(w) {
  if (inShade(w)) return `in ${nearestShade(w).label}`;
  const s = nearestShade(w);
  return `row ${Math.round(w.y / farm.rowSpacing)}, about ${Math.round(dist(w, s))} m from ${s.label}`;
}

export function mapsLink(w) {
  const { lat, lng } = toLatLng(w.x, w.y);
  return `https://maps.google.com/?q=${lat},${lng}`;
}

export function nearestCoworker(w) {
  let best = null;
  for (const o of workers) {
    if (o === w || o.hold || o.callId) continue;
    const d = dist(w, o);
    if (!best || d < best.d) best = { worker: o, d: Math.round(d) };
  }
  return best;
}

export function snapshot(w) {
  return {
    id: w.id, name: w.name, language: w.language, status: w.status, hold: w.hold,
    location: describeLocation(w), ...toLatLng(w.x, w.y), inShade: inShade(w),
    minutesSinceBreak: Math.round(minutesSince(w.lastShadeAt)),
    minutesStationary: Math.round(minutesSince(w.lastMovedAt)),
    behavior: w.source === "sim" ? w.behavior : "gps",
    onCall: !!w.callId, lastReport: w.lastReport,
  };
}
