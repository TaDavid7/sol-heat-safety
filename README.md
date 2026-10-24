# Sol: the heat-safety line nobody has to look at

*Hackathon track: No App*

## The premise

Heat illness kills farmworkers every summer. The early signs, like headache, dizziness and confusion, are easy to miss in a big field. Workers skip shade breaks to keep pace, and many will never install or open an app.

**Sol is a phone line, not an app.** When it's hot, Sol calls workers to check on them. It listens to what they say and *how* they say it, and it gets the supervisor moving when someone is in trouble. Nobody looks at a screen.

## The flow

```
 1. WATCH     GPS + live heat index  ──►  rules decide WHO to call and WHY
                                            • not moving 10+ min (outside shade)
                                            • no shade break in 2+ hours
                                            • routine check-in (80°F and up)

 2. CALL      Sol phones the worker  ──►  short voice check-in, English or Spanish
                                            "How are you feeling? Any headache, dizziness?"

 3. JUDGE     Claude listens          ──►  report: OK · WARNING · EMERGENCY
                                            (confused or slurred speech, silence = emergency)

 4. ACT       OK         → nothing, check again later
              WARNING    → worker told to rest in shade + supervisor gets a text
              EMERGENCY  → "help is coming" + supervisor's phone rings until they press 1

 5. CLOSE     Supervisor texts "OK JOSE" → alert closed, normal check-ins resume
```

**Safety nets:**
- Code rules can only make Sol's verdict *more* serious, never less. Two silences, or a missed call that is missed again on retry, always count as an emergency.
- If nobody presses 1 after 3 calls, Sol raises a loud **STUCK** alert.
- Spending and call-count caps let it run unsupervised.

## Try it

| Way | How |
|---|---|
| **Listen** (no setup) | Play `demo/audio/sol-demo-full.wav`. It has three real calls with Sol's actual responses; the script is in `demo/audio/transcript.md`. |
| **Play it in the terminal** | `npm install`, put your `ANTHROPIC_API_KEY` in `.env`, then `npm start`. Calls ring in the terminal, and you type the worker's answers. Every command is in [docs/Sol-Demo-Cheat-Sheet.pdf](docs/Sol-Demo-Cheat-Sheet.pdf). |
| **Real phones** | Add Twilio details to `.env` (see `.env.example`). Worker and supervisor calls then go to real phones. |

`npm test` runs the test suite.

## Built with

Claude Opus 5.5 (runs the conversation; prompt in `prompts/sol.md`) · Twilio Voice + SMS · Open-Meteo heat index · Node.js. The full design is in [.plans/sol-heat-safety-spec.md](.plans/sol-heat-safety-spec.md).
