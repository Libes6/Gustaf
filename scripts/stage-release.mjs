import fs from 'node:fs';
import path from 'node:path';
import { platforms } from './release-manifest.mjs';
import { releaseAssetName } from './release-asset-name.mjs';
const platform = process.argv[2];
if (!platforms.includes(platform)) throw Error('Unsupported platform');
const host = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
if (host !== platform) throw Error(`Runner architecture mismatch: expected ${platform}, got ${host}`);
const source = 'apps/desktop/src-tauri/target/release/bundle';
const { version } = JSON.parse(fs.readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
fs.mkdirSync('release-assets', { recursive: true });
const staged = new Set();
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else {
      const name = releaseAssetName(platform, version, entry.name);
      if (name === null) continue;
      // Rename payload and signature together; bytes and signatures stay unchanged.
      if (staged.has(name)) throw Error(`Duplicate release asset: ${name}`);
      staged.add(name);
      fs.copyFileSync(file, path.join('release-assets', name));
    }
  }
}
walk(source);
