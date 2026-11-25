// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off -- The updater is Promise and stream code at the process boundary; its Node I/O is injected in tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  GustafUpdater,
  LINUX_INSTALL_SCRIPT,
  MAC_INSTALL_SCRIPT,
  manifestPlatformKey,
  parseUpdateManifest,
  runningAppBundle,
  stagedFileName,
  type GustafUpdaterDeps,
  type UpdateFeed,
} from "./GustafUpdater.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", name));
const text = (name: string) => fixture(name).toString("utf8");

const MANIFEST_URL = "https://github.com/Libes6/Gustaf/releases/latest/download/latest.json";
const FILE_URL =
  "https://github.com/Libes6/Gustaf/releases/download/v9.0.0/Gustaf-9.0.0-Linux-x64.AppImage";

let tmp: string;
beforeEach(() => {
  tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gustaf-updater-test-"));
});
afterEach(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

const manifestFor = (key: string, signature: string, version = "9.0.0", url = FILE_URL) =>
  JSON.stringify({
    version,
    notes: "- **Faster.** It is.",
    pub_date: "2026-11-25T00:00:00Z",
    platforms: { [key]: { url, signature } },
  });

interface Harness {
  readonly updater: GustafUpdater;
  readonly spawned: Array<{ command: string; args: ReadonlyArray<string> }>;
  readonly quit: ReturnType<typeof vi.fn>;
  readonly events: Array<[string, unknown]>;
  readonly feed: UpdateFeed;
}

function harness(options: {
  platform: NodeJS.Platform;
  routes: Record<string, () => Response>;
  publicKey?: string | undefined;
  currentVersion?: string;
  appImagePath?: string | undefined;
  execPath?: string;
}): Harness {
  const spawned: Harness["spawned"] = [];
  const quit = vi.fn();
  const fetchStub = (input: string | URL | Request) => {
    const route = options.routes[String(input)];
    return Promise.resolve(route ? route() : new Response("missing", { status: 404 }));
  };
  const deps: GustafUpdaterDeps = {
    platform: options.platform,
    arch: "x64",
    pid: 4242,
    execPath: options.execPath ?? "/opt/gustaf/gustaf",
    fetch: fetchStub as unknown as typeof fetch,
    spawnDetached: (command, args) => void spawned.push({ command, args }),
    run: (command, args) =>
      new Promise((resolve, reject) =>
        NodeChildProcess.execFile(command, [...args], (error) =>
          error ? reject(error) : resolve(),
        ),
      ),
    quit,
  };
  const updater = new GustafUpdater(deps);
  const events: Array<[string, unknown]> = [];
  for (const name of [
    "checking-for-update",
    "update-available",
    "update-not-available",
    "download-progress",
    "update-downloaded",
    "error",
  ]) {
    updater.on(name, (payload: unknown) => events.push([name, payload]));
  }
  const feed: UpdateFeed = {
    manifestUrl: MANIFEST_URL,
    publicKey: options.publicKey ?? text("signer.pub"),
    currentVersion: options.currentVersion ?? "1.0.0",
    stagingDir: NodePath.join(tmp, "updates"),
    appImagePath: "appImagePath" in options ? options.appImagePath : undefined,
  };
  updater.configure(feed);
  return { updater, spawned, quit, events, feed };
}

const linuxRoutes = (file: Buffer, signature: string, version = "9.0.0") => ({
  [MANIFEST_URL]: () => new Response(manifestFor("linux-x86_64", signature, version)),
  [FILE_URL]: () =>
    new Response(new Uint8Array(file), { headers: { "content-length": String(file.length) } }),
});

const names = (h: Harness) => h.events.map(([name]) => name);

describe("update manifest", () => {
  it("keeps the fields the updater uses and drops malformed platform entries", () => {
    const manifest = parseUpdateManifest(
      JSON.stringify({
        version: "0.2.0",
        notes: "n",
        pub_date: "2026-01-01T00:00:00Z",
        platforms: { "linux-x86_64": { url: "https://x/y", signature: "s" }, broken: { url: 1 } },
      }),
    );
    expect(manifest).toEqual({
      version: "0.2.0",
      notes: "n",
      pubDate: "2026-01-01T00:00:00Z",
      platforms: { "linux-x86_64": { url: "https://x/y", signature: "s" } },
    });
  });

  it.each(["not json", "{}", '{"version":"latest","platforms":{}}', '{"version":"1.0.0"}'])(
    "rejects %s",
    (body) => {
      expect(() => parseUpdateManifest(body)).toThrow();
    },
  );

  it("names the platforms the release builds", () => {
    expect(manifestPlatformKey("darwin", "arm64")).toBe("darwin-aarch64");
    expect(manifestPlatformKey("win32", "x64")).toBe("windows-x86_64");
    expect(manifestPlatformKey("linux", "x64")).toBe("linux-x86_64");
    expect(manifestPlatformKey("freebsd", "x64")).toBeUndefined();
    expect(manifestPlatformKey("linux", "ia32")).toBeUndefined();
  });

  it("keeps release file names inside the staging directory", () => {
    expect(stagedFileName(new URL("https://h/d/Gustaf%201.0-x64.exe"))).toBe("Gustaf_1.0-x64.exe");
    expect(stagedFileName(new URL("https://h/d/..%2F..%2Fx"))).toBe(".._.._x");
    expect(stagedFileName(new URL("https://h/"))).toBe("update.bin");
    expect(runningAppBundle("/Applications/Gustaf.app/Contents/MacOS/Gustaf")).toBe(
      "/Applications/Gustaf.app",
    );
    expect(runningAppBundle("/usr/bin/gustaf")).toBeUndefined();
  });
});

describe("checking for updates", () => {
  it("offers a newer release with its notes and date", async () => {
    const h = harness({
      platform: "linux",
      routes: linuxRoutes(fixture("payload2.txt"), text("payload2.txt.sig")),
    });
    await expect(h.updater.checkForUpdates()).resolves.toMatchObject({
      version: "9.0.0",
      releaseNotes: "- **Faster.** It is.",
      releaseDate: "2026-11-25T00:00:00Z",
    });
    expect(names(h)).toEqual(["checking-for-update", "update-available"]);
  });

  it("offers nothing when this version is current or newer", async () => {
    for (const currentVersion of ["9.0.0", "9.0.1"]) {
      const h = harness({
        platform: "linux",
        currentVersion,
        routes: linuxRoutes(fixture("payload2.txt"), text("payload2.txt.sig")),
      });
      await expect(h.updater.checkForUpdates()).resolves.toBeNull();
      expect(names(h)).toEqual(["checking-for-update", "update-not-available"]);
    }
  });

  it("offers nothing when the release has no build for this platform", async () => {
    const h = harness({
      platform: "win32",
      routes: linuxRoutes(fixture("payload2.txt"), text("payload2.txt.sig")),
    });
    await expect(h.updater.checkForUpdates()).resolves.toBeNull();
  });

  it("reports an unreachable or broken server as an error", async () => {
    const h = harness({ platform: "linux", routes: {} });
    await expect(h.updater.checkForUpdates()).rejects.toThrow(/404/);
    expect(names(h)).toEqual(["checking-for-update", "error"]);
  });

  it("refuses a manifest address that is not https", () => {
    const h = harness({ platform: "linux", routes: {} });
    expect(() =>
      h.updater.configure({ ...h.feed, manifestUrl: "http://example.com/latest.json" }),
    ).toThrow(/https/);
    expect(() =>
      h.updater.configure({ ...h.feed, manifestUrl: "http://localhost:3000/latest.json" }),
    ).not.toThrow();
  });

  it("refuses a download address that is not https", async () => {
    const h = harness({
      platform: "linux",
      routes: {
        [MANIFEST_URL]: () =>
          new Response(
            manifestFor("linux-x86_64", text("payload2.txt.sig"), "9.0.0", "http://evil.example/x"),
          ),
      },
    });
    await expect(h.updater.checkForUpdates()).rejects.toThrow(/https/);
  });

  it("refuses a public key that is not minisign", () => {
    expect(() => harness({ platform: "linux", routes: {}, publicKey: "nope" })).toThrow();
  });
});

describe("downloading and verifying", () => {
  it("keeps a file whose signature verifies and reports progress", async () => {
    const file = fixture("payload2.txt");
    const h = harness({ platform: "linux", routes: linuxRoutes(file, text("payload2.txt.sig")) });
    await h.updater.checkForUpdates();
    await h.updater.downloadUpdate();

    const downloaded = h.events.find(([name]) => name === "update-downloaded")?.[1] as {
      version: string;
      downloadedFile: string;
    };
    expect(downloaded.version).toBe("9.0.0");
    expect(NodeFS.readFileSync(downloaded.downloadedFile)).toEqual(file);
    expect(
      NodeFS.readdirSync(NodePath.dirname(downloaded.downloadedFile)).some((n) =>
        n.endsWith(".partial"),
      ),
    ).toBe(false);
    expect(
      h.events.some(
        ([name, p]) => name === "download-progress" && (p as { percent: number }).percent === 100,
      ),
    ).toBe(true);
  });

  const refused = async (routes: Record<string, () => Response>, publicKey?: string) => {
    const h = harness({ platform: "linux", routes, publicKey });
    await h.updater.checkForUpdates();
    await expect(h.updater.downloadUpdate()).rejects.toThrow();
    // Nothing unverified stays on disk or can be installed.
    const leftovers = NodeFS.existsSync(h.feed.stagingDir)
      ? NodeFS.readdirSync(NodePath.join(h.feed.stagingDir, "9.0.0"))
      : [];
    expect(leftovers).toEqual([]);
    expect(names(h)).not.toContain("update-downloaded");
    expect(() => h.updater.quitAndInstall(true, true)).toThrow(/no downloaded update/);
    expect(h.quit).not.toHaveBeenCalled();
    return h;
  };

  it("refuses a file swapped for another one", async () => {
    await refused(linuxRoutes(fixture("payload.txt"), text("payload2.txt.sig")));
  });

  it("refuses a file with one byte changed", async () => {
    const tampered = Buffer.from(fixture("payload2.txt"));
    tampered[100] = tampered[100]! ^ 1;
    await refused(linuxRoutes(tampered, text("payload2.txt.sig")));
  });

  it("refuses a truncated file even when the server reports its short length", async () => {
    const half = fixture("payload2.txt").subarray(0, 2000);
    await refused(linuxRoutes(half, text("payload2.txt.sig")));
  });

  it("refuses a download that ends before its announced length", async () => {
    const file = fixture("payload2.txt");
    await refused({
      [MANIFEST_URL]: () => new Response(manifestFor("linux-x86_64", text("payload2.txt.sig"))),
      [FILE_URL]: () =>
        new Response(new Uint8Array(file.subarray(0, 100)), {
          headers: { "content-length": String(file.length) },
        }),
    });
  });

  it("refuses a file signed by another key", async () => {
    await refused(
      linuxRoutes(fixture("payload2.txt"), text("payload2.txt.sig")),
      text("other-signer.pub"),
    );
  });

  it("refuses a malformed signature before downloading anything", async () => {
    const h = harness({
      platform: "linux",
      routes: linuxRoutes(fixture("payload2.txt"), "bm9wZQ=="),
    });
    await h.updater.checkForUpdates();
    await expect(h.updater.downloadUpdate()).rejects.toThrow();
    expect(NodeFS.existsSync(h.feed.stagingDir)).toBe(false);
  });

  it("refuses a failed download", async () => {
    await refused({
      [MANIFEST_URL]: () => new Response(manifestFor("linux-x86_64", text("payload2.txt.sig"))),
      [FILE_URL]: () => new Response("gone", { status: 404 }),
    });
  });
});

describe("installing", () => {
  it("replaces a Linux AppImage through a helper that runs after the app quits", async () => {
    const installed = NodePath.join(tmp, "Gustaf.AppImage");
    NodeFS.writeFileSync(installed, "old");
    const file = fixture("payload2.txt");
    const h = harness({
      platform: "linux",
      appImagePath: installed,
      routes: linuxRoutes(file, text("payload2.txt.sig")),
    });
    await h.updater.checkForUpdates();
    await h.updater.downloadUpdate();
    h.updater.quitAndInstall(true, true);

    expect(NodeFS.readFileSync(installed, "utf8")).toBe("old");
    expect(NodeFS.readFileSync(`${installed}.gustaf-new`)).toEqual(file);
    expect(NodeFS.statSync(`${installed}.gustaf-new`).mode & 0o111).not.toBe(0);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.command).toBe("/bin/bash");
    expect(h.spawned[0]!.args.slice(-3)).toEqual(["4242", `${installed}.gustaf-new`, installed]);
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it("does not quit when a Linux install is not an AppImage", async () => {
    const h = harness({
      platform: "linux",
      routes: linuxRoutes(fixture("payload2.txt"), text("payload2.txt.sig")),
    });
    await h.updater.checkForUpdates();
    await h.updater.downloadUpdate();
    expect(() => h.updater.quitAndInstall(true, true)).toThrow(/AppImage/);
    expect(h.spawned).toEqual([]);
    expect(h.quit).not.toHaveBeenCalled();
  });

  it("starts the Windows installer silently and relaunches", async () => {
    const url =
      "https://github.com/Libes6/Gustaf/releases/download/v9.0.0/Gustaf-9.0.0-Windows-x64-setup.exe";
    const file = fixture("payload2.txt");
    const h = harness({
      platform: "win32",
      routes: {
        [MANIFEST_URL]: () =>
          new Response(manifestFor("windows-x86_64", text("payload2.txt.sig"), "9.0.0", url)),
        [url]: () =>
          new Response(new Uint8Array(file), {
            headers: { "content-length": String(file.length) },
          }),
      },
    });
    await h.updater.checkForUpdates();
    await h.updater.downloadUpdate();
    h.updater.quitAndInstall(true, true);
    expect(h.spawned).toHaveLength(1);
    expect(NodePath.basename(h.spawned[0]!.command)).toBe("Gustaf-9.0.0-Windows-x64-setup.exe");
    expect(h.spawned[0]!.args).toEqual(["--updated", "/S", "--force-run"]);
    expect(h.quit).toHaveBeenCalledOnce();
  });

  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("macOS", () => {
    const archiveUrl =
      "https://github.com/Libes6/Gustaf/releases/download/v9.0.0/Gustaf-9.0.0-macOS-arm64.app.tar.gz";
    const macHarness = (execPath: string) => {
      const archive = fixture("Fake-app.tar.gz");
      return {
        ...harness({
          platform: "darwin",
          execPath,
          routes: {
            [MANIFEST_URL]: () =>
              new Response(
                manifestFor("darwin-x86_64", text("Fake-app.tar.gz.sig"), "9.0.0", archiveUrl),
              ),
            [archiveUrl]: () =>
              new Response(new Uint8Array(archive), {
                headers: { "content-length": String(archive.length) },
              }),
          },
        }),
      };
    };

    it("unpacks the verified app and hands the swap to a helper script", async () => {
      const bundle = NodePath.join(tmp, "Applications", "Gustaf.app");
      NodeFS.mkdirSync(NodePath.join(bundle, "Contents", "MacOS"), { recursive: true });
      const h = macHarness(NodePath.join(bundle, "Contents", "MacOS", "Gustaf"));
      await h.updater.checkForUpdates();
      await h.updater.downloadUpdate();
      const { downloadedFile } = h.events.find(([n]) => n === "update-downloaded")![1] as {
        downloadedFile: string;
      };
      const unpacked = NodePath.join(NodePath.dirname(downloadedFile), "unpacked", "Fake.app");
      expect(NodeFS.existsSync(NodePath.join(unpacked, "Contents", "MacOS", "Fake"))).toBe(true);

      h.updater.quitAndInstall(true, true);
      const [spawn] = h.spawned;
      expect(spawn!.command).toBe("/bin/bash");
      expect(spawn!.args.slice(1)).toEqual(["4242", unpacked, bundle]);
      const script = NodeFS.readFileSync(spawn!.args[0]!, "utf8");
      expect(script).toContain("com.apple.quarantine");
      expect(script).toContain('open "$target"');
      expect(h.quit).toHaveBeenCalledOnce();
    });

    it("fails before quitting when the app cannot be replaced where it is", async () => {
      const h = macHarness(NodePath.join(tmp, "elsewhere", "Gustaf"));
      await h.updater.checkForUpdates();
      await h.updater.downloadUpdate();
      expect(() => h.updater.quitAndInstall(true, true)).toThrow(/app bundle/);
      expect(h.spawned).toEqual([]);
      expect(h.quit).not.toHaveBeenCalled();
    });
  });

  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "the helper scripts, run for real",
    () => {
      const writeScript = (name: string, body: string) => {
        const file = NodePath.join(tmp, name);
        NodeFS.writeFileSync(file, body, { mode: 0o700 });
        return file;
      };
      const deadPid = async () => {
        const child = NodeChildProcess.spawn("true");
        await new Promise((resolve) => child.once("exit", resolve));
        return String(child.pid);
      };
      const runScript = (script: string, args: ReadonlyArray<string>, path = process.env.PATH) =>
        NodeChildProcess.spawnSync("/bin/bash", [script, ...args], {
          encoding: "utf8",
          env: { ...process.env, PATH: path },
        });

      it("swaps the macOS bundle, drops quarantine, relaunches, and keeps the old app on failure", async () => {
        if (HostProcess.Platform.defaultValue() !== "darwin") return;
        const stubs = NodePath.join(tmp, "stubs");
        NodeFS.mkdirSync(stubs);
        NodeFS.writeFileSync(
          NodePath.join(stubs, "open"),
          `#!/bin/sh\necho "$@" >> "${tmp}/opened"\n`,
          { mode: 0o755 },
        );
        const script = writeScript("install-mac.sh", MAC_INSTALL_SCRIPT);
        const target = NodePath.join(tmp, "Gustaf.app");
        const fresh = NodePath.join(tmp, "new", "Gustaf.app");
        for (const [dir, label] of [
          [target, "old"],
          [fresh, "new"],
        ] as const) {
          NodeFS.mkdirSync(NodePath.join(dir, "Contents"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(dir, "Contents", "label"), label);
        }
        NodeChildProcess.execFileSync("/usr/bin/xattr", [
          "-w",
          "com.apple.quarantine",
          "0081;00000000;x;",
          fresh,
        ]);

        const result = runScript(
          script,
          [await deadPid(), fresh, target],
          `${stubs}:${process.env.PATH}`,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(NodeFS.readFileSync(NodePath.join(target, "Contents", "label"), "utf8")).toBe("new");
        expect(NodeFS.readdirSync(tmp).filter((n) => n.includes("gustaf-"))).toEqual([]);
        expect(
          NodeChildProcess.spawnSync("/usr/bin/xattr", [target], { encoding: "utf8" }).stdout,
        ).not.toContain("quarantine");
        expect(NodeFS.readFileSync(`${tmp}/opened`, "utf8").trim()).toBe(target);

        // A source that cannot be copied leaves the installed app untouched and still relaunches it.
        const broken = runScript(
          script,
          [await deadPid(), NodePath.join(tmp, "missing.app"), target],
          `${stubs}:${process.env.PATH}`,
        );
        expect(broken.status).toBe(0);
        expect(NodeFS.readFileSync(NodePath.join(target, "Contents", "label"), "utf8")).toBe("new");
      });

      it("swaps the Linux AppImage and launches the new one", async () => {
        const script = writeScript("install-linux.sh", LINUX_INSTALL_SCRIPT);
        const target = NodePath.join(tmp, "Gustaf.AppImage");
        const staged = `${target}.gustaf-new`;
        NodeFS.writeFileSync(target, "#!/bin/sh\necho old\n", { mode: 0o755 });
        NodeFS.writeFileSync(
          staged,
          `#!/bin/sh\necho "$APPIMAGE_SILENT_INSTALL" > "${tmp}/launched"\n`,
          { mode: 0o755 },
        );
        const result = runScript(script, [await deadPid(), staged, target]);
        expect(result.status, result.stderr).toBe(0);
        expect(NodeFS.existsSync(staged)).toBe(false);
        expect(NodeFS.readFileSync(`${tmp}/launched`, "utf8").trim()).toBe("true");
      });
    },
  );
});
