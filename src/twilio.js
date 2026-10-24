import crypto from "node:crypto";
import { config } from "./config.js";

// Thin Twilio client over REST + TwiML strings (no SDK needed).
const { sid, token, from } = config.twilio;
export const enabled = Boolean(sid && token && from && config.publicUrl);

async function api(resource, params) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${resource}.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Twilio ${resource} ${res.status}: ${body.message}`);
  return body;
}

export const url = (path) => `${config.publicUrl}${path}`;

// Pass either { url } (a webhook that returns TwiML) or { twiml } (inline script).
export function placeCall(to, { url: webhook, twiml, statusPath }) {
  const params = { To: to, From: from, Timeout: String(config.ringTimeoutSec) };
  if (webhook) params.Url = webhook;
  if (twiml) params.Twiml = twiml;
  if (statusPath) {
    params.StatusCallback = url(statusPath);
    params.StatusCallbackEvent = "completed"; // final status: completed | busy | no-answer | failed | canceled
  }
  return api("Calls", params);
}

export const sendSms = (to, body) => api("Messages", { To: to, From: from, Body: body });

// ---- TwiML ----
const VOICES = {
  en: { voice: "Polly.Joanna-Neural", say: "en-US", hear: "en-US" },
  es: { voice: "Polly.Lupe-Neural", say: "es-US", hear: "es-US" },
};
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

export function say(text, lang = "en") {
  const v = VOICES[lang] || VOICES.en;
  return `<Say voice="${v.voice}" language="${v.say}">${esc(text)}</Say>`;
}

// Speak, then listen. actionOnEmptyResult makes silence post back too.
export function sayAndListen(text, lang, actionPath) {
  const v = VOICES[lang] || VOICES.en;
  return `<Response><Gather input="speech" language="${v.hear}" speechTimeout="auto" timeout="7" actionOnEmptyResult="true" method="POST" action="${esc(url(actionPath))}">${say(text, lang)}</Gather></Response>`;
}

export const sayAndHangUp = (text, lang) => `<Response>${say(text, lang)}<Hangup/></Response>`;

// Speak, then wait for a keypress (used for supervisor acknowledgements).
export function sayAndAskDigit(text, actionPath, lang = "en") {
  return `<Response><Gather input="dtmf" numDigits="1" timeout="10" method="POST" action="${esc(url(actionPath))}">${say(text, lang)}${say(text, lang)}</Gather></Response>`;
}

// https://www.twilio.com/docs/usage/security#validating-requests
export function validSignature(req) {
  if (!token) return false;
  const expected = req.get("X-Twilio-Signature") || "";
  const params = req.body || {};
  const data = url(req.originalUrl) + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const actual = crypto.createHmac("sha1", token).update(data).digest("base64");
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
