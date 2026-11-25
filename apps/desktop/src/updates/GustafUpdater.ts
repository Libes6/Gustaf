// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off -- The updater is Promise and stream code at the process boundary; its Node I/O is injected in tests.
/**
 * Gustaf's own desktop updater: reads `latest.json` from a GitHub Release and installs a download
 * only after its minisign signature verifies against the key baked into the app. It emits the
 * events electron-updater did, so DesktopUpdates keeps its state machine; Squirrel.Mac cannot
 * install an unsigned app, which is why electron-updater is gone.
 */
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { compareSemverVersions } from "@t3tools/shared/semver";

import { createBlake2b512 } from "./blake2b.ts";
import {
  MinisignError,
  parsePublicKey,
  parseSignature,
  verifyDigest,
  type MinisignPublicKey,
} from "./minisign.ts";

export interface UpdateFeed {
  readonly manifestUrl: string;
  /** The minisign public key, as `tauri signer generate` prints it (base64 of the .pub file). */
  readonly publicKey: string;
  readonly currentVersion: string;
  /** Where downloads and the staged install helper live; contents are replaced per version. */
  readonly stagingDir: string;
  /** The running AppImage, when the Linux app is one. */
  readonly appImagePath: string | undefined;
}

export interface UpdateManifest {
  readonly version: string;
  readonly notes: string;
  readonly pubDate: string | undefined;
  readonly platforms: Readonly<
    Record<string, { readonly url: string; readonly signature: string }>
  >;
}

export interface UpdateInfo {
  readonly version: string;
  readonly releaseNotes: string;
  readonly releaseDate?: string;
  readonly downloadedFile?: string;
}

export interface GustafUpdaterDeps {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly pid: number;
  readonly execPath: string;
  readonly fetch: typeof fetch;
  /** Starts a program that keeps running after this process exits. */
  readonly spawnDetached: (command: string, args: ReadonlyArray<string>) => void;
  /** Runs a program to completion and rejects when it fails. */
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<void>;
  readonly quit: () => void;
}

class UpdateError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UpdateError";
  }
}

const MANIFEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_UPDATE_BYTES = 2 * 1024 ** 3;
const USER_AGENT = "Gustaf-Updater";

export function manifestPlatformKey(platform: NodeJS.Platform, arch: string): string | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (
    cpu === undefined ||
    (platform !== "darwin" && platform !== "win32" && platform !== "linux")
  ) {
    return undefined;
  }
  return `${os}-${cpu}`;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** Updates travel over https; plain http is for a mirror on this machine only. */
function assertTransportAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpdateError("The update address is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new UpdateError("Updates must be fetched over https.");
  }
  return url;
}

export function parseUpdateManifest(text: string): UpdateManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpdateError("The update manifest is not valid JSON.");
  }
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const root = record(json);
  const version = root?.version;
  const platforms = record(root?.platforms);
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ||
    platforms === undefined
  ) {
    throw new UpdateError("The update manifest is missing its version or platforms.");
  }
  const entries: Record<string, { url: string; signature: string }> = {};
  for (const [key, value] of Object.entries(platforms)) {
    const entry = record(value);
    if (typeof entry?.url === "string" && typeof entry.signature === "string") {
      entries[key] = { url: entry.url, signature: entry.signature };
    }
  }
  return {
    version,
    notes: typeof root?.notes === "string" ? root.notes : "",
    pubDate: typeof root?.pub_date === "string" ? root.pub_date : undefined,
    platforms: entries,
  };
}

/** A release file name safe to create in the staging directory. */
export function stagedFileName(url: URL): string {
  const base = decodeURIComponent(NodePath.posix.basename(url.pathname));
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "" || safe === "." || safe === ".." ? "update.bin" : safe;
}

