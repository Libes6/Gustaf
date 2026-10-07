# Gustaf (m code): working notes for agents

Desktop coding-agent app (Tauri 2 + React/TypeScript + Rust backend + Node sidecar) with an Expo mobile client. Integration branch is `dev`; `main` holds releases only. Details: `docs/ARCHITECTURE.md`, `docs/branching.md`, `CONTRIBUTING.md`.

## Map

- `apps/desktop/src`: React UI (`components`, `providers`, `agent`, `canvas`, `lib`, `i18n`, `quick-ask`).
- `apps/desktop/src-tauri/src`: Rust backend (DB, tools, computer use, updater, mobile server, PTY).
- `apps/desktop/sidecar`: Node sidecar (Cursor agent, Codex limits). Not a workspace member; own lockfile (`npm --prefix apps/desktop/sidecar ci`).
- `apps/desktop/tests`: Node tests (`*.test.mjs`), UI tests (`tests/ui`, Vitest), e2e (`tests/e2e`).
- `apps/mobile`: Expo app; own `package.json` and lockfile.
- `packages/protocol`: shared types for desktop and mobile (`/v1` API).
- `scripts/`: version, release and DMG tooling; tests in `scripts/tests`.

## Checks (run from the repo root unless noted)

| Changed | Run |
| --- | --- |
| Anything in desktop | `npm run check` (i18n check, `tsc`, node tests, UI tests, e2e, `cargo test`). Run before declaring done |
| TS only, quick loop | `npm run check:quick` (i18n, `tsc`, node and UI tests; no e2e, no cargo). Finish with the full check |
| Rust only | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` |
| `packages/protocol` | `npm run check` (covers desktop and protocol), plus `npm run check` in `apps/mobile` |
| `apps/mobile` | `npm run check` inside `apps/mobile` (typecheck + node tests) |
| `scripts/`, version files, release docs | `npm run test:release`, `npm run version:check` |

E2E tests skip without Google Chrome; say so if they were skipped.

## Definition of done

1. The relevant checks above are green; report failures with their output, never hide them.
2. After the branch is merged into `dev`, the main agent updates the task in `TASKS.md`: `[x]` with a short note, then moves it to `docs/tasks-done.md`. Open work stays in `TASKS.md`. Subagents skip this step.
3. Commit as `type(scope): summary` (`feat`, `fix`, `docs`, `test`, `chore`; scope like `mobile`, `import`, `release`), one logical change per commit.

## Cannot be verified automatically

WKWebView behavior (CSP, canvas in the real window), code signing, notarization, the real updater round trip, native Computer Use, Windows/Linux runtime. Do not mark these `[x]`: leave `[~]` and write concrete manual steps (see `docs/release-checklist.md`, `docs/updater-smoke.md`).

## Working rules

- Work on a branch `gustaf/<topic>` and merge into `dev` via PR; never commit straight to `main`.
- Several sessions may run in parallel in the same checkout. Never revert, reset or `git checkout --` files or directories you did not change; do not stage other people's edits (`git add` specific paths).
- Subagents in a worktree must commit on `gustaf/<topic>` before reporting; uncommitted work is lost. Commit early and often: a WIP commit after every green `check:quick` and at least every ~10 minutes (squash later if needed). If the parent session is interrupted, background agents die without reporting, and only committed work survives.
- `TASKS.md` is gitignored and exists only in the main checkout. Only the main agent edits it, and only after a branch is merged into `dev`; subagents never touch it and instead report status, bugs and manual-check steps in their final message (and in the commit message).
- A reported bug is recorded in `TASKS.md` (by the main agent) unless the request says to fix it.
- Do not push, publish releases or delete worktrees/branches without being asked.
- Version bumps only through `npm run version:bump`; never tag by hand.
- Task files and code comments are in English; the UI has i18n strings in `apps/desktop/src/i18n` (keep both locales in sync, `check-i18n` enforces it).
