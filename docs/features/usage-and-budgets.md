# Usage and budgets

Part of the [M Code documentation](../README.md).

## Usage telemetry

Usage tracks provider-reported input, output, cache read/write and reasoning tokens by provider/model from the time tracking is enabled. Cached and reasoning counts are subsets, not extra total tokens. Unknown telemetry is displayed as unavailable; older messages and external app usage are not retroactively estimated. Each provider request with counts is counted once.

Codex subscription windows are fetched with the read-only `account/rateLimits/read` app-server method; Claude rate-limit stream events are retained when available. Snapshot timestamps and reset times are displayed. Other providers link to their usage dashboard without inventing quota percentages. The npm Codex installation was missing its executable; the official CLI bundled in the Codex desktop app was verified with ChatGPT login and live account quota retrieval. On macOS it serves as a fallback when the CLI on PATH fails.

Model vendor marks use bundled Lobe Icons SVGs, with attribution and license in `public/icons`. `npm run test:usage` verifies token normalization and quota parsing.

## Budgets and alerts

Settings, Usage, Budgets sets optional token limits per local calendar day and per chat, plus a warning threshold (default 80%) stored in the app settings under `budgets`. Limits are tokens only: providers here do not report prices, so no cost is estimated or shown. Usage is summed from the provider-reported counts already stored with each chat message (input plus output; cached and reasoning counts are subsets and are not added again), plus the tokens of background subagents (see Subagents). Every request counts, including history sent again, and the daily total starts from zero at local midnight. A non-blocking, dismissible banner warns at the threshold and shows an exceeded state above the limit; it never prevents sending.

Missing telemetry is not treated as zero. A budget with no counted replies shows as unavailable, a total that skips replies without counts is shown as a lower bound ("at least"), and a limit that is already crossed still shows as exceeded. Not counted: messages removed by retry, provider connection checks, imported history and usage in other apps. The same threshold warns when a Codex or Claude account quota window of the selected provider is nearly or fully used; a snapshot whose reset time has passed (or an old one with no reset time) is treated as stale, not as free quota. `tests/budgets.test.mjs` covers the logic.
