<!-- Target branch: `dev` (feature branches → dev). Only release PRs go from `dev` to `main`. See docs/branching.md. -->

## Summary

<!-- What changes, in a few sentences. Link the issue if there is one (Fixes #123). -->

## Why

<!-- The problem or motivation. -->

## How tested

<!-- Paste the result of `npm run check` (i18n, tsc, Node tests, UI tests, end-to-end tests, cargo test, protocol package). -->
<!-- Add focused suites you ran (`npm run test:chat -w apps/desktop`, ...), manual steps in `npm run tauri dev`, and the OS you tested on. -->
<!-- Say plainly what was NOT tested (for example "not run in the app", "not checked on Windows/Linux"). -->

- [ ] `npm run check` passes locally
- [ ] Checked in the running app (`npm run tauri dev`), if the change is user-visible

## Screenshots

<!-- Required for UI changes: before / after, light and dark theme if colours changed. Delete for non-UI changes. -->

## Checklist

- [ ] Tests added or updated for the change
- [ ] Docs updated (`README.md`, `docs/features/*.md`, `CHANGELOG.md` under "Unreleased") where behaviour changed
- [ ] New UI strings added to both locales, `en` and `ru` (`node apps/desktop/scripts/check-i18n.mjs`)
- [ ] No secrets, API keys, tokens, personal paths or logs with credentials in the diff, tests or screenshots
- [ ] Target branch is `dev`
