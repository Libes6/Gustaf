# Provider layer review (2026-10)

Scope: `src/providers/*` (except the subagent modules under separate review: `codexRollout.ts`, `cliSubagentCore.ts`, …),
`src/lib/keys.ts`, `src-tauri/src/secrets.rs`, provider calls in `useChatRun.ts`, `lib/modelRouting.ts`, quick ask,
automatic review / memory suggestions. Paths are relative to `apps/desktop`. Line numbers refer to the code before the fixes.

Legend: **BUG (fixed)** confirmed and fixed with a test; **RISK** real but not fixed (proposed task); **FINE** checked, no action.

## Keys and Keychain

| # | Status | Where | Finding |
|---|--------|-------|---------|
| K1 | BUG (fixed) | `src/lib/keys.ts:67-71` | A denied/failed Keychain read reached the chat as the bare OS string (e.g. "User canceled the operation."), with no hint which key or what to do. Now: "Could not read the API key of OpenRouter from the Keychain: … Allow access when the system asks, or enter the key again in Settings." Test: `LazyKeys` "a denied Keychain read…". |
| K2 | FINE | `keys.ts:33-44`, `secrets.rs:64-73` | A denied read is not cached (JS deletes the promise, Rust caches only `Some`), and no "absent" presence flag is written (only after a successful read). Retried on the next use. Covered by the same test and `secrets.rs` tests. |
| K3 | BUG (fixed) | `quick-ask/QuickAsk.tsx`, `providers/index.ts:63-73` | The quick-ask window is a separate webview with its own adapter and key caches. A key (or base URL) changed in the main window was never seen there: quick ask kept sending the old key (401) or a remembered "no key" until the app restarted. Now `getAdapter` rebuilds an adapter whose config differs from the one it was built with, and quick ask drops its JS key cache on every show (Rust still serves the value from memory, no new prompt). Test: `LazyKeys` "an adapter is rebuilt…". |
| K4 | FINE | `index.ts:25-35` | Saving a key in the main window drops the cached adapter and stores the new value in the cache without a Keychain read (existing test). |
| K5 | RISK | `secrets.rs:94-112` | `secret_get` is a synchronous Tauri command, so it runs on the main thread: while macOS shows the Keychain prompt the whole UI is frozen and every other sync command waits. Making it `#[tauri::command(async)]` would fix the freeze but allows two parallel reads of the same id (two prompts) unless the cache gets a per-id in-flight guard. Proposed task: async command + per-id once-lock. |
| K6 | RISK (low) | `secrets.rs:64-73` | `Cache::get` releases the lock during the backend read; a `secret_set` that lands during a slow (prompting) read is overwritten by the stale value read afterwards. Only reachable from Rust `read()` callers on other threads today (JS calls are serialized on the main thread, see K5). Fix with a generation counter if K5 is done. |
| K7 | RISK (low) | `secrets.rs:18` | A Keychain item that is not valid UTF-8 is reported as "missing" (`.ok()`), so the UI says "no key" rather than "unreadable". |
| K8 | FINE | `index.ts:98-103`, `keys.ts:66-71` | Startup reads no key: cached lists only, keyless providers (CLI without key auth, local servers flagged keyless) still list. Existing tests. |

## Model lists (`providers/index.ts`)

| # | Status | Where | Finding |
|---|--------|-------|---------|
| M1 | BUG (fixed) | `index.ts:108-116`, `135-145` | `listAllModels` awaits every provider; one unreachable endpoint (TCP connect can hang 75 s+, `listModels` takes no signal) held back the refreshed lists of all providers. Each listing now times out after 30 s and is reported as that provider's error. Test: `LazyKeys` "a provider that never answers…". Note: a Keychain prompt left open longer than that also reports a timeout; the read still completes and the next refresh works. |
| M2 | BUG (fixed) | `index.ts:25-35`, `126-133` | After a failed listing (wrong key), fixing the key left the error and the 10-minute "failed attempt" throttle in place, and a listing still in flight with the old key was reused by the forced refetch. `saveProvider` now forgets errors/throttle/in-flight when the key or base URL changes. Test: `LazyKeys` "saving a new key lets the picker refetch…". |
| M3 | FINE | `index.ts:122-179` | Disabled/removed providers are filtered before both fetching and reading the cache; `deleteProvider` drops the cache entry. One provider failing records an error only for itself (Promise.all with per-provider try/catch). |
| M4 | FINE | first launch | No cache: keyed providers list nothing until the picker opens (by design, existing test). A persisted selection still sends: `ChatView` passes `selectedModel` undefined, and `supportsTools: undefined` means tools on (`agent.ts:319`). |
| M5 | RISK (low) | `index.ts:92-96` | The main and quick-ask windows each serialize their own `modelCache` read-modify-write; concurrent writes from both can drop one window's update (it is refetched next time). |
| M6 | RISK (low) | `index.ts:153` | A failing `models_seen` select rejects the whole `listAllModels` (all providers, including the quick-ask config, which then shows "no usable model"). |

## Streaming parsers and retries

