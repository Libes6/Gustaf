import { assert, it } from "@effect/vitest";
import { findNativeDuplicate } from "./matcher.ts";
import { parseCodexConfig, parseCursorConfig } from "./nativeMcp.ts";

it("keeps identical stdio commands in different working directories distinct", () => {
  const native = parseCursorConfig(
    JSON.stringify({
      mcpServers: {
        local: {
          command: "node",
          args: ["server.js"],
          cwd: "/first",
          env: { TEAM: "one" },
        },
      },
    }),
    "/cursor",
  );
  const candidate = {
    name: "local",
    transport: "stdio" as const,
    command: "node",
    args: ["server.js"],
    cwd: "/first",
    env: { TEAM: "one" },
  };
  assert.equal(findNativeDuplicate(candidate, native), native[0]);
  const { cwd: _cwd, ...withoutCwd } = candidate;
  for (const changed of [
    { ...candidate, cwd: "/second" },
    { ...candidate, env: { TEAM: "two" } },
    withoutCwd,
  ]) {
    assert.isUndefined(findNativeDuplicate(changed, native));
  }
});

it("matches HTTP endpoints only with the same headers and auth source", () => {
  const native = parseCodexConfig(
    '[mcp_servers.remote]\nurl="https://EXAMPLE.com:443"\nbearer_token_env_var="TOKEN"\n[mcp_servers.remote.http_headers]\nX-Team="one"',
    "/codex",
  );
  const candidate = {
    name: "remote",
    transport: "http" as const,
    url: "https://example.com/",
    bearerTokenEnvVar: "TOKEN",
    headers: { "x-team": "one" },
  };
  assert.equal(findNativeDuplicate(candidate, native), native[0]);
  assert.isUndefined(findNativeDuplicate({ ...candidate, bearerTokenEnvVar: "OTHER" }, native));
  assert.isUndefined(findNativeDuplicate({ ...candidate, headers: { "x-team": "two" } }, native));
});
