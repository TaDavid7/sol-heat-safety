import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { config } from "./config.js";

// Sol's brain: the user-authored prompt in prompts/sol.md, plus a short runtime
// appendix explaining how speech arrives over the phone line.
let client = new Anthropic();
export const setClient = (c) => (client = c); // tests inject a fake
const TEMPLATE = fs.readFileSync(new URL("../prompts/sol.md", import.meta.url), "utf8");

const RUNTIME = `
CALL DETAILS
- Worker name: {{worker_name}}
- This is a live phone call. Your words are read aloud by text-to-speech: plain sentences only, no lists, symbols, emoji or stage directions.
- In your first line, after greeting them by name, say: "This is Sol, the heat-safety line for {{farm_name}}. This call is recorded for safety." (in their language).
- Each worker turn arrives as [heard ...] "transcript". "confidence" is the speech recognizer's confidence (0 to 1). Low confidence, fragments, repeated or jumbled words can mean slurred or confused speech; weigh that when judging HOW they speak.
- [silence] means they said nothing when it was their turn to talk.
- If call_reason is worker_called_in, the worker called you. Ask how they are and what is happening.
- After report_status, say one short closing line. The call then ends.
`;

export const REPORT_TOOL = {
  name: "report_status",
  description:
    "Record how the worker is doing. Call it once per call, before your closing line. The level decides who is alerted: warning texts the supervisor; emergency calls the supervisor repeatedly until they confirm they are coming.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["worker_id", "level", "symptoms", "took_break"],
    properties: {
      worker_id: { type: "string" },
      level: { type: "string", enum: ["ok", "warning", "emergency"] },
      symptoms: { type: "string", description: "Symptoms or warning signs noticed, in English, comma-separated. 'none' if none." },
      took_break: { type: "string", enum: ["yes", "no"], description: "Whether they are taking (or agreed to take) a shade break." },
    },
  },
};

export function buildSystem(vars) {
  return (TEMPLATE + RUNTIME).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Running spend, so the scheduler can stop itself before overspending.
// Approximate: priced at Claude Opus 5.5 rates ($4 / $20 per million tokens).
export const usage = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

export async function ask(system, messages, timeoutMs = config.claudeTimeoutMs) {
  const resp = await client.beta.messages.create({
    model: config.model,
    max_tokens: 4000,
    // low effort keeps the gap between turns short on a phone line
    output_config: { effort: "low" },
    // if a safety classifier declines, retry on a fallback model instead of going silent
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    tools: [REPORT_TOOL],
    messages,
  }, { timeout: timeoutMs, maxRetries: 0 }); // a phone line can't wait on retries
  const u = resp.usage;
  usage.requests++;
  usage.inputTokens += u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  usage.outputTokens += u.output_tokens;
  usage.costUsd = (usage.inputTokens * 4 + usage.outputTokens * 20) / 1e6;
  return resp;
}

// Which language Sol just spoke, so TTS voice and speech recognition can follow a switch.
// Unicode-aware word boundaries: plain \b fails after accented letters ("está").
const ES = /[¿¡ñ]|(?<!\p{L})(usted|agua|sombra|cómo|siente|por favor|gracias|hola|descanso|está|bien|ayuda|adiós|cuídese)(?!\p{L})/giu;
const EN = /(?<!\p{L})(you|the|water|shade|how|feel|please|thanks|hello|break|okay|help|goodbye)(?!\p{L})/giu;
export function detectLang(text, fallback) {
  const es = (text.match(ES) || []).length, en = (text.match(EN) || []).length;
  return es > en ? "es" : en > es ? "en" : fallback;
}
