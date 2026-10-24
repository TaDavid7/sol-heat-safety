# Sol (heat-safety voice agent): notes for Claude Code

- Stack: Node 22 ESM, Express, `@anthropic-ai/sdk`, Twilio over raw REST + TwiML strings. No build step, no web UI (No App track: keep it screenless).
- Run: `npm start` (the terminal simulator when Twilio isn't configured). Test: `npm test` (Claude stubbed); `npm run test:eval` (real API).
- Spec: `.plans/sol-heat-safety-spec.md`. `prompts/sol.md` is the user's prompt, kept verbatim. Runtime additions go in `RUNTIME` in `src/sol.js`.
- Rules decide *when* to call (`src/scheduler.js`). Claude decides *how they are*. Server floors in `applyReport` (`src/calls.js`) can only raise a level.
- Conversation history is append-only: push `resp.content` back unchanged, and never edit earlier turns.
- Every path that ends a call must leave a report (`endCall` / `missed` / `failSafe`). Add a test in `test/webhooks.test.js` when touching these.
- Git: commit after each working sub-task, keep short branches, never force-push main.
