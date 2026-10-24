# Sol: the heat-safety line nobody has to look at

**Hackathon track: No App.** Sol phones farmworkers during hot shifts, listens to *what* they say and *how* they say it, and gets a supervisor moving when someone is in trouble. Nobody installs an app or looks at a screen: workers answer a normal phone call, and supervisors get SMS and calls and reply by pressing 1 or texting `OK <name>`.

```
GPS (sim) + heat index ─► rules engine ─► Sol (Claude) ◄─► Twilio ◄─► worker's phone
                                              │ report_status(ok | warning | emergency)
                                              ▼
                                         escalation ─► supervisor: SMS / call until "1" / re-page → STUCK
                                              ▲
                                  "OK JOSE" by SMS · status call-in
```

- **When to call** is deterministic. A worker gets a call when they are `not_moving` (10+ min still, outside shade), `break_overdue` (2+ h without shade) or due a `routine` check-in, and only when the heat index is 80°F or above (live from Open-Meteo).
- **How they are** is Claude Opus 5.5 running the Sol prompt (`prompts/sol.md`, verbatim). It gets the speech recognizer's confidence, so it can weigh slurred or confused speech, and it ends every call with `report_status`.
- **Safety floors** in code can only raise Claude's level, never lower it:
  - two silences in one call → emergency
  - an overdue break that was skipped → warning
  - no answer twice, or a call dropped before Sol could report → emergency
- **Unsupervised guardrails:**
  - Emergencies page the supervisor every 2 min. After 3 tries with no answer, Sol logs **STUCK**.
  - A calls-per-hour cap and a Claude spend cap pause automatic calls.
  - Turn, ring and Claude timeouts stop any call from running forever.
  - Twilio signatures are verified on every webhook, and every event goes to an append-only audit log (`data/events.jsonl`).
- **Dead air is hidden:** while Claude thinks, Sol says "Ajá…" or "Okay…".

Full spec: [.plans/sol-heat-safety-spec.md](.plans/sol-heat-safety-spec.md)
Demo cheat sheet (every command, with real responses): [docs/Sol-Demo-Cheat-Sheet.pdf](docs/Sol-Demo-Cheat-Sheet.pdf). Regenerate it with `pip install reportlab` and `python docs/make-cheatsheet.py`.

## Pre-recorded demo (no phones, just press play)

`demo/audio/` holds ready-to-play phone calls. Sol's words, the alert levels and the supervisor messages are real output from the live system; only the worker's lines are scripted. What's said in each file is in `demo/audio/transcript.md`.

| File | What the audience hears |
|---|---|
| `1-warning-call.wav` | Sol calls Tom about an overdue break. He has a headache, Sol sends him to the shade (WARNING), and the supervisor is texted. |
| `2-emergency-call.wav` | José stopped moving. His answer is confused, Sol tells him help is coming (EMERGENCY), and the supervisor is texted. |
| `3-supervisor-call.wav` | Sol phones the supervisor about José. The supervisor presses 1, and Sol logs that help is on the way. |
| `sol-demo-full.wav` | All three back to back (about 3.5 min). |

Regenerate with `npm run demo:audio`. It needs Windows (for the built-in voices) and `ANTHROPIC_API_KEY`, and costs about $0.07 per run.

## Run it without Twilio (terminal simulator)

```bash
npm install
cp .env.example .env        # set ANTHROPIC_API_KEY
npm start
```

Worker calls ring **in the terminal**:
- **Answer:** press Enter.
- **Speak:** type what the worker says.
- **Stay silent:** `/silent`.
- **Hang up:** `/hangup`.

Escalations print as `📟 SMS →` and `☎ Calling Supervisor` lines. Useful commands:

| Command | Effect |
|---|---|
| `/status` | crew table: minutes since shade, minutes still, location, status |
| `/temp 104` · `/temp auto` | override the heat index · go back to the live value |
| `/speed 30` · `/pause` | sim clock speed (sim seconds per real second) · pause |
| `/skip ana` · `/stop jose` · `/normal jose` | make a worker skip breaks · stop moving · behave normally |
| `/call maria [reason]` | call someone now |
| `/sms OK JOSE` · `/sms STATUS` · `/ack` | act as the supervisor (text back, or press 1) |
| `/routine on` | enable routine check-ins (off by default in sim to keep the demo focused) |

## Run it with real phones (Twilio trial is fine)

1. **Twilio:** buy a number. On a trial account, verify **Phone A** (it plays every worker) and **Phone B** (supervisor) under *Verified Caller IDs*.
2. **Tunnel:** run `winget install Cloudflare.cloudflared`, then `cloudflared tunnel --url http://localhost:3000`, and copy the `https://….trycloudflare.com` URL.
3. **`.env`:** fill in `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `PUBLIC_URL` (the tunnel URL), `DEMO_PHONE` (Phone A) and `SUPERVISOR_PHONE` (Phone B).
4. **Number configuration** (Twilio console → your number):

   | Setting | Value |
   |---|---|
   | Voice → *A call comes in* | `POST {PUBLIC_URL}/twilio/inbound` |
   | Voice → *Call status changes* | `{PUBLIC_URL}/twilio/status` |
   | Messaging → *A message comes in* | `POST {PUBLIC_URL}/twilio/sms` |

5. Run `npm start`. The terminal becomes the projected backstage log, and the simulator commands still work.

Trial accounts play "You have a trial account… press any key" before each outbound call. Press a key, and Sol starts talking.

## Demo script (~3 min)

1. `/temp 104`. "Sunrise Farms, Coachella Valley, feels like 104°F. Six workers, sim at 30×."
2. **Ana** skips breaks, so Sol rings **Phone A** about her overdue break. Answer in Spanish: *"Me duele un poco la cabeza…"*. Sol tells her to rest in the shade, and **Phone B** gets a warning SMS.
3. `/stop jose`. About 20 s later, Phone A rings as José. Answer slowly and confusedly, then stay silent. The result is **emergency**, and **Phone B rings**: "…call 911 if life-threatening. Press 1 if you are going." Press 1.
4. Text `OK JOSE` from Phone B. Sol confirms, and José is back on normal check-ins.
5. Optional: call Sol from Phone B to hear the spoken crew summary.

## Tests

```bash
npm test            # webhook + escalation tests, Claude stubbed (no network)
npm run test:eval   # 7 real conversations against Claude; asserts the final level (needs ANTHROPIC_API_KEY)
```

## Machine endpoints

- **`POST /api/gps`** takes `{ "worker_id": "w1", "lat": 33.68, "lng": -116.17 }` (or an array of them) from real trackers. Set the bearer token with `GPS_TOKEN`.
- **`GET /api/state`** returns a JSON snapshot for debugging. There is deliberately no human UI.

## Not in scope yet

- Indigenous-language fallback (keypress prompts for Mixteco and Triqui speakers)
- Backup contacts and coworker "buddy" calls
- Twilio ConversationRelay for streaming and barge-in
- A real tracker integration
- Persistence
