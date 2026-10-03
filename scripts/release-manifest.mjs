import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { semver } from './version.mjs';
export const platforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64'];
export const targets = [...platforms, 'windows-x86_64-msi'];
export function manifest(version, assets, notes = '', date = new Date().toISOString()) {
  if (!semver.test(version) || Number.isNaN(Date.parse(date))) throw Error('Invalid release version/date');
  const result = { version, notes, pub_date: date, platforms: {} };
  const names = new Set();
  for (const platform of targets) {
    const asset = assets[platform];
    const ext = platform.startsWith('darwin') ? '.app.tar.gz' : platform.endsWith('-msi') ? '.msi' : platform.startsWith('windows') ? '.exe' : '.AppImage';
    if (!asset || !asset.name.endsWith(ext) || names.has(asset.name) || !asset.signature?.trim() || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.signature.trim()) || !asset.size) throw Error(`Missing/invalid signed artifact: ${platform}`);
    names.add(asset.name);
    result.platforms[platform] = { signature: asset.signature.trim(), url: `https://github.com/Libes6/Gustaf/releases/download/v${version}/${encodeURIComponent(asset.name)}` };
  }
  return result;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [directory, version, notesFile] = process.argv.slice(2);
  const assets = {};
  for (const platform of targets) {
    const dir = path.join(directory, platform.endsWith('-msi') ? 'windows-x86_64' : platform);
    const candidates = fs.readdirSync(dir).filter(name => name.endsWith(platform.startsWith('darwin') ? '.app.tar.gz' : platform.endsWith('-msi') ? '.msi' : platform.startsWith('windows') ? '.exe' : '.AppImage'));
    if (candidates.length !== 1) throw Error(`Expected one updater artifact: ${platform}`);
    const name = candidates[0];
    assets[platform] = { name, size: fs.statSync(path.join(dir, name)).size, signature: fs.readFileSync(path.join(dir, name + '.sig'), 'utf8') };
  }
  fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify(manifest(version, assets, notesFile ? fs.readFileSync(notesFile, 'utf8') : ''), null, 2) + '\n');
}
