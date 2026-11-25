const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  classifyTitle,
  generateNotes,
  manifest,
  missingReleaseAssets,
  releaseAssetName,
  releaseNotes,
  stagePlatform,
  verifySignatures,
} = require("./gustaf-release.cjs");

const v = "1.2.3";
const fixtures = path.join(__dirname, "../../apps/desktop/src/updates/fixtures");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gustaf-release-test-"));

const full = {
  "darwin-aarch64": [
    `Gustaf-${v}-macOS-arm64.dmg`,
    `Gustaf-${v}-macOS-arm64.app.tar.gz`,
    `t3-${v}-darwin-arm64.tar.gz`,
  ],
  "windows-x86_64": [`Gustaf-${v}-Windows-x64-setup.exe`, `t3-${v}-win32-x64.zip`],
  "linux-x86_64": [`Gustaf-${v}-Linux-x64.AppImage`, `t3-${v}-linux-x64.tar.gz`],
  root: [],
};
const withSignatures = {
  ...full,
  "darwin-aarch64": [...full["darwin-aarch64"], `Gustaf-${v}-macOS-arm64.app.tar.gz.sig`],
  "windows-x86_64": [...full["windows-x86_64"], `Gustaf-${v}-Windows-x64-setup.exe.sig`],
  "linux-x86_64": [...full["linux-x86_64"], `Gustaf-${v}-Linux-x64.AppImage.sig`],
  root: ["latest.json"],
};

test("build outputs get their release names, signatures keep theirs, other files are skipped", () => {
  assert.equal(
    releaseAssetName("darwin-aarch64", v, "Gustaf-1.2.3-arm64.dmg"),
    `Gustaf-${v}-macOS-arm64.dmg`,
  );
  assert.equal(
    releaseAssetName("windows-x86_64", v, "Gustaf-1.2.3-x64.exe"),
    `Gustaf-${v}-Windows-x64-setup.exe`,
  );
  assert.equal(
    releaseAssetName("windows-x86_64", v, "Gustaf-1.2.3-x64.exe.sig"),
    `Gustaf-${v}-Windows-x64-setup.exe.sig`,
  );
  assert.equal(
    releaseAssetName("linux-x86_64", v, "Gustaf-1.2.3-x86_64.AppImage"),
    `Gustaf-${v}-Linux-x64.AppImage`,
  );
  assert.equal(
    releaseAssetName("linux-x86_64", v, "Gustaf-1.2.3-amd64.deb"),
    `Gustaf-${v}-Linux-x64.deb`,
  );
  for (const skipped of [
    "Gustaf-1.2.3-x64.exe.blockmap",
    "latest.yml",
    "builder-debug.yml",
    "Gustaf-1.2.3-arm64.zip",
  ]) {
    assert.equal(releaseAssetName("windows-x86_64", v, skipped), null, skipped);
  }
  assert.throws(() => releaseAssetName("darwin-aarch64", "1.2", "x.dmg"));
  assert.throws(() => releaseAssetName("plan9", v, "x.dmg"));
});

test("a complete release has nothing missing", () => {
  assert.deepEqual(missingReleaseAssets(v, full), []);
  assert.deepEqual(missingReleaseAssets(v, withSignatures, { signed: true }), []);
});

test("every missing file is named", () => {
  const broken = {
    ...withSignatures,
    "darwin-aarch64": [`Gustaf-${v}-macOS-arm64.dmg`],
    "windows-x86_64": [`Gustaf-${v}-Windows-x64-setup.exe`, `t3-${v}-win32-x64.zip`],
    root: [],
  };
  assert.deepEqual(missingReleaseAssets(v, broken, { signed: true }), [
    "darwin-aarch64: *.app.tar.gz",
    "darwin-aarch64: *.app.tar.gz.sig",
    `darwin-aarch64: t3-${v}-darwin-arm64.tar.gz`,
    "windows-x86_64: *-setup.exe.sig",
    "latest.json",
  ]);
  assert.equal(missingReleaseAssets("9.9.9", full).length, 7);
});

const signed = (name) => ({ name, signature: "c2lnbmF0dXJl" });
const assets = {
  "darwin-aarch64": signed(`Gustaf-${v}-macOS-arm64.app.tar.gz`),
  "windows-x86_64": signed(`Gustaf-${v}-Windows-x64-setup.exe`),
  "linux-x86_64": signed(`Gustaf-${v}-Linux-x64.AppImage`),
};

