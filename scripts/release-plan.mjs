// Decides what the release workflow does for one run (job `plan` in .github/workflows/release-build.yml).
// push to main, version tag missing  -> build all platforms, then tag github.sha and create a DRAFT release
// push to main, version tag exists   -> skip the build (docs-only or no version bump), succeed
// workflow_dispatch                  -> build artifacts only, no tag, no draft
// anything else (other branch/repo, commit not on main) -> refuse
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionFiles, semver } from './version.mjs';

export const REPOSITORY = 'Libes6/Gustaf';
export const RELEASE_BRANCH = 'main';

export function plan({ event, ref, repository, version, tagExists, onMain }) {
  if (!semver.test(version ?? '')) throw Error(`Invalid source version: ${version}`);
  const tag = `v${version}`;
  if (event === 'workflow_dispatch') return { build: true, release: false, tag: '', version, reason: `Manual run: building ${tag} artifacts only (no tag, no draft release).` };
  if (event !== 'push') throw Error(`Unsupported event: ${event}`);
  if (repository !== REPOSITORY) throw Error(`Releases are only created in ${REPOSITORY}, not ${repository}`);
  if (ref !== `refs/heads/${RELEASE_BRANCH}`) throw Error(`Releases are only created from ${RELEASE_BRANCH}, not ${ref}`);
  if (!onMain) throw Error(`Commit is not on origin/${RELEASE_BRANCH}`);
  if (tagExists) return { build: false, release: false, tag, version, reason: `Tag ${tag} already exists: nothing to release. Bump the version on dev (npm run version:bump) to start a new release.` };
  return { build: true, release: true, tag, version, reason: `New version: building and drafting release ${tag}.` };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const succeeds = (...args) => { try { git(...args); return true; } catch { return false; } };

// Collects the facts from the GitHub Actions environment and the checkout (needs a fetched origin).
export function facts(env = process.env) {
  const { version } = versionFiles();
  const event = env.GITHUB_EVENT_NAME;
  const result = { event, ref: env.GITHUB_REF, repository: env.GITHUB_REPOSITORY, version, tagExists: false, onMain: false };
  if (event !== 'push') return result;
  const sha = env.GITHUB_SHA || git('rev-parse', 'HEAD');
  // ls-remote exits 2 when the tag is absent; any other failure must not look like "absent".
  try { git('ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/v${version}`); result.tagExists = true; }
  catch (e) { if (e.status !== 2) throw e; }
  git('fetch', '--no-tags', 'origin', `+refs/heads/${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}`);
  result.onMain = succeeds('merge-base', '--is-ancestor', sha, `refs/remotes/origin/${RELEASE_BRANCH}`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let decision;
  try { decision = plan(facts()); }
  catch (e) { console.log(`::error title=Release plan::${e.message}`); process.exit(1); }
  console.log(`::notice title=Release plan::${decision.reason}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, ['build', 'release', 'tag', 'version'].map(k => `${k}=${decision[k]}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, decision.reason + '\n');
}
