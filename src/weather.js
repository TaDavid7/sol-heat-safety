import { config } from "./config.js";
import { log } from "./events.js";

// Live "feels like" temperature from Open-Meteo (free, no key). Heat index matters
// more than air temperature for heat illness, so apparent_temperature is used.
const state = { live: null, override: null, fetchedAt: 0 };
const FALLBACK_F = 98;

export async function refresh() {
  const { lat, lng } = config.farm;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,apparent_temperature&temperature_unit=fahrenheit`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const c = data.current;
    state.live = Math.round(Math.max(c.apparent_temperature, c.temperature_2m));
    state.fetchedAt = Date.now();
  } catch (err) {
    log("weather_error", { error: String(err) });
  }
}

export function startWeather() {
  refresh();
  setInterval(refresh, 10 * 60 * 1000).unref();
}

export const temperature = () => state.override ?? state.live ?? FALLBACK_F;
export const temperatureSource = () => (state.override != null ? "override" : state.live != null ? "live" : "fallback");
export function setOverride(f) {
  state.override = f;
}
