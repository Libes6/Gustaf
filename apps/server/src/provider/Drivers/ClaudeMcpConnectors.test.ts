import { describe, expect, it } from "vite-plus/test";

import { claudeMcpConnector } from "./ClaudeMcpConnectors.ts";

describe("claudeMcpConnector", () => {
  it.each([
    {
      status: {
        name: "claude.ai Figma",
        status: "needs-auth",
        config: { type: "claudeai-proxy", url: "https://mcp.example/figma", id: "srv_1" },
        source: "claudeai",
      },
      expected: {
        name: "claude.ai Figma",
        status: "needs-auth",
        auth: "claudeai",
        source: "claudeai",
      },
    },
    {
      // CLIs before `source` report only the scope.
      status: {
        name: "linear",
        status: "needs-auth",
        config: { type: "http", url: "https://mcp.example/linear" },
        scope: "user",
      },
      expected: { name: "linear", status: "needs-auth", auth: "oauth", source: "user" },
    },
    {
      status: {
        name: "local-tool",
        status: "connected",
        config: { type: "stdio", command: "tool" },
        source: "project",
      },
      expected: { name: "local-tool", status: "connected", auth: "none", source: "project" },
    },
  ] as const)("maps $status.name", ({ status, expected }) => {
    expect(claudeMcpConnector(status, false)).toEqual({ ...expected, authorizing: false });
  });

  it("leaves out servers Gustaf registers itself", () => {
    expect(
      claudeMcpConnector({ name: "t3-code", status: "connected", source: "sdk" }, false),
    ).toBeUndefined();
    expect(
      claudeMcpConnector({ name: "figma-gustaf", status: "needs-auth", source: "dynamic" }, false),
    ).toBeUndefined();
  });
});
