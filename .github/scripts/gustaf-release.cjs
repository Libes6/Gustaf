// Release helpers for .github/workflows/gustaf-release.yml: name and stage the build outputs,
// check a release is complete, sign-check it against the app's key, write latest.json and notes.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const url = require("node:url");

const SEMVER = /^\d+\.\d+\.\d+$/;
const platforms = ["darwin-aarch64", "windows-x86_64", "linux-x86_64"];
const labels = {
  "darwin-aarch64": "macOS-arm64",
  "windows-x86_64": "Windows-x64",
  "linux-x86_64": "Linux-x64",
};
// What the in-app updater downloads and verifies for each platform.
const updateSuffix = {
  "darwin-aarch64": ".app.tar.gz",
  "windows-x86_64": "-setup.exe",
  "linux-x86_64": ".AppImage",
};
// Installers a person downloads by hand, beyond the update file.
const installerSuffixes = { "darwin-aarch64": [".dmg"], "windows-x86_64": [], "linux-x86_64": [] };
// The `t3-<version>-<key>` archives that `gustaf update` and desktop-managed SSH hosts download;
// names come from cliArchiveFileName in packages/shared/src/cliRelease.ts.
const cliArchives = {
  "darwin-aarch64": (version) => `t3-${version}-darwin-arm64.tar.gz`,
  "windows-x86_64": (version) => `t3-${version}-win32-x64.zip`,
  "linux-x86_64": (version) => `t3-${version}-linux-x64.tar.gz`,
};
const DEFAULT_REPOSITORY = "Libes6/Gustaf";

function assertVersion(version) {
  if (!SEMVER.test(version ?? "")) throw new Error(`Invalid release version: ${version}`);
}

/** The released name of a build output, or null for files that are not shipped. */
function releaseAssetName(platform, version, name) {
  if (!platforms.includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  assertVersion(version);
  const match = name.match(/(\.app\.tar\.gz|\.(?:dmg|deb|AppImage|exe))(\.sig)?$/);
  if (!match) return null;
  const [, extension, signature = ""] = match;
  return `Gustaf-${version}-${labels[platform]}${extension === ".exe" ? "-setup" : ""}${extension}${signature}`;
}

/** Files each platform must have staged; `signed` adds the signatures and the manifest. */
function missingReleaseAssets(version, files, { signed = false } = {}) {
  const missing = [];
  for (const platform of platforms) {
    const names = files[platform] ?? [];
    const has = (suffix) =>
      names.some((name) => name.startsWith(`Gustaf-${version}-`) && name.endsWith(suffix));
    for (const suffix of [updateSuffix[platform], ...installerSuffixes[platform]]) {
      if (!has(suffix)) missing.push(`${platform}: *${suffix}`);
    }
    if (signed && !has(`${updateSuffix[platform]}.sig`)) {
      missing.push(`${platform}: *${updateSuffix[platform]}.sig`);
    }
    const archive = cliArchives[platform](version);
    if (!names.includes(archive)) missing.push(`${platform}: ${archive}`);
  }
  if (signed && !(files.root ?? []).includes("latest.json")) missing.push("latest.json");
  return missing;
}

function listReleaseAssets(directory) {
  const files = {};
  for (const platform of platforms) {
    const dir = path.join(directory, platform);
    files[platform] = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }
  files.root = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  return files;
}

/** latest.json, in the shape `GustafUpdater` reads: one signed file per platform. */
function manifest({ version, assets, notes = "", date = new Date().toISOString(), repository }) {
  assertVersion(version);
  if (Number.isNaN(Date.parse(date))) throw new Error("Invalid release date");
  const result = { version, notes, pub_date: date, platforms: {} };
  const names = new Set();
  for (const platform of platforms) {
    const asset = assets[platform];
    if (
      !asset ||
      !asset.name.endsWith(updateSuffix[platform]) ||
      names.has(asset.name) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.signature?.trim() ?? "")
    ) {
      throw new Error(`Missing or invalid signed update file: ${platform}`);
    }
    names.add(asset.name);
    result.platforms[platform] = {
      signature: asset.signature.trim(),
      url: `https://github.com/${repository ?? DEFAULT_REPOSITORY}/releases/download/v${version}/${encodeURIComponent(asset.name)}`,
    };
  }
  return result;
}