test("latest.json lists each platform's signed update file on this repository's release", () => {
  const result = manifest({ version: v, assets, notes: "- A\n", date: "2026-01-02T03:04:05Z" });
  assert.deepEqual(Object.keys(result), ["version", "notes", "pub_date", "platforms"]);
  assert.equal(result.version, v);
  assert.equal(result.notes, "- A\n");
  assert.equal(result.pub_date, "2026-01-02T03:04:05Z");
  assert.deepEqual(result.platforms["windows-x86_64"], {
    signature: "c2lnbmF0dXJl",
    url: `https://github.com/Libes6/Gustaf/releases/download/v${v}/Gustaf-${v}-Windows-x64-setup.exe`,
  });
  assert.match(
    manifest({ version: v, assets, repository: "me/fork" }).platforms["linux-x86_64"].url,
    /^https:\/\/github\.com\/me\/fork\//,
  );
});

test("latest.json is refused when a platform is missing, unsigned, or mislabeled", () => {
  for (const bad of [
    { ...assets, "linux-x86_64": undefined },
    { ...assets, "linux-x86_64": { ...assets["linux-x86_64"], signature: "" } },
    { ...assets, "linux-x86_64": { ...assets["linux-x86_64"], signature: "not base64!" } },
    { ...assets, "linux-x86_64": signed(`Gustaf-${v}-Linux-x64.deb`) },
    { ...assets, "linux-x86_64": assets["windows-x86_64"] },
  ]) {
    assert.throws(() => manifest({ version: v, assets: bad }));
  }
  assert.throws(() => manifest({ version: "1.2", assets }));
  assert.throws(() => manifest({ version: v, assets, date: "yesterday" }));
});

