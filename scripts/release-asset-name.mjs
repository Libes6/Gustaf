import { platforms } from './release-manifest.mjs';
import { semver } from './version.mjs';

const labels = {
  'darwin-aarch64': 'macOS-arm64',
  'darwin-x86_64': 'macOS-x64',
  'windows-x86_64': 'Windows-x64',
  'linux-x86_64': 'Linux-x64',
};

export function releaseAssetName(platform, version, name) {
  if (!platforms.includes(platform) || !semver.test(version)) throw Error('Invalid release platform/version');
  const match = name.match(/(\.app\.tar\.gz|\.(?:dmg|msi|exe|deb|rpm|AppImage))(\.sig)?$/);
  if (!match) return null;
  const [, extension, signature = ''] = match;
  return `Gustaf-${version}-${labels[platform]}${extension === '.exe' ? '-setup' : ''}${extension}${signature}`;
}