const conventional = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/;
const MAX_HIGHLIGHTS = 7;

/** `feat(web): add X (#12)` -> `{ kind: "feature", text: "Add X" }`; unrelated titles -> null. */
function classifyTitle(title) {
  const match = conventional.exec(title.trim());
  if (!match) return null;
  const type = match[1].toLowerCase();
  const text = match[2].replace(/\s*\(#\d+\)$/, "").trim();
  if (!text) return null;
  if (type === "feat") return { kind: "feature", text: text[0].toUpperCase() + text.slice(1) };
  if (type === "fix" || type === "perf") return { kind: "fix", text };
  return null;
}

/** Titles newest first. The app's update card shows the `- ` bullets and the closing `Plus N` line. */
function generateNotes(titles) {
  const features = [];
  let fixes = 0;
  for (const title of titles) {
    const entry = classifyTitle(title);
    if (entry?.kind === "feature") features.push(entry.text);
    else if (entry?.kind === "fix") fixes++;
  }
  const lines = features.slice(0, MAX_HIGHLIGHTS).map((text) => `- ${text}`);
  if (fixes > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Plus ${fixes} bug ${fixes === 1 ? "fix" : "fixes"} and improvements.`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

/** A hand-written `docs/release-notes/<version>.md` wins over generated notes. */
function releaseNotes({ override, titles }) {
  if (override !== undefined && override.trim()) return override.trimEnd() + "\n";
  return generateNotes(titles());
}

function gh(...args) {
  return childProcess.execFileSync("gh", ["api", ...args], { encoding: "utf8" });
}

/** PR titles merged between two tags, newest first, one per pull request. */
function mergedTitles(repository, previousTag, tag) {
  const commits = gh(
    "--paginate",
    `repos/${repository}/compare/${previousTag}...${tag}`,
    "--jq",
    '.commits[] | [.sha, (.commit.message | split("\\n")[0])] | @tsv',
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .reverse();
  const seen = new Set();
  const titles = [];
  for (const [sha, subject] of commits) {
    const pulls = JSON.parse(
      gh(
        `repos/${repository}/commits/${sha}/pulls`,
        "--jq",
        "[.[] | select(.merged_at) | [.number, .title]]",
      ),
    );
    if (pulls.length === 0) {
      titles.push(subject);
      continue;
    }
    for (const [number, title] of pulls) {
      if (seen.has(number)) continue;
      seen.add(number);
      titles.push(title);
    }
  }
  return titles;
}

/**
 * Copies one platform's build outputs under their release names and, on macOS, packs the update
 * file: the `.app` inside electron-builder's zip, as a tarball that keeps symlinks and modes.
 */
function stagePlatform({ platform, version, buildDir, cliDir, outDir }) {
  assertVersion(version);
  fs.mkdirSync(outDir, { recursive: true });
  for (const entry of fs.readdirSync(buildDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = releaseAssetName(platform, version, entry.name);
    if (name === null) continue;
    fs.copyFileSync(
      path.join(buildDir, entry.name),
      path.join(outDir, name),
      fs.constants.COPYFILE_EXCL,
    );
  }
  if (platform === "darwin-aarch64") {
    const zips = fs.readdirSync(buildDir).filter((name) => name.endsWith(".zip"));
    if (zips.length !== 1)
      throw new Error(`Expected one macOS zip in ${buildDir}, found ${zips.length}`);
    const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), "gustaf-app-"));
    try {
      run("ditto", ["-x", "-k", path.join(buildDir, zips[0]), unpacked]);
      const apps = fs.readdirSync(unpacked).filter((name) => name.endsWith(".app"));
      if (apps.length !== 1)
        throw new Error(`Expected one .app in the macOS zip, found ${apps.length}`);
      const archive = path.join(outDir, `Gustaf-${version}-${labels[platform]}.app.tar.gz`);
      run("tar", ["-czf", archive, "-C", unpacked, apps[0]], { COPYFILE_DISABLE: "1" });
    } finally {
      fs.rmSync(unpacked, { recursive: true, force: true });
    }
  }
  const cliArchive = cliArchives[platform](version);
  const cliSource = path.join(cliDir, cliArchive);
  if (!fs.existsSync(cliSource)) throw new Error(`Missing CLI archive ${cliSource}`);
  fs.copyFileSync(cliSource, path.join(outDir, cliArchive), fs.constants.COPYFILE_EXCL);
}

function run(command, args, env = {}) {
  childProcess.execFileSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
}

/** The signed update file of each platform, read from `<directory>/<platform>/`. */
function readSignedAssets(directory, version) {
  const assets = {};
  for (const platform of platforms) {
    const dir = path.join(directory, platform);
    const candidates = fs
      .readdirSync(dir)
      .filter(
        (name) => name.startsWith(`Gustaf-${version}-`) && name.endsWith(updateSuffix[platform]),
      );
    if (candidates.length !== 1) throw new Error(`Expected one update file: ${platform}`);
    const name = candidates[0];
    assets[platform] = {
      name,
      path: path.join(dir, name),
      signature: fs.readFileSync(path.join(dir, `${name}.sig`), "utf8"),
    };
  }
  return assets;
}

/**
 * Checks every update file against the public key the app is built with, using the app's own
 * verifier, so a key mismatch fails here and not on a user's machine.
 */
async function verifySignatures({ directory, version, publicKey, appRoot }) {
  const load = (file) =>
    import(url.pathToFileURL(path.join(appRoot, "apps/desktop/src/updates", file)).href);
  const { parsePublicKey, parseSignature, verifyDigest } = await load("minisign.ts");
  const { createBlake2b512 } = await load("blake2b.ts");
  const key = parsePublicKey(publicKey);
  for (const [platform, asset] of Object.entries(readSignedAssets(directory, version))) {
    const hash = createBlake2b512();
    await new Promise((resolve, reject) => {
      fs.createReadStream(asset.path)
        .on("data", (chunk) => hash.update(chunk))
        .on("end", resolve)
        .on("error", reject);
    });
    verifyDigest(key, parseSignature(asset.signature), hash.digest());
    console.log(`${platform}: ${asset.name} verifies against the app's update key.`);
  }
}

function main(argv) {
  const [command, ...args] = argv;
  const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  switch (command) {
    case "stage": {
      const [platform, version, buildDir, cliDir, outDir] = args;
      stagePlatform({ platform, version, buildDir, cliDir, outDir });
      return;
    }
    case "check": {
      const [directory, version, mode] = args;
      const missing = missingReleaseAssets(version, listReleaseAssets(directory), {
        signed: mode === "--signed",
      });
      if (missing.length > 0) {
        console.error(
          `Release ${version} is missing required assets:\n${missing.map((m) => `  - ${m}`).join("\n")}`,
        );
        process.exit(1);
      }
      return;
    }
    case "manifest": {
      const [directory, version, notesFile] = args;
      const assets = readSignedAssets(directory, version);
      const notes = notesFile ? fs.readFileSync(notesFile, "utf8") : "";
      fs.writeFileSync(
        path.join(directory, "latest.json"),
        JSON.stringify(manifest({ version, assets, notes, repository }), null, 2) + "\n",
      );
      return;
    }
    case "verify": {
      const [directory, version] = args;
      verifySignatures({
        directory,
        version,
        publicKey: process.env.GUSTAF_UPDATER_PUBLIC_KEY ?? "",
        appRoot: path.resolve(__dirname, "../.."),
      }).catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      });
      return;
    }
    case "notes": {
      const [version, previousTag, outFile] = args;
      if (!version || !outFile) {
        throw new Error("Usage: notes <version> <previous-tag|''> <out-file>");
      }
      const overridePath = path.join(__dirname, "../../docs/release-notes", `${version}.md`);
      const notes = releaseNotes({
        override: fs.existsSync(overridePath) ? fs.readFileSync(overridePath, "utf8") : undefined,
        titles: () => (previousTag ? mergedTitles(repository, previousTag, `v${version}`) : []),
      });
      fs.writeFileSync(outFile, notes);
      return;
    }
    default:
      throw new Error("Usage: gustaf-release.cjs <stage|check|manifest|verify|notes> ...");
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  classifyTitle,
  generateNotes,
  listReleaseAssets,
  manifest,
  missingReleaseAssets,
  platforms,
  releaseAssetName,
  releaseNotes,
  stagePlatform,
  verifySignatures,
};
