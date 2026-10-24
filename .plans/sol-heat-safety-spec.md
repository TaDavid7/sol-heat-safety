# Sol — Heat-Safety Voice Agent (final spec v1)

**Hackathon track:** No App. Nobody looks at a screen: workers and supervisors use only phone calls, keypresses and SMS.
**Build:** solo, a few hours. Scope is cut to what the demo needs; everything else is listed under "Later".

## 1. Problem
Heat illness kills farmworkers every summer. The early signs (headache, dizziness, confusion, slurred speech) are easy to miss across a large field. Workers skip shade breaks to keep pace. A worker who collapses between rows can go unseen for a long time. Many use basic phones, speak Spanish, and will never open an app. Supervisors are in the field, not watching a dashboard.

## 2. Solution in one paragraph
Sol watches each worker's location data (simulated for the hackathon; clip-on GPS trackers in the real-world pitch) and the live heat index. When a rule fires (no shade for 2 hours, not moving for 10 minutes, or a routine check), Sol **phones the worker**. Claude Opus 5.5 runs the conversation using the user's Sol prompt (`prompts/sol.md`, kept verbatim). It listens to what the worker says and how they say it. Each call ends with `report_status(ok | warning | emergency)`:
- **warning:** the supervisor gets an SMS.
- **emergency:** the supervisor's phone rings until they press 1, and they also get an SMS.

The supervisor closes an alert by texting `OK <name>`.

## 3. Decisions (from the interview)
| Topic | Decision |
|---|---|
| Voice stack | Twilio Voice speech-to-text and text-to-speech (`<Gather input="speech">`, `<Say>` Polly neural voices), plus our Node server calling Claude. Turn-based. |
| Dead air | **Instant filler + parallel think.** When speech arrives, start the Claude request, immediately reply with a short filler ("Okay…" / "Ajá…"), then `<Redirect>` to `/twilio/reply`, which waits for the pending answer. |
| Model | `claude-opus-5-5`, effort `low`, server-side refusal fallback enabled. Overridable with `SOL_MODEL`. |
| Twilio account | Trial. Each outbound call starts with Twilio's trial notice and a keypress (accepted on stage). Only verified numbers can be called. |
| GPS | Simulated field at accelerated time. `/api/gps` accepts real pings (`{worker_id, lat, lng}`) for the trackers in the pitch. |
| Languages | Spanish and English. Each worker has a default language, and Sol switches mid-call if the worker does. The voice and recognizer language follow whatever language Sol last spoke. |
| Missed call | Retry once after `RETRY_AFTER_SEC` (default 120 s; 30 s in demo). A second miss counts as emergency ("no answer"). |
| Who is summoned | **Supervisor only**, by call and SMS. The supervisor script says "If this is life-threatening, call 911 now." Sol never dials 911 itself. |
| Unacknowledged emergency | Re-call and re-text the supervisor every 2 min, up to 3 attempts. After that, Sol logs a loud `STUCK` state and sends one final SMS. |
| Resolution | Supervisor replies by SMS: `OK ANA` (or just `OK` when only one alert is open). This marks the worker safe, clears the hold, and lets Sol resume normal calls. `STATUS` by SMS returns a crew summary. |
| Inbound calls | (a) **Worker calls in**: same Sol flow with `call_reason = worker_called_in`. (b) **Supervisor calls in**: hears a spoken crew summary, then "press 1" to acknowledge any open emergency. |
| Consent | The opening line discloses: "This is Sol, the heat-safety line for {farm}. This call is recorded for safety." Transcripts go to the audit log. |
| Audience view | Projected **terminal log**: a colored live event stream (triggers, transcript, report, escalations). It is labelled a backstage view, not a product UI. |
| Stage phones | Two phones. **Phone A** = every worker (`DEMO_PHONE`). **Phone B** = supervisor (`SUPERVISOR_PHONE`). Both are verified on the trial account. |

## 4. Call triggers (deterministic rules engine, not AI)
Evaluated every real second for each worker; at most one trigger per worker at a time.
1. Temperature below `HEAT_TRIGGER_F` (80): no calls.
2. Worker on hold (open emergency), already in a call, or with a retry pending: skip.
3. `not_moving`: outside shade and stationary for at least 10 minutes, and no call in the last 15 minutes.
4. `break_overdue`: at least 120 minutes since last shade, and no call in the last 20 minutes.
5. Warning follow-up: worker status is warning and 20 minutes have passed since the last call. Sol places a `routine` re-check.
6. `routine`: every 120 minutes (every 60 minutes at 95°F or above). Off by default in simulation, so the demo isn't flooded with calls.

Priority: `not_moving` > `break_overdue` > follow-up > `routine`.
In demo mode only one worker call runs at a time (Phone A is a single phone). Other calls wait for the next tick.

## 5. Call flow (outbound)
1. Engine creates the call and Twilio dials (`Url=/twilio/voice?call=ID`, `StatusCallback=/twilio/status?call=ID`).
2. `/twilio/voice` (answered): build the system prompt from the template variables, send Claude `[The worker picked up the phone.]`, and return `<Gather speech><Say>greeting</Say></Gather>`.
3. `/twilio/gather` (speech or silence): add `[heard, confidence 0.62] "text"` or `[silence]` to the history, start the Claude request in the background, and return `<Say>filler</Say><Redirect>/twilio/reply</Redirect>`.
4. `/twilio/reply`: wait for the result (12 s timeout, then fail-safe). Return either Gather (call continues) or `<Say>closing</Say><Hangup/>` (report done).
5. `/twilio/status`:
   - `no-answer`, `busy` or `failed`: retry or escalate.
   - `completed` without a report: emergency ("call dropped before Sol could confirm they're okay").