test("staging a Linux build keeps the AppImage, deb and CLI archive and drops the rest", () => {
  const root = tmp();
  try {
    const build = path.join(root, "release");
    const cli = path.join(root, "cli");
    fs.mkdirSync(build);
    fs.mkdirSync(cli);
    for (const name of [
      "Gustaf-1.2.3-x86_64.AppImage",
      "Gustaf-1.2.3-amd64.deb",
      "latest-linux.yml",
      "builder-debug.yml",
    ]) {
      fs.writeFileSync(path.join(build, name), name);
    }
    fs.writeFileSync(path.join(cli, `t3-${v}-linux-x64.tar.gz`), "cli");
    const out = path.join(root, "out");
    stagePlatform({
      platform: "linux-x86_64",
      version: v,
      buildDir: build,
      cliDir: cli,
      outDir: out,
    });
    assert.deepEqual(fs.readdirSync(out).sort(), [
      `Gustaf-${v}-Linux-x64.AppImage`,
      `Gustaf-${v}-Linux-x64.deb`,
      `t3-${v}-linux-x64.tar.gz`,
    ]);
    assert.throws(
      () =>
        stagePlatform({
          platform: "linux-x86_64",
          version: v,
          buildDir: build,
          cliDir: path.join(root, "none"),
          outDir: path.join(root, "out2"),
        }),
      /Missing CLI archive/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "staging a macOS build packs the .app from the zip into a tarball that unpacks to the same app",
  { skip: os.platform() !== "darwin" },
  () => {
    const root = tmp();
    try {
      const build = path.join(root, "release");
      const cli = path.join(root, "cli");
      const app = path.join(root, "src", "Gustaf.app", "Contents", "MacOS");
      fs.mkdirSync(build);
      fs.mkdirSync(cli);
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, "Gustaf"), "#!/bin/sh\n", { mode: 0o755 });
      fs.symlinkSync("Gustaf", path.join(app, "link"));
      execFileSync("ditto", [
        "-c",
        "-k",
        "--keepParent",
        path.join(root, "src", "Gustaf.app"),
        path.join(build, "Gustaf-1.2.3-arm64.zip"),
      ]);
      fs.writeFileSync(path.join(build, "Gustaf-1.2.3-arm64.dmg"), "dmg");
      fs.writeFileSync(path.join(cli, `t3-${v}-darwin-arm64.tar.gz`), "cli");
      const out = path.join(root, "out");
      stagePlatform({
        platform: "darwin-aarch64",
        version: v,
        buildDir: build,
        cliDir: cli,
        outDir: out,
      });
      assert.deepEqual(fs.readdirSync(out).sort(), [
        `Gustaf-${v}-macOS-arm64.app.tar.gz`,
        `Gustaf-${v}-macOS-arm64.dmg`,
        `t3-${v}-darwin-arm64.tar.gz`,
      ]);
      const unpacked = path.join(root, "unpacked");
      fs.mkdirSync(unpacked);
      execFileSync("tar", [
        "-xzf",
        path.join(out, `Gustaf-${v}-macOS-arm64.app.tar.gz`),
        "-C",
        unpacked,
      ]);
      const bin = path.join(unpacked, "Gustaf.app", "Contents", "MacOS");
      assert.equal(fs.readFileSync(path.join(bin, "Gustaf"), "utf8"), "#!/bin/sh\n");
      assert.equal(fs.statSync(path.join(bin, "Gustaf")).mode & 0o111, 0o111);
      assert.equal(fs.readlinkSync(path.join(bin, "link")), "Gustaf");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

function signedDirectory(content = fs.readFileSync(path.join(fixtures, "payload2.txt"))) {
  const root = tmp();
  const names = {
    "darwin-aarch64": `Gustaf-${v}-macOS-arm64.app.tar.gz`,
    "windows-x86_64": `Gustaf-${v}-Windows-x64-setup.exe`,
    "linux-x86_64": `Gustaf-${v}-Linux-x64.AppImage`,
  };
  for (const [platform, name] of Object.entries(names)) {
    fs.mkdirSync(path.join(root, platform));
    fs.writeFileSync(path.join(root, platform, name), content);
    fs.copyFileSync(
      path.join(fixtures, "payload2.txt.sig"),
      path.join(root, platform, `${name}.sig`),
    );
  }
  return root;
}
const appRoot = path.resolve(__dirname, "../..");
const signerKey = fs.readFileSync(path.join(fixtures, "signer.pub"), "utf8");

test("signatures made by the Tauri signer verify with the app's own verifier", async () => {
  const root = signedDirectory();
  try {
    await verifySignatures({ directory: root, version: v, publicKey: signerKey, appRoot });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a different key, a swapped file, or a missing key fails signature verification", async () => {
  const root = signedDirectory();
  const swapped = signedDirectory(fs.readFileSync(path.join(fixtures, "payload.txt")));
  try {
    const otherKey = fs.readFileSync(path.join(fixtures, "other-signer.pub"), "utf8");
    await assert.rejects(
      verifySignatures({ directory: root, version: v, publicKey: otherKey, appRoot }),
    );
    await assert.rejects(
      verifySignatures({ directory: swapped, version: v, publicKey: signerKey, appRoot }),
    );
    await assert.rejects(verifySignatures({ directory: root, version: v, publicKey: "", appRoot }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(swapped, { recursive: true, force: true });
  }
});

test("titles are cleaned and classified", () => {
  assert.deepEqual(classifyTitle("feat(api): add cloud API and Coolify deployment (#46)"), {
    kind: "feature",
    text: "Add cloud API and Coolify deployment",
  });
  assert.deepEqual(classifyTitle("feat!: drop old config"), {
    kind: "feature",
    text: "Drop old config",
  });
  assert.equal(classifyTitle("fix(ollama): new models show up (#47)")?.kind, "fix");
  assert.equal(classifyTitle("perf: faster sidebar")?.kind, "fix");
  for (const title of [
    "chore(release): bump Gustaf to 0.10.0",
    "ci: cache cargo",
    "docs: release notes",
    "test(web): cover card",
    "refactor(server): split service",
    "Merge pull request #48 from Libes6/gustaf/release-0.10.0",
    "feat: (#12)",
  ]) {
    assert.equal(classifyTitle(title), null, title);
  }
});

test("features become at most seven bullets and fixes a closing count", () => {
  const titles = [
    ...Array.from({ length: 9 }, (_, index) => `feat: feature ${index}`),
    "fix: one",
    "perf: two",
    "chore: ignored",
  ];
  assert.equal(
    generateNotes(titles),
    [
      ...Array.from({ length: 7 }, (_, index) => `- Feature ${index}`),
      "",
      "Plus 2 bug fixes and improvements.",
      "",
    ].join("\n"),
  );
  assert.equal(generateNotes(["fix: one"]), "Plus 1 bug fix and improvements.\n");
  assert.equal(generateNotes(["chore: nothing"]), "");
  assert.equal(generateNotes([]), "");
});

test("a hand-written file wins over generated notes", () => {
  const titles = () => {
    throw new Error("must not query merged pull requests");
  };
  assert.equal(
    releaseNotes({ override: "- **Title.** One sentence.\n\n", titles }),
    "- **Title.** One sentence.\n",
  );
  assert.equal(
    releaseNotes({ override: "  \n", titles: () => ["feat: generated"] }),
    "- Generated\n",
  );
  assert.equal(releaseNotes({ override: undefined, titles: () => [] }), "");
});
