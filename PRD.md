# Sol — PRD

Finalized after the interview. The full spec lives in [.plans/sol-heat-safety-spec.md](.plans/sol-heat-safety-spec.md).

**One line:** a screenless heat-safety voice agent. GPS and heat rules decide when to phone a farmworker. Claude (running the Sol prompt in `prompts/sol.md`) checks how they're doing by voice. Warnings text the supervisor. Emergencies ring the supervisor's phone until they press 1. The supervisor resolves an alert by texting `OK <name>`.
