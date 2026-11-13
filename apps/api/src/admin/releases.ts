// Download counts of GitHub release assets, grouped by platform. Updater payloads and metadata
// (signatures, checksums, latest.json) are told apart so installs are not inflated by update checks.

export const PLATFORMS = ["macos", "windows", "linux", "android", "ios", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type AssetKind = "installer" | "update" | "metadata";

export function classifyAsset(name: string): { platform: Platform; kind: AssetKind } {
  const lower = name.toLowerCase();
  if (
    /\.(sig|sha256|sha512|asc|blockmap|ya?ml)$/.test(lower) ||
    /^latest[\w.-]*\.json$/.test(lower) ||
    lower.includes("sha256sums")
  ) {
    return { platform: "other", kind: "metadata" };
  }
  if (/\.(dmg|pkg)$/.test(lower)) return { platform: "macos", kind: "installer" };
  if (/\.app\.tar\.gz$/.test(lower) || (/(mac|darwin)/.test(lower) && lower.endsWith(".zip"))) {
    return { platform: "macos", kind: "update" };
  }
  if (/\.(exe|msi|msix|appx)$/.test(lower)) return { platform: "windows", kind: "installer" };
  if (/\.(appimage|deb|rpm|flatpak|snap)$/.test(lower) || /linux.*\.tar\.(gz|xz)$/.test(lower)) {
    return { platform: "linux", kind: "installer" };
  }
  if (/\.(apk|aab)$/.test(lower)) return { platform: "android", kind: "installer" };
  if (lower.endsWith(".ipa")) return { platform: "ios", kind: "installer" };
  return { platform: "other", kind: "installer" };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function summarizeReleases(body: unknown) {
  if (!Array.isArray(body)) throw new Error("Unexpected GitHub releases response");
  const byPlatform = Object.fromEntries(
    PLATFORMS.map((platform) => [platform, { installer: 0, update: 0 }]),
  ) as Record<Platform, { installer: number; update: number }>;
  const releases = body
    .filter(isObject)
    .filter((release) => release.draft !== true)
    .map((release) => {
      const assets = (Array.isArray(release.assets) ? release.assets : [])
        .filter(isObject)
        .map((asset) => {
          const name = typeof asset.name === "string" ? asset.name : "";
          const downloads = num(asset.download_count);
          const { platform, kind } = classifyAsset(name);
          if (kind !== "metadata") byPlatform[platform][kind] += downloads;
          return { name, platform, kind, downloads, sizeBytes: num(asset.size) };
        });
      return {
        tag: typeof release.tag_name === "string" ? release.tag_name : "",
        name: typeof release.name === "string" && release.name ? release.name : null,
        publishedAt: typeof release.published_at === "string" ? release.published_at : null,
        prerelease: release.prerelease === true,
        downloads: assets
          .filter((asset) => asset.kind !== "metadata")
          .reduce((sum, asset) => sum + asset.downloads, 0),
        assets,
      };
    });
  const total = releases.reduce((sum, release) => sum + release.downloads, 0);
  return { releases, byPlatform, total };
}

/** The newest 100 releases; older ones are left out. */
export async function fetchReleases(
  repo: string,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "gustaf-cloud-api",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
  return summarizeReleases(await response.json());
}
