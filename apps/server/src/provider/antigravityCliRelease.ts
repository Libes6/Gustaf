import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export const ANTIGRAVITY_CLI_MANIFEST_BASE =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const Manifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u)),
  url: Schema.String,
  sha512: Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{128}$/u)),
});
const decodeManifest = Schema.decodeUnknownOption(Manifest);

export class AntigravityCliReleaseError extends Schema.TaggedError<AntigravityCliReleaseError>()(
  "AntigravityCliReleaseError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export interface AntigravityCliReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
  readonly executable: { readonly name: string };
  readonly format: "tar.gz" | "executable";
}

export function antigravityCliTarget(platform: NodeJS.Platform, arch: string, musl = false) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    return null;
  }
  const os = platform === "win32" ? "windows" : platform;
  return `${os}_${arch === "x64" ? "amd64" : arch}${platform === "linux" && musl ? "_musl" : ""}`;
}

export function parseAntigravityCliRelease(
  value: unknown,
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
): AntigravityCliReleaseAsset | null {
  const decoded = decodeManifest(value);
  if (decoded._tag === "None" || antigravityCliTarget(platform, arch, musl) === null) return null;
  const manifest = decoded.value;
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "x64" ? "x64" : "arm64";
  const suffix = platform === "linux" && musl ? "_musl" : "";
  const extension = platform === "win32" ? "exe" : "tar.gz";
  const folder = `${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "arm" : "x64"}${suffix ? "-musl" : ""}`;
  const prefix = `https://storage.googleapis.com/antigravity-public/antigravity-cli/${manifest.version}-`;
  const rest = manifest.url.startsWith(prefix) ? manifest.url.slice(prefix.length) : "";
  if (
    !/^\d+\//u.test(rest) ||
    rest.replace(/^\d+\//u, "") !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`
  ) {
    return null;
  }
  return {
    version: manifest.version,
    url: manifest.url,
    sha512: manifest.sha512.toLowerCase(),
    executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    format: platform === "win32" ? "executable" : "tar.gz",
  };
}

/** `tar -tzf` names. One executable, plus the license files Google sometimes ships beside it. */
export function antigravityCliArchiveEntry(listing: string, executableName: string): boolean {
  const entries = listing
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replace(/^\.\//u, ""))
    .filter((entry) => entry.length > 0 && !entry.endsWith("/"));
  const allowed = new Set([executableName, "LICENSE", "README.md"]);
  return (
    entries.includes(executableName) &&
    entries.every((entry) => allowed.has(entry) && !entry.includes("/") && !entry.includes("\\"))
  );
}

export const fetchAntigravityCliRelease = Effect.fn("fetchAntigravityCliRelease")(function* (
  platform: NodeJS.Platform,
  arch: string,
  musl = false,
) {
  const target = antigravityCliTarget(platform, arch, musl);
  if (target === null) return null;
  const http = yield* HttpClient.HttpClient;
  const response = yield* http
    .execute(HttpClientRequest.get(`${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((body) => body.json),
      Effect.mapError(
        () =>
          new AntigravityCliReleaseError({
            detail:
              "Could not read Google's latest Antigravity release. Check the network and try again.",
          }),
      ),
    );
  const release = parseAntigravityCliRelease(response, platform, arch, musl);
  if (release === null) {
    return yield* new AntigravityCliReleaseError({
      detail: "Google's latest Antigravity release is not one Gustaf can install.",
    });
  }
  return release;
});