| # | Status | Where | Finding |
|---|--------|-------|---------|
| S1 | BUG (fixed) | `providers/sse.ts:23` | CRLF was normalised per chunk, so a `\r\n` pair split between two network chunks left a lone `\r`; the blank-line separator was then missed, two events merged into one block and both were dropped as invalid JSON (lost text deltas / usage / tool-call pieces on CRLF servers and proxies). Test: `retry.test.mjs` "a CRLF pair split between two chunks…". |
| S2 | BUG (fixed) | `providers/anthropic.ts:117-137` | A stream that ended cleanly without `message_stop` (proxy/connection closed mid-reply) passed for a complete answer; a tool_use block cut mid-JSON then ran with `{}` / partial input. Now a retryable network error (retried before any output, surfaced after). Test: `providerRetry.test.mjs` "anthropic: a stream that ends without message_stop…". |
| S3 | RISK | `providers/openaiCompatible.ts:70-99` | Same truncation for Chat Completions: no check for `finish_reason`/`[DONE]`; a tool call whose arguments were cut is parsed to `{}` and executed. Not fixed because some OpenAI-compatible servers omit `finish_reason`; proposed: fail when a tool call's arguments do not parse, or when neither `finish_reason` nor `[DONE]` was seen (needs `sse` to expose `[DONE]`). |
| S4 | FINE | `openaiResponses.ts:96-107` | Requires `response.completed`/`incomplete`; `response.failed` and `error` events are classified. |
| S5 | FINE | `retry.ts:259-287` | Retries only classified transient errors and only before any text reached `onText`; abort cancels the sleep. Keychain errors are not `ProviderError`s, so they are never retried (correct). |
| S6 | FINE | `usage.ts` | Missing usage stays `undefined`; Anthropic input adds cache read/write; OpenAI cached tokens are a subset. |
| S7 | RISK (low) | all adapters | Key resolution does not honour the AbortSignal (a pending Keychain prompt cannot be cancelled by Stop); the request itself does. |

## CLI and Cursor adapters

| # | Status | Where | Finding |
|---|--------|-------|---------|
| C1 | BUG (fixed) | `providers/cursor.ts:16-19` | The Cursor SDK sidecar reports its own errors as an event and exits 0; when Node itself failed (old Node, crash, module errors other than "Cannot find package") the exit code was ignored: the chat got an empty answer and `listModels` returned `[]`, which overwrote the cached model list. Now an error with the stderr tail (`sidecarFailure` in `cliArgs.ts`). Test: `cliArgs.test.mjs` "sidecarFailure…". |
| C2 | BUG (fixed) | `providers/cli.ts:30-37` | `codexExecutable()` memoised a rejected probe for the whole session: after installing/fixing Codex it stayed "unavailable" until restart. Rejections are no longer cached. (No unit test: needs the Tauri shell; one-line change.) |
| C3 | FINE | `cli.ts:60-98`, `262-266` | Non-zero exit surfaces the stderr tail (+ login hint for auth errors); abort kills the child (and the tree when asked) and throws AbortError. |
| C4 | FINE | `shell.ts:92-114` | Arguments are single-quoted (POSIX) / `psq(winArg())` (PowerShell); the prompt is the last argument, piped as base64 on stdin for Windows `.cmd` shims; spaces, quotes and newlines are safe (tests in `shell.test.mjs`). A prompt can never start with `-`: CLI prompts are always prefixed with the system text (`resumePoint`). Image paths go via `--image=`/`--add-dir=` single tokens. |
| C5 | FINE | `cursorAccounts.ts:9-17` | Only `cursor-agent` providers with key auth get `CURSOR_API_KEY`; other CLIs get no app keys (they inherit the app's environment, which holds none). |
| C6 | FINE | `cursorAccounts.ts:117-134`, `useChatRun.ts:306-318` | Pool rotation: all accounts exhausted gives the "all exhausted until …" message; a switched account with an unknown list keeps the model. |
| C7 | RISK (low) | `cursor.ts:52-68` | On Stop the Cursor SDK turn returns the partial answer instead of throwing AbortError like the CLI adapter (callers check the signal, so no wrong state was found). |

## Routing, quick ask, background features

| # | Status | Where | Finding |
|---|--------|-------|---------|
| R1 | BUG (fixed) | `lib/useAutoMemorySuggest.ts:39`, `lib/memorySuggestRun.ts:27-31` | The opt-in automatic memory suggestion ran on the chat's provider when no API cheap model was set; with a CLI provider every finished run silently started a whole CLI agent turn in the project (quota, time). Now skipped for CLI/Cursor targets like the automatic review (`useDiffReview.ts:81`); the manual action still works. Test: `Memory.test.tsx` "automatic memory suggestions…". |
| R2 | FINE | `modelRouting.ts:66-82` | `cheapTarget`/`reviewTarget` fall back to the chat's model when the configured one is missing or its provider disabled. A CLI cheap model is only used when the user picked it explicitly, and those calls pass `access: "readonly"`. |
| R3 | FINE | `quickAsk.ts:183-192` | Quick ask never offers CLI/Cursor providers (falls back with a note). Its startup listing reads no key ("startup" mode). |

## Still needs a real-provider run

- Anthropic through a proxy that closes early (S2) and a CRLF-emitting endpoint (S1): behaviour verified only against fakes.
- Keychain denial on macOS (K1): message and retry verified with a fake `secret_get`; the real OS error text varies.
- Cursor SDK sidecar with an old Node (C1) and Codex installed after a failed probe (C2).
- Quick ask after changing a key in Settings while the quick-ask window exists (K3).
