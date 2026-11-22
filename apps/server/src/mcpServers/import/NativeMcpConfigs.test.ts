import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as NativeMcpConfigs from "./NativeMcpConfigs.ts";
import { findNativeDuplicate, nativeServersForProvider } from "./matcher.ts";
import {
  NativeMcpConfigError,
  parseClaudeConfig,
  parseCodexConfig,
  parseCursorConfig,
  parseGeminiConfig,
  parseProjectMcpConfig,
} from "./nativeMcp.ts";

const testLayer = NativeMcpConfigs.layer.pipe(Layer.provideMerge(NodeServices.layer));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-mcp-" });
  const homeDir = path.join(root, "home");
  const projectDir = path.join(root, "project");
  const write = Effect.fn("NativeMcpConfigsTest.write")(function* (file: string, text: string) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  });
  return { fs, path, homeDir, projectDir, write };
});

describe("NativeMcpConfigs", () => {
  it.effect(
    "reads all formats without modifying files, expanding secrets, or executing commands",
    () =>
      Effect.gen(function* () {
        const { fs, path, homeDir, projectDir, write } = yield* fixture;
        const files = [
          [
            path.join(homeDir, ".codex/config.toml"),
            `model = "codex"
[mcp_servers.local]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/with space"]
startup_timeout_sec = 30
[mcp_servers.local.env]
API_KEY = "literal-secret"
REFERENCE = "\u0024{TOKEN}"
[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "MCP_TOKEN"
[mcp_servers.remote.http_headers]
Authorization = "Bearer header-secret"
[mcp_servers.off]
command = "must-never-run"
enabled = false
[mcp_servers.computer-use]
command = "./Codex Computer Use.app/Contents/MacOS/Client"
args = ["mcp"]
cwd = "/Users/me/.codex/computer-use"
enabled = false
[mcp_servers.dot-cwd]
command = "./bin/server"
cwd = "."
`,
          ],
          [
            path.join(homeDir, ".cursor/mcp.json"),
            JSON.stringify({
              mcpServers: {
                cursor: {
                  command: "node",
                  args: ["server.js"],
                  env: { TOKEN: "cursor-secret" },
                  ignored: true,
                },
              },
            }),
          ],
          [
            path.join(projectDir, ".cursor/mcp.json"),
            JSON.stringify({
              mcpServers: {
                cursorProject: {
                  url: "https://cursor.example/mcp",
                  headers: { "X-Key": "secret" },
                },
              },
            }),
          ],
          [
            path.join(homeDir, ".claude.json"),
            JSON.stringify({
              mcpServers: { claude: { type: "stdio", command: "uvx", args: ["mcp-server-git"] } },
              projects: {
                [projectDir]: {
                  mcpServers: {
                    claudeLocal: {
                      type: "sse",
                      url: "https://claude.example/sse",
                      headers: { Authorization: "secret" },
                    },
                  },
                },
                "/another/project": { mcpServers: { other: { command: "other" } } },
              },
            }),
          ],
          [
            path.join(projectDir, ".mcp.json"),
            JSON.stringify({
              mcpServers: {
                project: {
                  command: "sh",
                  args: ["-c", "touch should-not-exist"],
                  env: { VALUE: "${UNCHANGED}" },
                },
              },
            }),
          ],
          [
            path.join(homeDir, ".gemini/settings.json"),
            JSON.stringify({
              theme: "dark",
              mcpServers: {
                geminiStdio: {
                  command: "python",
                  args: ["server.py"],
                  env: { TOKEN: "secret" },
                  trust: true,
                },
                geminiSse: { url: "https://gemini.example/sse" },
                geminiHttp: {
                  httpUrl: "https://gemini.example/mcp",
                  headers: { Authorization: "secret" },
                },
              },
            }),
          ],
        ] as const;
        for (const [file, text] of files) yield* write(file, text);
        const service = yield* NativeMcpConfigs.NativeMcpConfigs;
        const result = yield* service.list({ homeDir, projectDir });
        assert.deepEqual(result.errors, []);
        assert.equal(result.servers.length, 14);
        assert.deepInclude(
          result.servers.find((server) => server.name === "local"),
          {
            source: "codex",
            transport: "stdio",
            enabled: true,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/with space"],
            env: { API_KEY: "literal-secret", REFERENCE: "${TOKEN}" },
          },
        );
        assert.deepInclude(
          result.servers.find((server) => server.name === "remote"),
          {
            transport: "http",
            bearerTokenEnvVar: "MCP_TOKEN",
            headers: { Authorization: "Bearer header-secret" },
          },
        );
        assert.equal(result.servers.find((server) => server.name === "off")?.enabled, false);
        // Codex starts a relative command in the entry's cwd; only an absolute cwd says where.
        assert.deepInclude(
          result.servers.find((server) => server.name === "computer-use"),
          {
            enabled: false,
            command: "/Users/me/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/Client",
            cwd: "/Users/me/.codex/computer-use",
          },
        );
        assert.notProperty(
          result.servers.find((server) => server.name === "dot-cwd"),
          "cwd",
        );
        assert.deepInclude(
          result.servers.find((server) => server.name === "geminiHttp"),
          {
            transport: "http",
            url: "https://gemini.example/mcp",
            headers: { Authorization: "secret" },
          },
        );
        assert.deepInclude(
          result.servers.find((server) => server.name === "claudeLocal"),
          { projectDir },
        );
        assert.deepInclude(
          result.servers.find((server) => server.name === "cursorProject"),
          { projectDir },
        );
        for (const [file, text] of files) assert.equal(yield* fs.readFileString(file), text);
        assert.isFalse(yield* fs.exists(path.join(projectDir, "should-not-exist")));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "returns missing files as empty and isolates typed decode and read failures by path",
    () =>
      Effect.gen(function* () {
        const { fs, path, homeDir, projectDir, write } = yield* fixture;
        const service = yield* NativeMcpConfigs.NativeMcpConfigs;
        assert.deepEqual(yield* service.list({ homeDir, projectDir }), { servers: [], errors: [] });
        const tomlPath = path.join(homeDir, ".codex/config.toml");
        const jsonPath = path.join(homeDir, ".claude.json");
        const directoryPath = path.join(homeDir, ".cursor/mcp.json");
        yield* write(tomlPath, "[mcp_servers.broken\n");
        yield* write(jsonPath, '{"mcpServers":');
        yield* fs.makeDirectory(directoryPath, { recursive: true });
        yield* write(
          path.join(homeDir, ".gemini/settings.json"),
          '{"mcpServers":{"ok":{"command":"node"}}}',
        );
        const result = yield* service.list({ homeDir, projectDir });
        assert.deepEqual(
          result.servers.map((server) => server.name),
          ["ok"],
        );
        assert.equal(result.errors.length, 3);
        for (const error of result.errors) {
          assert.instanceOf(error, NativeMcpConfigError);
          assert.include(error.message, error.sourcePath);
        }
        assert.deepEqual(
          result.errors.map((error) => [error.sourcePath, error.operation]),
          [
            [tomlPath, "decode"],
            [directoryPath, "read"],
            [jsonPath, "decode"],
          ],
        );
        const codexHome = path.join(path.dirname(homeDir), "codex-home");
        yield* write(path.join(codexHome, "config.toml"), '[mcp_servers.custom]\ncommand = "node"');
        assert.deepEqual(
          (yield* service.list({ homeDir, codexHome })).servers
            .filter((server) => server.source === "codex")
            .map((server) => server.name),
          ["custom"],
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it("rejects malformed structures and ignores unknown fields", () => {
    const cases = [
      () => parseCodexConfig("[mcp_servers.bad]\ncommand = 42", "/codex"),
      () => parseCursorConfig('{"mcpServers":[]}', "/cursor"),
      () =>
        parseClaudeConfig(
          '{"projects":{"/app":{"mcpServers":{"bad":{"env":{"X":1}}}}}}',
          "/claude",
        ),
      () => parseGeminiConfig('{"mcpServers":{"bad":{"httpUrl":"file:///tmp/server"}}}', "/gemini"),
      () =>
        parseProjectMcpConfig(
          '{"mcpServers":{"bad":{"command":"node","args":[1]}}}',
          "/project",
          "/app",
        ),
    ];
    for (const parse of cases) assert.throws(parse, NativeMcpConfigError);
    assert.deepEqual(parseCursorConfig('{"unknown":{"token":"secret"}}', "/cursor"), []);
  });

  it("matches name plus normalized endpoint, retaining argument, path and query semantics", () => {
    const relative = parseCursorConfig('{"mcpServers":{"local":{"command":"./node"}}}', "/cursor");
    assert.isUndefined(
      findNativeDuplicate(
        { name: "local", transport: "stdio", command: "node", args: [] },
        relative,
      ),
    );
    const native = parseCursorConfig(
      JSON.stringify({
        mcpServers: {
          local: { command: "/usr/local/../bin/node", args: ["a b", "--flag"] },
          remote: { url: "https://EXAMPLE.com:443" },
          off: { command: "node", enabled: false },
          windows: { command: "C:\\tools\\..\\bin\\node.exe", args: [] },
        },
      }),
      "/cursor",
    );
    assert.equal(
      findNativeDuplicate(
        { name: "local", transport: "stdio", command: "/usr/bin/node", args: ["a b", "--flag"] },
        native,
      ),
      native[0],
    );
    assert.isUndefined(
      findNativeDuplicate(
        { name: "local", transport: "stdio", command: "/usr/bin/node", args: ["a", "b", "--flag"] },
        native,
      ),
    );
    assert.equal(
      findNativeDuplicate(
        { name: "windows", transport: "stdio", command: "C:/bin/node.exe", args: [] },
        native,
      ),
      native[3],
    );
    assert.equal(
      findNativeDuplicate(
        { name: "remote", transport: "http", url: "https://example.com/" },
        native,
      ),
      native[1],
    );
    for (const url of ["https://example.com/mcp", "https://example.com/?token=other", "invalid"])
      assert.isUndefined(findNativeDuplicate({ name: "remote", transport: "http", url }, native));
    assert.isUndefined(
      findNativeDuplicate(
        { name: "different", transport: "http", url: "https://example.com/" },
        native,
      ),
    );
    assert.equal(
      findNativeDuplicate({ name: "off", transport: "stdio", command: "node", args: [] }, native),
      native[2],
    );
  });

  it("selects providers and project overrides without treating unapproved project JSON as loaded", () => {
    const native = [
      ...parseCodexConfig('[mcp_servers.codex]\ncommand="codex-native"', "/codex"),
      ...parseGeminiConfig('{"mcpServers":{"gemini":{"command":"gemini-native"}}}', "/gemini"),
      ...parseCursorConfig(
        '{"mcpServers":{"same":{"command":"global"},"off":{"command":"global"}}}',
        "/cursor",
      ),
      ...parseCursorConfig(
        '{"mcpServers":{"same":{"command":"project"},"off":{"command":"project","disabled":true}}}',
        "/app/.cursor/mcp.json",
        "/app",
      ),
      ...parseClaudeConfig(
        '{"mcpServers":{"global":{"command":"global"}},"projects":{"/app":{"mcpServers":{"local":{"command":"local"}}},"/other":{"mcpServers":{"other":{"command":"other"}}}}}',
        "/claude",
      ),
      ...parseProjectMcpConfig(
        '{"mcpServers":{"shared":{"command":"shared"},"local":{"command":"shared-local"}}}',
        "/app/.mcp.json",
        "/app",
      ),
    ];
    assert.deepEqual(
      nativeServersForProvider("codex", native, "/app").map((server) => server.name),
      ["codex"],
    );
    assert.deepEqual(
      nativeServersForProvider("gemini", native, "/app").map((server) => server.name),
      ["gemini"],
    );
    const cursor = nativeServersForProvider("cursor", native, "/app/./");
    assert.equal(cursor.length, 1);
    assert.deepInclude(cursor[0], { name: "same", command: "project" });
    assert.deepEqual(
      nativeServersForProvider("claudeAgent", native, "/app").map((server) => server.name),
      ["global", "local"],
    );
    const claude = nativeServersForProvider("claudeAgent", native, "/app", {
      includeProjectMcpJson: true,
    });
    assert.deepEqual(
      claude.map((server) => server.name),
      ["global", "shared", "local"],
    );
    assert.deepInclude(
      claude.find((server) => server.name === "local"),
      { command: "local" },
    );
  });
});
