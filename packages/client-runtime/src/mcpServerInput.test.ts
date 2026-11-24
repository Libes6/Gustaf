import { describe, expect, it } from "@effect/vitest";
import { parseMcpServerJson } from "./mcpServerInput.ts";

describe("parseMcpServerJson", () => {
  it("imports native transports disabled with literal secrets", () => {
    const result = parseMcpServerJson(
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["server.js"], env: { TOKEN: "secret" } },
          remote: { url: "https://example.com/mcp", headers: { Authorization: "secret" } },
        },
      }),
    );
    expect(result.local).toMatchObject({
      enabled: false,
      transport: { type: "stdio", env: { TOKEN: "secret" }, cwd: "thread" },
    });
    expect(result.remote).toMatchObject({
      enabled: false,
      transport: { type: "http", headers: { Authorization: "secret" } },
    });
  });
  it("rejects invalid ids instead of silently dropping entries", () => {
    for (const id of ["Bad ID", "ext", "t3-code-user"]) {
      expect(() =>
        parseMcpServerJson(JSON.stringify({ mcpServers: { [id]: { command: "node" } } })),
      ).toThrow();
    }
    expect(() =>
      parseMcpServerJson('{"mcpServers":{"valid":{"url":"file:///tmp/mcp"}}}'),
    ).toThrow();
  });
});
