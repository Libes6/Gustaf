import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  compare,
  isExcluded,
  parseMessageTables,
  scanSource,
  updateBaseline,
} from "./i18n-audit.mjs";

const { describe, it } = NodeTest;
const texts = (src, options) => scanSource(src, options).findings.map((finding) => finding.text);

describe("scanSource", () => {
  it("reports literal JSX text and visible attributes", () => {
    const src = `
      export function Panel() {
        return (
          <div className="flex gap-2 text-sm" data-testid="panel-root">
            <h2>Connect your computers</h2>
            <input placeholder="Search threads" aria-label="Search" title={"Open in editor"} />
            <View accessibilityLabel="Close sheet" actionLabel="Retry now" />
            <Button>{busy ? "Saving…" : "Save"}</Button>
          </div>
        );
      }`;
    NodeAssert.deepEqual(texts(src), [
      "Connect your computers",
      "Search threads",
      "Search",
      "Open in editor",
      "Close sheet",
      "Retry now",
      "Saving…",
      "Save",
    ]);
  });

  it("skips copy that already goes through t()", () => {
    const src = `
      const t = useT();
      const el = <p title={t("misc.panel.title")}>{t("misc.panel.body")}</p>;
      Dialog.alert(t("Could not save"), t("Try again."));
      toastManager.add({ type: "error", title: t("Could not save") });`;
    const result = scanSource(src);
    NodeAssert.deepEqual(result.findings, []);
    NodeAssert.deepEqual(result.translated, [
      "misc.panel.title",
      "misc.panel.body",
      "Could not save",
      "Try again.",
      "Could not save",
    ]);
  });

  it("ignores numbers, URLs, identifiers, punctuation and class names", () => {
    const src = `
      const el = (
        <a href="https://example.com" className="text-muted-foreground px-2" title="https://t3.codes">
          {count} · 42 / {total} &nbsp;—
          <span title="primary-button" label="fooBar" aria-label="x">{"settings.general"}</span>
          {mode === "dark" ? "bg-black" : "bg-white"}
          <code>t3 pair --tailscale</code>
        </a>
      );`;
    NodeAssert.deepEqual(texts(src), []);
  });

  it("reports capitalized fields only inside toast and dialog calls", () => {
    const src = `
      toastManager.add({ type: "error", title: "Setting not saved", description: "Try again." });
      stackedThreadToast({ title: "Copied", description: \`\${n} files\` });
      requestConfirmDialog({ title: "Delete thread?", label: cond ? "Yes" : "No" });
      const option = { label: "Comfortable", title: "Not a notice" };
      toastManager.add({ title: "Lowercase " + name, message: "error-code" });
      Dialog.alert("Could not snooze thread", "This thread is working.");
      Alert.alert(title, "message-id");`;
    NodeAssert.deepEqual(texts(src, { jsx: false }), [
      "Setting not saved",
      "Try again.",
      "Copied",
      "Delete thread?",
      "Could not snooze thread",
      "This thread is working.",
    ]);
  });

  it("keeps sync through generics, regexes, templates and comments", () => {
    const src = `
      type Render = <T>(value: T) => void;
      const identity = <T,>(value: T) => value;
      const ratio = width / height / 2;
      const pattern = /<div>"not copy"<\\/div>/g;
      const label = \`<b>\${a < b ? "x" : <i>Nested</i>}</b>\`;
      // <p>Commented out</p>
      const el = <Foo<Bar> title="Generic component">{/* note */}Real text</Foo>;`;
    NodeAssert.deepEqual(texts(src), ["Nested", "Generic component", "Real text"]);
  });

  it("honours an i18n-ignore comment on the line or the line above", () => {
    const src = `
      const a = <span>Gustaf</span>; // i18n-ignore brand
      // i18n-ignore product name
      const b = <span>T3 Connect</span>;
      const c = <span>Still copy</span>;`;
    NodeAssert.deepEqual(texts(src), ["Still copy"]);
  });

  it("does not look for JSX in .ts files", () => {
    NodeAssert.deepEqual(texts("const ok = a <b> c;", { jsx: false }), []);
  });
});

describe("parseMessageTables", () => {
  it("reads the keys of each language table", () => {
    const tables = parseMessageTables(`export const m = {
  en: {
    "a.one": "One",
    "a.two":
      "Two \\"quoted\\"",
  },
  ru: {
    "a.one": "Один",
  },
} as const;`);
    NodeAssert.deepEqual([...tables.en], ["a.one", "a.two"]);
    NodeAssert.deepEqual([...tables.ru], ["a.one"]);
  });
});

describe("baseline", () => {
  const finding = (text, line = 1) => ({ kind: "jsx-text", text, line });
  const result = (files, missingRu = { web: [], mobile: [] }) => ({ files, missingRu });
  const baseline = {
    files: { "apps/web/src/A.tsx": ["Close", "Save"] },
    missingRu: { web: [], mobile: ["Old"] },
  };

  it("passes at or below the baseline", () => {
    const now = result({ "apps/web/src/A.tsx": [finding("Close")] }, { web: [], mobile: ["Old"] });
    NodeAssert.equal(compare(baseline, now).ok, true);
  });

  it("names exactly the new strings, including repeats, new files and missing keys", () => {
    const now = result(
      {
        "apps/web/src/A.tsx": [finding("Close", 3), finding("Save", 4), finding("Close", 9)],
        "apps/mobile/src/B.tsx": [finding("Hello", 2)],
      },
      { web: ["apps/web/src/i18nMessages/misc.ts: misc.x"], mobile: ["Old"] },
    );
    const { grown, missing, ok } = compare(baseline, now);
    NodeAssert.equal(ok, false);
    NodeAssert.deepEqual(
      grown.map((entry) => [entry.file, entry.added.map((f) => `${f.line}:${f.text}`)]),
      [
        ["apps/web/src/A.tsx", ["9:Close"]],
        ["apps/mobile/src/B.tsx", ["2:Hello"]],
      ],
    );
    NodeAssert.deepEqual(missing, {
      web: ["apps/web/src/i18nMessages/misc.ts: misc.x"],
      mobile: [],
    });
  });

  it("--update only lowers counts unless forced", () => {
    const now = result({
      "apps/web/src/A.tsx": [finding("Close"), finding("Save"), finding("New")],
      "apps/mobile/src/B.tsx": [finding("Hello")],
    });
    const kept = updateBaseline(baseline, now, false);
    NodeAssert.deepEqual(kept.files, { "apps/web/src/A.tsx": ["Close", "Save"] });
    NodeAssert.deepEqual(kept.missingRu, { web: [], mobile: [] });
    const forced = updateBaseline(baseline, now, true);
    NodeAssert.deepEqual(forced.files["apps/web/src/A.tsx"], ["Close", "New", "Save"]);
    NodeAssert.deepEqual(forced.totals.mobile, { files: 1, strings: 1 });
  });
});

describe("isExcluded", () => {
  it("skips tests, stories, message tables and generated files", () => {
    for (const file of [
      "apps/web/src/components/Foo.test.tsx",
      "apps/web/src/components/Foo.browser.test.tsx",
      "apps/web/src/components/Foo.stories.tsx",
      "apps/web/src/i18nMessages/misc.ts",
      "apps/web/src/i18n.ts",
      "apps/mobile/src/i18n/index.ts",
      "apps/web/src/routeTree.gen.ts",
      "apps/mobile/src/test-fixtures.ts",
    ]) {
      NodeAssert.equal(isExcluded(file), true, file);
    }
    NodeAssert.equal(isExcluded("apps/web/src/components/onboarding/WelcomeWizard.tsx"), false);
  });
});