export const MAC_INSTALL_SCRIPT = `#!/bin/bash
# $1 app pid, $2 unpacked new .app, $3 installed .app. Runs after Gustaf has quit.
pid=$1; new=$2; target=$3
staged="$target.gustaf-new"; backup="$target.gustaf-old"
rm -rf "$staged" "$backup"
if ditto "$new" "$staged"; then
  xattr -dr com.apple.quarantine "$staged" 2>/dev/null
  for _ in $(seq 1 240); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then rm -rf "$staged"; exit 1; fi
  if mv "$target" "$backup"; then
    if mv "$staged" "$target"; then rm -rf "$backup"; else mv "$backup" "$target"; fi
  fi
fi
rm -rf "$staged"
open "$target"
`;

// Electron holds descriptors without O_CLOEXEC; an AppImage that inherits them never exits cleanly.
export const LINUX_INSTALL_SCRIPT = `#!/bin/bash
# $1 app pid, $2 new AppImage beside the installed one, $3 installed AppImage.
pid=$1; new=$2; target=$3
for _ in $(seq 1 240); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
kill -0 "$pid" 2>/dev/null && { rm -f "$new"; exit 1; }
mv -f "$new" "$target" || rm -f "$new"
for fd in /proc/self/fd/*; do fd=\${fd##*/}; case $fd in *[!0-9]*|[012]) ;; *) eval "exec $fd>&-" ;; esac; done
export APPIMAGE_SILENT_INSTALL=true
exec "$target"
`;

export class GustafUpdater extends NodeEvents.EventEmitter {
  allowDowngrade = false;

  private feed: UpdateFeed | undefined;
  private publicKey: MinisignPublicKey | undefined;
  private offer:
    | { readonly info: UpdateInfo; readonly url: URL; readonly signature: string }
    | undefined;
  private downloaded:
    | { readonly info: UpdateInfo; readonly file: string; readonly appBundle: string | undefined }
    | undefined;

  private readonly deps: GustafUpdaterDeps;

  constructor(deps: GustafUpdaterDeps) {
    super();
    this.deps = deps;
  }

  /** Throws when the public key is not a minisign key, so a broken build never updates. */
  configure(feed: UpdateFeed): void {
    this.publicKey = parsePublicKey(feed.publicKey);
    assertTransportAllowed(feed.manifestUrl);
    this.feed = feed;
  }

  async checkForUpdates(): Promise<UpdateInfo | null> {
    this.emit("checking-for-update");
    try {
      return await this.check();
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await this.download();
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }

  /** Starts the platform's install step and quits; the step finishes after the app has exited. */
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    const downloaded = this.downloaded;
    if (downloaded === undefined)
      throw new UpdateError("There is no downloaded update to install.");
    if (this.feed === undefined) throw new UpdateError("The updater is not configured.");
    switch (this.deps.platform) {
      case "darwin":
        this.installMac(downloaded);
        break;
      case "win32":
        this.installWindows(downloaded.file, isSilent, isForceRunAfter);
        break;
      case "linux":
        this.installLinux(downloaded.file);
        break;
      default:
        throw new UpdateError(`Updates cannot be installed on ${this.deps.platform}.`);
    }
    this.deps.quit();
  }

  private async check(): Promise<UpdateInfo | null> {
    const feed = this.requireFeed();
    const response = await this.deps
      .fetch(assertTransportAllowed(feed.manifestUrl), {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      })
      .catch((cause: unknown) => {
        throw new UpdateError("Could not reach the update server.", { cause });
      });
    if (!response.ok) throw new UpdateError(`The update server answered ${response.status}.`);
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES)
      throw new UpdateError("The update manifest is too large.");
    const manifest = parseUpdateManifest(text);

