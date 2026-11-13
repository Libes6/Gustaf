# AI usage reporting

The admin app's AI usage page shows which providers and models each Gustaf user runs, and how much.
The numbers come from the users' own computers, not from clients or the relay.

- **Counted on the host.** `apps/server/src/telemetry/AiUsageReporter.ts` hooks the per-turn
  analytics callback, which fires once per terminal provider turn no matter how many clients watch
  or which route (local, tunnel, relay) drove it. Native subagent turns are left out; the main
  turn stands for the request. Phones never report, and the relay cannot read traffic anyway.
- **Only counts leave the machine.** A report is a list of per UTC day, provider (driver kind) and
  model totals: turns, measured turns, input and output tokens. Model names go out only when
  `catalogModelLabel` vouches for them, otherwise `null`. The cloud re-validates the same shape.
- **Unknown is not zero.** Token sums cover only `measuredTurns`, the turns whose provider reported
  both counts. With none measured the admin app shows the tokens as unknown.
- **Counted once.** A batch keeps its id until the cloud answers 2xx or refuses it (400/401/403/413).
  The cloud records `(device_id, batch_id)` in `ai_usage_report` in the same transaction that adds
  the totals, so a retried batch whose answer was lost changes nothing. Ids are kept 30 days.
- **No backfill.** Only turns that finish while the computer holds a device credential and
  telemetry is allowed are counted. Unsent counts live in memory: they are flushed every five
  minutes and on shutdown, dropped on a credential change or opt-out, and lost if the process dies
  first. Undercounting is preferred to double counting.
- **Same opt-out as product events.** `T3CODE_TELEMETRY_ENABLED=false` or the managed policy's
  telemetry switch stops counting and sending (`telemetryConsent` in `AnalyticsService.ts`).
