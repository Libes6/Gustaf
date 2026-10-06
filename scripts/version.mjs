import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function nextVersion(current, bump) {
  if (!semver.test(current)) throw Error('Invalid current SemVer');
  const parts = current.split('.').map(Number);
  const i = ['major', 'minor', 'patch'].indexOf(bump);
  if (i >= 0) { parts[i]++; for (let j = i + 1; j < 3; j++) parts[j] = 0; bump = parts.join('.'); }
  if (!semver.test(bump) || bump.split('.').some(n => !Number.isSafeInteger(Number(n)))) throw Error('Use major, minor, patch or stable X.Y.Z');
  const next = bump.split('.').map(Number);
  const diff = next.findIndex((n, j) => n !== parts[j]);
  if (i < 0 && (diff < 0 || next[diff] < parts[diff])) throw Error('Version must increase');
  return bump;
}
export function versionFiles(base = root) {
  const read = p => fs.readFileSync(path.join(base, p), 'utf8');
  const files = ['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json', 'package-lock.json', 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock'];
  const values = files.map(read);
  const cargo = values[4].match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)[1];
  const locked = values[5].match(/\[\[package\]\]\nname = "gustaf"\nversion = "([^"]+)"/)[1];
  const lock = JSON.parse(values[3]);
  const versions = [JSON.parse(values[0]).version, JSON.parse(values[1]).version, JSON.parse(values[2]).version, lock.version, lock.packages[''].version, lock.packages['apps/desktop'].version, cargo, locked];
  if (!semver.test(versions[0]) || versions.some(v => v !== versions[0])) throw Error('Desktop versions are inconsistent: ' + versions.join(', '));
  return { files, values, version: versions[0] };
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const { files, values, version } = versionFiles();
  const arg = process.argv[2];
  if (arg === '--check') {
    if (process.argv[3] && process.argv[3] !== `v${version}`) throw Error('Tag does not match source version');
    console.log(`Version ${version} is consistent`);
  } else {
    const next = nextVersion(version, arg);
    const output = values.map((value, i) => {
      if (i < 4) {
        const json = JSON.parse(value); json.version = next;
        if (i === 3) { json.packages[''].version = next; json.packages['apps/desktop'].version = next; }
        return JSON.stringify(json, null, 2) + '\n';
      }
      return i === 4 ? value.replace(/(\[package\][\s\S]*?\nversion = ")[^"]+/, `$1${next}`) : value.replace(/(\[\[package\]\]\nname = "gustaf"\nversion = ")[^"]+/, `$1${next}`);
    });
    output.forEach((value, i) => fs.writeFileSync(path.join(root, files[i]), value));
    console.log(`${version} → ${next}. Review and commit before tagging v${next}.`);
  }
}
