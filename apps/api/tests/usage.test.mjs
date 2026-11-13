import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { BadRequestException } from "@nestjs/common";
import { periodStart, readUsagePeriod, readUsageReport } from "../dist/usage/usage-rules.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const batchId = "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const bucket = (overrides = {}) => ({
  day: "2026-11-13",
  provider: "codex",
  model: "gpt-6.1",
  turns: 3,
  measuredTurns: 2,
  inputTokens: 1200,
  outputTokens: 300,
  ...overrides,
});
const read = (buckets, extra = {}) => readUsageReport({ batchId, buckets, ...extra }, NOW);

NodeTest.test("a usage report keeps counts and stores an unnamed model as ''", () => {
  NodeAssert.deepEqual(
    read([bucket(), bucket({ model: null, measuredTurns: 0, inputTokens: 0, outputTokens: 0 })]),
    {
      batchId,
      buckets: [
        bucket(),
        { ...bucket(), model: "", measuredTurns: 0, inputTokens: 0, outputTokens: 0 },
      ],
    },
  );
});

NodeTest.test(
  "a usage report rejects content-shaped, unknown-as-zero and out-of-range input",
  () => {
    const rejected = [
      { batchId: "not-a-uuid", buckets: [bucket()] },
      { batchId, buckets: [] },
      { batchId, buckets: [bucket({ provider: "codex prompt: fix the bug" })] },
      { batchId, buckets: [bucket({ model: "/Users/me/models/llama.gguf" })] },
      {
        batchId,
        buckets: [bucket({ turns: 0, measuredTurns: 0, inputTokens: 0, outputTokens: 0 })],
      },
      { batchId, buckets: [bucket({ measuredTurns: 4 })] },
      { batchId, buckets: [bucket({ measuredTurns: 0 })] }, // tokens without a measured turn
      { batchId, buckets: [bucket({ inputTokens: -1 })] },
      { batchId, buckets: [bucket({ outputTokens: 1.5 })] },
      { batchId, buckets: [bucket({ day: "2026-02-30" })] },
      { batchId, buckets: [bucket({ day: "2026-13-01" })] },
      { batchId, buckets: [bucket({ day: "2026-10-01" })] }, // older than 31 days
      { batchId, buckets: [bucket({ day: "2026-11-15" })] }, // past tomorrow
      { batchId, buckets: [bucket(), bucket({ turns: 1, measuredTurns: 1 })] }, // repeated key
    ];
    for (const body of rejected) {
      NodeAssert.throws(
        () => readUsageReport(body, NOW),
        BadRequestException,
        JSON.stringify(body),
      );
    }
  },
);

NodeTest.test("summary periods are whole UTC days ending today", () => {
  NodeAssert.equal(readUsagePeriod(undefined), 30);
  NodeAssert.equal(readUsagePeriod("7"), 7);
  for (const value of ["0", "14", "abc", "365"]) {
    NodeAssert.throws(() => readUsagePeriod(value), BadRequestException);
  }
  NodeAssert.equal(periodStart(1, NOW), "2026-11-13");
  NodeAssert.equal(periodStart(7, NOW), "2026-11-07");
});