    const key = manifestPlatformKey(this.deps.platform, this.deps.arch);
    const entry = key === undefined ? undefined : manifest.platforms[key];
    const order = compareSemverVersions(manifest.version, feed.currentVersion);
    const newer = order > 0 || (this.allowDowngrade && order !== 0);
    if (entry === undefined || !newer) {
      this.offer = undefined;
      this.emit("update-not-available", { version: manifest.version });
      return null;
    }
    const info: UpdateInfo = {
      version: manifest.version,
      releaseNotes: manifest.notes,
      ...(manifest.pubDate === undefined ? {} : { releaseDate: manifest.pubDate }),
    };
    this.offer = { info, url: assertTransportAllowed(entry.url), signature: entry.signature };
    this.emit("update-available", info);
    return info;
  }

  private async download(): Promise<void> {
    const feed = this.requireFeed();
    const publicKey = this.publicKey;
    const offer = this.offer;
    if (offer === undefined || publicKey === undefined) {
      throw new UpdateError("There is no update to download.");
    }
    // Parsed up front so a malformed signature fails before a large download starts.
    const signature = parseSignature(offer.signature);

    const versionDir = NodePath.join(feed.stagingDir, offer.info.version);
    NodeFS.rmSync(feed.stagingDir, { recursive: true, force: true });
    NodeFS.mkdirSync(versionDir, { recursive: true, mode: 0o700 });
    const finalPath = NodePath.join(versionDir, stagedFileName(offer.url));
    const partialPath = `${finalPath}.partial`;
    this.downloaded = undefined;

    const digest = await this.fetchToFile(offer.url, partialPath);
    try {
      verifyDigest(publicKey, signature, digest);
    } catch (error) {
      NodeFS.rmSync(partialPath, { force: true });
      throw error instanceof MinisignError
        ? new UpdateError(`The downloaded update failed verification: ${error.message}`, {
            cause: error,
          })
        : error;
    }
    NodeFS.renameSync(partialPath, finalPath);

    const appBundle =
      this.deps.platform === "darwin" ? await this.unpackMac(finalPath, versionDir) : undefined;
    this.downloaded = { info: offer.info, file: finalPath, appBundle };
    this.emit("update-downloaded", { ...offer.info, downloadedFile: finalPath });
  }

  private async fetchToFile(url: URL, partialPath: string): Promise<Uint8Array> {
    const controller = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
    };
    const out = NodeFS.createWriteStream(partialPath, { mode: 0o600 });
    let writeError: Error | undefined;
    out.on("error", (error) => {
      writeError = error;
    });
    try {
      armIdle();
      const response = await this.deps.fetch(url, {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new UpdateError(`The update download answered ${response.status}.`);
      }
      const total = Number(response.headers.get("content-length") ?? 0);
      if (total > MAX_UPDATE_BYTES) throw new UpdateError("The update is larger than expected.");

      const hash = createBlake2b512();
      const startedAt = Date.now();
      let received = 0;
      let reportedPercent = -1;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        armIdle();
        received += chunk.length;
        if (received > MAX_UPDATE_BYTES)
          throw new UpdateError("The update is larger than expected.");
        hash.update(chunk);
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => {
            out.once("drain", resolve);
            out.once("error", () => resolve());
          });
        }
        if (writeError !== undefined) throw writeError;
        const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
        if (percent !== reportedPercent) {
          reportedPercent = percent;
          this.emit("download-progress", {
            percent,
            total,
            transferred: received,
            bytesPerSecond: Math.round((received / Math.max(1, Date.now() - startedAt)) * 1000),
          });
        }
      }
      if (total > 0 && received !== total) {
        throw new UpdateError("The update download ended early.");
      }
      await new Promise<void>((resolve, reject) => {
        out.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
      if (writeError !== undefined) throw writeError;
      return hash.digest();
    } catch (error) {
      out.destroy();
      NodeFS.rmSync(partialPath, { force: true });
      throw error instanceof UpdateError
        ? error
        : new UpdateError("Could not download the update.", { cause: error });
    } finally {
      clearTimeout(idle);
    }
  }

  private async unpackMac(archive: string, versionDir: string): Promise<string> {
    const unpackedDir = NodePath.join(versionDir, "unpacked");
    NodeFS.mkdirSync(unpackedDir, { recursive: true, mode: 0o700 });
    await this.deps.run("/usr/bin/tar", ["-xzf", archive, "-C", unpackedDir]);
    const bundles = NodeFS.readdirSync(unpackedDir).filter((name) => name.endsWith(".app"));
    const [bundle] = bundles;
    if (bundles.length !== 1 || bundle === undefined) {
      throw new UpdateError("The update archive does not hold exactly one app.");
    }
    const appBundle = NodePath.join(unpackedDir, bundle);
    if (!NodeFS.existsSync(NodePath.join(appBundle, "Contents", "MacOS"))) {
      throw new UpdateError("The update archive's app has no executable.");
    }
    // Files this process wrote carry no quarantine, but a mirror or a user's tooling may add one.
    await this.deps
      .run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", appBundle])
      .catch(() => undefined);
    return appBundle;
  }

  private installMac(downloaded: { readonly appBundle: string | undefined }): void {
    const { appBundle } = downloaded;
    const feed = this.requireFeed();
    const running = runningAppBundle(this.deps.execPath);
    if (appBundle === undefined || !NodeFS.existsSync(appBundle)) {
      throw new UpdateError("The unpacked update is gone; download it again.");
    }
    if (running === undefined) throw new UpdateError("Gustaf is not running from an app bundle.");
    // The replacement happens after quitting, so anything that would stop it must fail now.
    try {
      NodeFS.accessSync(NodePath.dirname(running), NodeFS.constants.W_OK);
      NodeFS.accessSync(running, NodeFS.constants.W_OK);
    } catch (cause) {
      throw new UpdateError(
        `Gustaf cannot replace itself in ${NodePath.dirname(running)}. Install the update by hand from the release page.`,
        { cause },
      );
    }
    const script = this.writeScript(feed, "install-mac.sh", MAC_INSTALL_SCRIPT);
    this.deps.spawnDetached("/bin/bash", [script, String(this.deps.pid), appBundle, running]);
  }

  private installWindows(installer: string, isSilent: boolean, isForceRunAfter: boolean): void {
    if (!NodeFS.existsSync(installer)) {
      throw new UpdateError("The downloaded installer is gone; download it again.");
    }
    // The flags electron-builder's NSIS installer understands for an in-place update.
    const args = [
      "--updated",
      ...(isSilent ? ["/S"] : []),
      ...(isForceRunAfter ? ["--force-run"] : []),
    ];
    this.deps.spawnDetached(installer, args);
  }

  private installLinux(file: string): void {
    const feed = this.requireFeed();
    const target = feed.appImagePath;
    if (target === undefined) {
      throw new UpdateError(
        "Only the AppImage can update itself. Download the new version from the release page.",
      );
    }
    const staged = `${target}.gustaf-new`;
    try {
      NodeFS.accessSync(NodePath.dirname(target), NodeFS.constants.W_OK);
      NodeFS.copyFileSync(file, staged);
      NodeFS.chmodSync(staged, 0o755);
    } catch (cause) {
      NodeFS.rmSync(staged, { force: true });
      throw new UpdateError(
        `Gustaf cannot replace ${target}. Install the update by hand from the release page.`,
        { cause },
      );
    }
    const script = this.writeScript(feed, "install-linux.sh", LINUX_INSTALL_SCRIPT);
    this.deps.spawnDetached("/bin/bash", ["-p", script, String(this.deps.pid), staged, target]);
  }

  private writeScript(feed: UpdateFeed, name: string, body: string): string {
    NodeFS.mkdirSync(feed.stagingDir, { recursive: true, mode: 0o700 });
    const script = NodePath.join(feed.stagingDir, name);
    NodeFS.writeFileSync(script, body, { mode: 0o700 });
    return script;
  }

  private requireFeed(): UpdateFeed {
    if (this.feed === undefined) throw new UpdateError("The updater is not configured.");
    return this.feed;
  }
}

/** `/Applications/Gustaf.app` for `/Applications/Gustaf.app/Contents/MacOS/Gustaf`. */
export function runningAppBundle(execPath: string): string | undefined {
  const marker = ".app/Contents/MacOS/";
  const index = execPath.indexOf(marker);
  return index === -1 ? undefined : execPath.slice(0, index + ".app".length);
}
