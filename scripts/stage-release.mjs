import fs from 'node:fs';
import path from 'node:path';
import { platforms } from './release-manifest.mjs';
const platform = process.argv[2];
if (!platforms.includes(platform)) throw Error('Unsupported platform');
const host = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
if (host !== platform) throw Error(`Runner architecture mismatch: expected ${platform}, got ${host}`);
const source = 'apps/desktop/src-tauri/target/release/bundle';
fs.mkdirSync('release-assets', { recursive: true });
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(dmg|msi|exe|deb|rpm|AppImage|tar\.gz|sig)$/.test(entry.name)) {
      // Prefix both payload and signature identically; macOS archives otherwise collide.
      fs.copyFileSync(file, path.join('release-assets', `${platform}-${entry.name}`));
    }
  }
}
walk(source);
