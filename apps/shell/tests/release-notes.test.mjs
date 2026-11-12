import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { classifyTitle, generateNotes, releaseNotes } from "../scripts/release-notes.mjs";

NodeTest.test("titles are cleaned and classified", () => {
  NodeAssert.deepEqual(classifyTitle("feat(api): add cloud API and Coolify deployment (#46)"), {
    kind: "feature",
    text: "Add cloud API and Coolify deployment",
  });
  NodeAssert.deepEqual(classifyTitle("feat!: drop old config"), {
    kind: "feature",
    text: "Drop old config",
  });
  NodeAssert.equal(classifyTitle("fix(ollama): new models show up (#47)")?.kind, "fix");
  NodeAssert.equal(classifyTitle("perf: faster sidebar")?.kind, "fix");
  for (const title of [
    "chore(release): bump Gustaf to 0.10.0",
    "ci: cache cargo",
    "docs: release notes",
    "test(web): cover card",
    "release: Gustaf 0.9.0",
    "refactor(server): split service",
    "Merge pull request #48 from Libes6/gustaf/release-0.10.0",
    "feat: (#12)",
  ]) {
    NodeAssert.equal(classifyTitle(title), null, title);
  }
});

NodeTest.test("features become at most seven bullets and fixes a closing count", () => {
  const titles = [
    ...Array.from({ length: 9 }, (_, index) => `feat: feature ${index}`),
    "fix: one",
    "perf: two",
    "chore: ignored",
  ];
  NodeAssert.equal(
    generateNotes(titles),
    [
      ...Array.from({ length: 7 }, (_, index) => `- Feature ${index}`),
      "",
      "Plus 2 bug fixes and improvements.",
      "",
    ].join("\n"),
  );
  NodeAssert.equal(generateNotes(["fix: one"]), "Plus 1 bug fix and improvements.\n");
  NodeAssert.equal(generateNotes(["chore: nothing", "docs: nothing"]), "");
  NodeAssert.equal(generateNotes([]), "");
});

NodeTest.test("a hand-written file wins over generated notes", () => {
  const titles = () => {
    throw Error("must not query merged pull requests");
  };
  NodeAssert.equal(
    releaseNotes({ override: "- **Title.** One sentence.\n\n", titles }),
    "- **Title.** One sentence.\n",
  );
  NodeAssert.equal(
    releaseNotes({ override: "  \n", titles: () => ["feat: generated"] }),
    "- Generated\n",
  );
  NodeAssert.equal(releaseNotes({ override: undefined, titles: () => [] }), "");
});
