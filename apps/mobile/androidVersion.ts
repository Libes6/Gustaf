const RELEASE_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

// Android only installs an update whose versionCode is higher, so it must grow with every release.
export function androidReleaseVersion(tag: string) {
  const match = RELEASE_TAG_PATTERN.exec(tag.trim());
  if (!match)
    throw new Error(`Expected a release version like v1.2.3, got ${JSON.stringify(tag)}.`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  const versionCode = major * 10_000 + minor * 100 + patch;
  // Two digits each keep the code ordered; Android caps versionCode at 2100000000.
  if (minor > 99 || patch > 99 || versionCode > 2_100_000_000) {
    throw new Error(`Release version ${tag} does not fit the X*10000 + Y*100 + Z versionCode.`);
  }
  return { versionName: `${major}.${minor}.${patch}`, versionCode };
}
