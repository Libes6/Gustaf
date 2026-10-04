# Branching and release flow

Two long-lived branches:

- `dev`: integration branch and the GitHub default branch. All feature and agent branches merge here.
- `main`: release branch. It only moves when a release (or hotfix) is merged, and every push to it can start a release build.

## Feature work

1. Branch from `dev` (`git switch -c my-feature dev`).
2. Open a PR into `dev`. CI (`.github/workflows/ci.yml`) runs the desktop matrix (macOS, Windows, Linux) and the mobile checks.
3. Merge once CI is green. The push to `dev` runs CI again on the merged head.

## Release

1. On `dev` (via a normal PR), bump the desktop version: `npm run version:bump -- patch` (or `minor`, `major`, `X.Y.Z`). This updates every desktop version file consistently; `npm run version:check` verifies them. Do not create a tag by hand.
2. Open a PR from `dev` into `main`. CI runs on it.
3. Merge. The push to `main` starts `.github/workflows/release-build.yml`:
   - job `plan` (`scripts/release-plan.mjs`) reads the version from the desktop version files (`tauri.conf.json` and friends) and checks whether tag `vX.Y.Z` exists on origin;
   - tag missing: all four platform bundles are built; only if every one succeeds, job `draft` creates tag `vX.Y.Z` on the merged commit and a **draft** GitHub Release `vX.Y.Z` (target `main`) with installers, signatures and `latest.json`;
   - tag already exists (a docs-only change on `main`, or a merge without a bump): the build is skipped with a `::notice::` and the run succeeds. Nothing is tagged or released.
4. Review the draft (artifacts, notes, the manifest's `notes`) and **publish it manually** in the GitHub UI. The workflow never publishes and refuses to touch a release that is already public.

If the build fails after the tag was created (e.g. the upload step), use "Re-run failed jobs" on that run: the draft job accepts an existing tag only when it points at the same commit, and preserves an existing draft's notes. A new push to `main` will not retry it, because the tag now exists.

Manual runs (`workflow_dispatch`, any branch, optional `signed_macos` input) build artifacts only: no tag, no draft.

The `plan` job refuses (the run fails) for anything other than a push to `main` in `Libes6/Gustaf` whose commit is on `origin/main`.

## Hotfix

1. Branch from `main` (`git switch -c hotfix/x main`), fix, and bump the patch version (`npm run version:bump -- patch`).
2. PR into `main`; merge produces the draft release as above.
3. Merge `main` back into `dev` (PR `main` → `dev`) so the fix and the version bump are not lost. Resolve version conflicts in favour of the higher version.

## Keeping CI cheap

- **Superseded runs are cancelled.** CI uses `concurrency: ci-<workflow>-<PR number or ref>` with `cancel-in-progress: true`. A new push to the same branch, or new commits on the same PR, cancels the older in-progress run. Merging ten PRs into `dev` in a row therefore fully checks only the latest `dev` head. Those older runs show as **cancelled** in the Actions tab: that is expected, not a failure.
- **Docs-only changes skip CI.** Pushes and PRs touching only `**/*.md`, `docs/**`, `TASKS.md`, `.github/ISSUE_TEMPLATE/**` or `.github/pull_request_template.md` do not start CI. Any other changed file (code, lockfiles, workflows) runs it.
  Caveat with required checks: if branch protection requires the CI checks, a docs-only PR has no CI run and its required checks stay "Expected/Waiting". Either merge such PRs as an admin, include a non-doc change, or add a tiny always-running workflow with the same job names that succeeds for docs-only changes.
- **Releases are never cancelled.** `release-build.yml` uses one concurrency group per ref without `cancel-in-progress`, so a running release always finishes. Note that GitHub keeps at most one *pending* run per group: if three pushes to `main` arrive while a release is running, the middle queued one is replaced by the newest.
- **Next step for batching:** GitHub's merge queue would test several queued PRs together before they land on `dev`. It requires the `merge_group` trigger in `ci.yml` and may not be available for repositories owned by a personal account (it is a feature of organization-owned repositories on some plans); check the branch-protection/ruleset settings before relying on it.

## Local build matches CI

`tauri.conf.json` `beforeBuildCommand` is `npm run build:release` (in `apps/desktop`): it reinstalls `sidecar/node_modules` from `sidecar/package-lock.json` with `npm ci` (`apps/desktop/scripts/install-sidecar.mjs`) and then runs `npm run build`. A local `npm run tauri build` therefore bundles the same sidecar dependencies as CI instead of whatever happens to be in the local `node_modules`. If `sidecar/node_modules` is a symlink (the isolated snapshot of `scripts/updater-smoke.py` links the real checkout), the reinstall is skipped so the linked checkout is not modified. `beforeDevCommand` stays `npm run dev` (no reinstall). CI installs the sidecar once before its tests and again during `tauri build`; the second install comes from the npm cache.

## Branch protection (apply by hand in GitHub settings)

Not configured by any workflow; set these in Settings → Branches (or Rules → Rulesets):

- `dev`: require a pull request before merging; require status checks to pass (`check (macos-latest)`, `check (windows-latest)`, `check (ubuntu-latest)`, `mobile (typecheck + tests)`); block force pushes; do not allow deletion.
- `main`: require a pull request before merging (from `dev` or a `hotfix/*` branch); require the same status checks; block force pushes and direct pushes (no bypass list, or only the owner for emergencies); do not allow deletion.
- Tags: if a tag ruleset protects `v*`, allow `github-actions[bot]` to create tags, otherwise the draft job cannot push `vX.Y.Z`.

## What has been verified

Verified locally (macOS):

- `npm run test:release` passes, including `scripts/tests/release-plan.test.mjs`: new version → build and draft; tag exists → skip and succeed; manual run → artifacts only; other branch, tag ref, fork, commit not on `main`, other events and invalid versions → refused. The CLI is exercised against a throwaway git repository with a bare `origin` (tag absent/present, commit on/off `main`, `GITHUB_OUTPUT` contents).
- Both workflow files parse as YAML.
- From a clean worktree, `npm ci` and `npm run tauri build -- --debug --bundles app` ran the new `beforeBuildCommand` (sidecar `npm ci`, then the frontend build) and produced `apps/desktop/src-tauri/target/debug/bundle/macos/Gustaf.app` (arm64, ad-hoc signed, hardened runtime; `codesign --verify --deep --strict` passes; bundles `sidecar/node_modules`). The app was not launched.
- When `sidecar/node_modules` is a symlink, `install-sidecar.mjs` skips the reinstall and leaves the link target untouched.

Not run on GitHub yet (verify on the first real use):

- The new triggers themselves (push to `dev`/`main`, `paths-ignore`, CI concurrency cancellation).
- The `plan` job on a hosted runner, gating of `bundle`/`draft` by its outputs, and a skipped run reporting success.
- Tag creation by `github-actions[bot]` and `gh release create --verify-tag --target main` producing the draft.
- `actionlint` was not available locally, so the workflows have not been linted beyond YAML parsing.