**Conversation engine:** a manual tool loop. History is append-only, and the full `response.content` is pushed back each turn. When `report_status` is called, Sol records it, escalates immediately, and returns the tool result: "Recorded. Supervisor alerted (or not). Say one short closing line." After `MAX_WORKER_TURNS` (6), a mid-conversation system message tells Sol to report now. A Claude error or refusal triggers a fail-safe closing line in the worker's language plus a warning ("check on them in person").

**Server-side severity floors** (applied to Claude's report, because a rule beats a guess):
- Two or more silences in the call: emergency.
- `break_overdue` with `took_break=no` but level ok: raised to warning.
- An invalid or missing level: emergency.
- The final level is the more serious of Claude's level and the floor. Both are logged.

## 6. Escalation content
- **Warning SMS:** `SOL WARNING – Ana Ruiz: headache, dizziness. Row 8, ~120 m from Shade tent B <maps link>. Sol told them to rest in shade. Reply OK ANA after you check on them.`
- **Emergency SMS:** `SOL EMERGENCY – José Hernández: no clear answer, slow speech. Row 5 … <maps link>. Call 911 if life-threatening. Reply OK JOSE when safe.`
- **Emergency call to supervisor** (English, repeated twice inside a `<Gather numDigits=1>`): "Sol heat-safety emergency. José Hernández, row 5, about 90 meters from shade tent A. Signs: no clear answer, slow speech. If this is life-threatening, call 911 now. Press 1 if you are going to them."

## 7. Guardrails for running unsupervised
- Calls-per-hour cap (`MAX_CALLS_PER_HOUR`) and Claude spend cap (`MAX_SPEND_USD`). When either is hit, automatic calls pause and a loud log plus SMS goes out. Escalations of existing alerts keep running.
- Ring timeout, turn cap, 12 s Claude timeout, and paging limit, so nothing loops forever.
- Twilio signature validation on every webhook (disabled only when `TWILIO_SKIP_VALIDATION=1` for local tests).
- `GPS_TOKEN` bearer token on `/api/gps`.
- Append-only `data/events.jsonl` audit log.

## 8. Terminal simulator (dev + projected backstage view)
The same process runs the server. Commands:
- `/status`: crew table.
- `/temp 104|auto`, `/speed 30`, `/pause`
- `/stop <name>`, `/skip <name>`, `/normal <name>`: change a simulated worker's behavior.
- `/call <name> [reason]`, `/routine on|off`
- `/sms OK ANA`: simulates a supervisor text.
- `/ack`: simulates the supervisor pressing 1.

When Twilio is not configured, worker calls ring **in the terminal**. Typed lines are the worker's speech, `/silent` sends silence, and `/hangup` drops the call. The whole escalation path runs, with SMS and calls printed instead of sent.
The simulation clock pauses while a call is active.

## 9. Demo script (about 3 min)
1. "Sunrise Farms, Coachella Valley, feels like 104°F." The terminal shows six simulated workers at 30× speed.
2. Ana skips breaks, so a `break_overdue` call rings **Phone A** (trial keypress). Sol speaks Spanish. The presenter says "Me duele un poco la cabeza…". Sol tells Ana to rest in shade, and the result is warning. **Phone B** gets an SMS.
3. `/stop jose`. Ten simulated minutes later Phone A rings as José. The presenter answers slowly and confusedly, then goes silent. The result is emergency. **Phone B rings**: the supervisor script plays, and the presenter presses 1. The terminal shows the acknowledgement.
4. Phone B texts `OK JOSE`. The emergency is resolved.
5. (If there's time) Phone B calls Sol and hears "Six workers. One warning: Ana…".

## 10. Architecture
```
prompts/sol.md      user's prompt, verbatim
src/config.js       env + thresholds
src/events.js       bus + JSONL audit log
src/world.js        sim clock, field, workers, GPS ingest, sim movement
src/weather.js      Open-Meteo heat index (+ override)
src/sol.js          Claude client, runtime prompt appendix, report_status tool, language detect
src/calls.js        call lifecycle, conversation loop, floors, retries
src/escalate.js     alerts, supervisor SMS/calls, paging, STUCK, SMS commands, crew summary
src/scheduler.js    rules engine tick + budgets
src/twilio.js       REST (calls/SMS), TwiML builders, signature check
src/routes.js       /twilio/* and /api/* webhooks
src/terminal.js     REPL simulator + pretty event log
src/server.js       entry
test/               scripted conversation evals (real API) + webhook tests (fake Twilio posts)
```

## 11. Testing
- **Webhook tests:** post fake Twilio form bodies to `/twilio/*` and assert the TwiML shape (Gather, Redirect, Hangup) and state changes. Claude is stubbed.
- **Conversation evals** (real API, about 6 cases, a few cents): fine; headache (warning); break refused (warning); confused speech (emergency); silence twice (emergency); Spanish to English switch. Each asserts the final level.
- agent-browser (from the guide) does not apply: there is no web UI. The terminal simulator plus webhook tests take its place.

## 12. Later (out of scope)
Indigenous-language fallback (keypress yes/no prompts), backup contacts, coworker buddy calls, Twilio ConversationRelay for streaming and barge-in, real tracker integration, persistence and a database, multi-farm support.
