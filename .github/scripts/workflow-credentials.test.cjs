const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const { RELEASE_PACKAGE_FILES, setReleaseVersion } = require("./set-release-version.cjs");

const read = (path) => readFileSync(join(__dirname, "..", path), "utf8");

function jobs(path) {
  const body = read(path).split(/^jobs:\n/m)[1];
  const found = {};
  for (const block of body.split(/^(?=  [\w-]+:\n)/m)) {
    const name = /^  ([\w-]+):\n/.exec(block)?.[1];
    if (name) found[name] = block;
  }
  return found;
}

const release = jobs("workflows/gustaf-release.yml");

test("only the release job can write to the repository or sign updates", () => {
  for (const path of ["workflows/gustaf-release.yml", "workflows/gustaf-release-desktop.yml"]) {
    assert.match(
      read(path),
      /^permissions:\n {2}contents: read$/m,
      `${path} defaults to read-only`,
    );
    for (const [name, block] of Object.entries(jobs(path))) {
      if (name === "release") continue;
      assert.doesNotMatch(block, /contents: write|TAURI_SIGNING_PRIVATE_KEY/, `${path} ${name}`);
    }
  }
  assert.match(release.release, /^ {6}contents: write$/m);
  assert.match(
    release.release,
    /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/,
  );
});

test("the Android keystore is decoded only by the Android job", () => {
  for (const [name, block] of Object.entries(release)) {
    assert.equal(/ANDROID_KEYSTORE_BASE64/.test(block), name === "android", name);
  }
});

test("a manual run builds and signs but publishes nothing, and a tag run must match the code", () => {
  const publish = release.release.split(/^ {6}- name: Publish the release\n/m)[1];
  assert.match(publish, /^ {8}if: needs\.meta\.outputs\.publish == 'true'$/m);
  assert.match(release.meta, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(release.meta, /does not match apps\/desktop\/package\.json/);
  assert.match(release.meta, /merge-base --is-ancestor HEAD origin\/main/);
  assert.match(read("workflows/gustaf-release.yml"), /^ {4}tags: \["v\*\.\*\.\*"\]$/m);
});

test("every platform's build must succeed before anything is published", () => {
  assert.deepEqual(
    release.release
      .match(/needs: \[(.*)\]/)[1]
      .split(", ")
      .sort(),
    ["android", "desktop_linux", "desktop_macos", "desktop_windows", "meta"],
  );
});

test("the Vite+ toolchain is cached before the job installs or runs project code", () => {
  const names = Array.from(
    read("actions/setup-ci-deps/action.yml").matchAll(
      /^ {4}- name: (.+)\n(?: {6}.*\n)*? {6}uses: (\S+)|^ {4}- name: (.+)$/gm,
    ),
    (match) => ({ name: match[1] ?? match[3], uses: match[2] ?? "" }),
  );
  const index = (name) => names.findIndex((step) => step.name === name);
  assert.match(names[index("Restore Vite+")].uses, /^actions\/cache\/restore@/);
  assert.match(names[index("Save Vite+")].uses, /^actions\/cache\/save@/);
  assert.ok(index("Save Vite+") < index("Resolve pnpm store"));
  assert.ok(index("Save Vite+") < index("Install dependencies"));
  // The combined action saves at the end of the job, after everything ran.
  assert.ok(names.every((step) => !step.uses.startsWith("actions/cache@")));
});

test("a release version bump rewrites only the version of each release manifest", () => {
  const listed = /releasePackageFiles = \[\n([^\]]+)\]/.exec(
    read("../scripts/lib/tagged-source-version.ts"),
  )[1];
  assert.deepEqual(
    RELEASE_PACKAGE_FILES,
    Array.from(listed.matchAll(/"([^"]+)"/g), (m) => m[1]),
  );
  for (const file of RELEASE_PACKAGE_FILES) {
    const manifest = read(`../${file}`);
    const next = setReleaseVersion(manifest, "98.7.6");
    assert.equal(JSON.parse(next).version, "98.7.6");
    assert.deepEqual(
      { ...JSON.parse(next), version: "" },
      { ...JSON.parse(manifest), version: "" },
    );
    assert.equal(setReleaseVersion(next, "98.7.6"), next);
    assert.deepEqual(
      next.split("\n").filter((line, index) => line !== manifest.split("\n")[index]).length,
      1,
    );
  }
  for (const version of ["", "1", "1.2", "v1.2.3", '1.2.3", "x": "y']) {
    assert.throws(() => setReleaseVersion('{\n  "version": "1.0.0"\n}\n', version), /Invalid/);
  }
  assert.equal(
    setReleaseVersion('{\n  "version": "1.0.0"\n}\n', "1.2.3-rc.1"),
    '{\n  "version": "1.2.3-rc.1"\n}\n',
  );
  assert.throws(() => setReleaseVersion('{\n  "name": "x"\n}\n', "1.2.3"), /exactly one/);
});
