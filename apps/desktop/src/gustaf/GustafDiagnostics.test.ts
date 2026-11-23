// @effect-diagnostics nodeBuiltinImport:off -- Diagnostics fixture reads and removes isolated temporary log files synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  collectDiagnostics,
  failedSpans,
  redactLine,
  redactText,
  tailBytes,
} from "./GustafDiagnostics.ts";

describe("GustafDiagnostics", () => {
  describe("redactLine", () => {
    it("redacts key-value credentials across equals and colon forms", () => {
      assert.equal(redactLine("auth token=abc user=alice"), "auth token=[redacted] user=alice");
      assert.equal(
        redactLine("api_key: \"secret-123\" password='hunter2'"),
        "api_key: \"[redacted]\" password='[redacted]'",
      );
      assert.equal(redactLine('{"token":"tok_xyz","ok":true}'), '{"token":"[redacted]","ok":true}');
    });

    it("redacts Authorization Bearer and standalone Bearer credentials", () => {
      assert.equal(
        redactLine("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload1234567890.sig"),
        "Authorization: [redacted]",
      );
      assert.equal(
        redactLine("header authorization=Bearer secret-token-value next=ok"),
        "header authorization=[redacted] next=ok",
      );
      assert.equal(redactLine("Bearer standalone-secret-value"), "Bearer [redacted]");
    });

    it.each([
      {
        name: "sk- token",
        input: "key sk-1234567890abcdef done",
        expected: "key [redacted] done",
      },
      {
        name: "ghp_ token",
        input: "pat ghp_1234567890abcdef done",
        expected: "pat [redacted] done",
      },
      {
        name: "gdt_ token",
        input: "device gdt_1234567890abcdef done",
        expected: "device [redacted] done",
      },
      {
        name: "eyJ JWT token",
        input: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig done",
        expected: "jwt [redacted] done",
      },
      {
        name: "short non-token prefix",
        input: "note sk-short stays visible",
        expected: "note sk-short stays visible",
      },
    ])("handles known token prefixes: $name", ({ input, expected }) => {
      assert.equal(redactLine(input), expected);
    });
  });

  describe("redactText", () => {
    it("replaces homeDir with ~ and redacts secrets across lines", () => {
      const input = [
        "cwd=/Users/alice/projects/t3",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload1234567890.sig",
        "token=abc home=/Users/alice/.config",
      ].join("\n");

      assert.equal(
        redactText(input, "/Users/alice"),
        ["cwd=~/projects/t3", "Authorization: [redacted]", "token=[redacted] home=~/.config"].join(
          "\n",
        ),
      );
    });

    it("ignores single-character homeDir values such as /", () => {
      assert.equal(
        redactText("/var/log/desktop.log token=abc", "/"),
        "/var/log/desktop.log token=[redacted]",
      );
    });
  });

  describe("failedSpans", () => {
    it("keeps only failure exit lines and truncates long lines to 4000 chars", () => {
      const longMessage = "x".repeat(4500);
      const trace = [
        '{"name":"ok","exit":{"_tag":"Success"}}',
        `{"name":"boom","detail":"${longMessage}","exit":{"_tag":"Failure","cause":"err"}}`,
        '{"name":"also-ok","exit":{"_tag":"Success"}}',
        '{"name":"second-fail","exit":{"_tag":"Failure"}}',
      ].join("\n");

      const result = failedSpans(trace);
      const lines = result.split("\n");
      assert.equal(lines.length, 2);
      assert.equal(lines[0]!.length, 4000);
      assert.isTrue(lines[0]!.startsWith('{"name":"boom"'));
      assert.equal(lines[1], '{"name":"second-fail","exit":{"_tag":"Failure"}}');
    });

    it("returns an empty string when no failure spans exist", () => {
      assert.equal(failedSpans('{"name":"ok","exit":{"_tag":"Success"}}'), "");
    });
  });

  describe("tailBytes", () => {
    it("returns text unchanged when within maxBytes", () => {
      assert.equal(tailBytes("hello\nworld", 11), "hello\nworld");
      assert.equal(tailBytes("hello\nworld", 64), "hello\nworld");
    });

    it("aligns cut output to the next newline when a newline follows the cut", () => {
      const text = "first-line\nsecond-line\nthird-line";
      assert.equal(tailBytes(text, 20), "third-line");
      assert.equal(tailBytes(text, 25), "second-line\nthird-line");
    });

    it("skips UTF-8 continuation bytes at the cut boundary without emitting replacement characters", () => {
      const singleLine = "🚀abcdefghij";
      assert.equal(Buffer.byteLength(singleLine, "utf8"), 14);
      const slicedSingleLine = tailBytes(singleLine, 12);
      assert.isFalse(slicedSingleLine.includes("\uFFFD"));
      assert.equal(slicedSingleLine, "abcdefghij");

      const multiLine = "🚀first\nsecond\nthird";
      assert.equal(Buffer.byteLength(multiLine, "utf8"), 22);
      const slicedMultiLine = tailBytes(multiLine, 20);
      assert.isFalse(slicedMultiLine.includes("\uFFFD"));
      assert.equal(slicedMultiLine, "second\nthird");
    });
  });

  describe("collectDiagnostics", () => {
    it("returns null for an empty or missing log directory", () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gustaf-diag-empty-"));
      try {
        assert.isNull(collectDiagnostics(dir));
        assert.isNull(collectDiagnostics(NodePath.join(dir, "missing")));
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reads desktop.log and server.trace.ndjson, filters failures, normalizes homeDir, and redacts secrets", () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gustaf-diag-full-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(dir, "desktop.log"),
          [
            "booting /Users/alice/app",
            "header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload1234567890.sig",
            "secret token=abc sk-1234567890abcdef",
          ].join("\n"),
          "utf8",
        );
        NodeFS.writeFileSync(
          NodePath.join(dir, "server.trace.ndjson"),
          [
            '{"name":"healthy","exit":{"_tag":"Success"}}',
            '{"name":"request","path":"/Users/alice/repo","token":"ghp_1234567890abcdef","exit":{"_tag":"Failure"}}',
          ].join("\n"),
          "utf8",
        );

        const report = collectDiagnostics(dir, "/Users/alice");
        assert.isNotNull(report);
        assert.equal(
          report,
          [
            "== Shell and server output ==",
            "booting ~/app",
            "header Authorization: [redacted]",
            "secret token=[redacted] [redacted]",
            "",
            "== Recent failed server operations ==",
            '{"name":"request","path":"~/repo","token":"[redacted]","exit":{"_tag":"Failure"}}',
          ].join("\n"),
        );
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("omits empty sections and tails oversized logs to the section byte budget", () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gustaf-diag-cap-"));
      try {
        const line = `${"a".repeat(999)}\n`;
        const oversizedLog = line.repeat(120);
        NodeFS.writeFileSync(NodePath.join(dir, "desktop.log"), oversizedLog, "utf8");
        NodeFS.writeFileSync(
          NodePath.join(dir, "server.trace.ndjson"),
          '{"name":"ok","exit":{"_tag":"Success"}}\n',
          "utf8",
        );

        const report = collectDiagnostics(dir);
        assert.isNotNull(report);
        assert.isTrue(report!.startsWith("== Shell and server output ==\n"));
        assert.isFalse(report!.includes("== Recent failed server operations =="));
        const body = report!.slice("== Shell and server output ==\n".length);
        assert.isAtMost(Buffer.byteLength(body, "utf8"), 100 * 1024);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
