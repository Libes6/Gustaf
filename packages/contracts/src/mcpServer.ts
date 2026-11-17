import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceEnvironmentVariableName } from "./providerInstance.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

/** Providers see this id as the server's name; `t3-code*` and `ext` are names Gustaf passes itself. */
export const McpServerId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/),
  Schema.makeFilter(
    (id: string) =>
      (id !== "ext" && !id.startsWith("t3-code")) || "This MCP server id is reserved.",
  ),
).pipe(Schema.brand("McpServerId"));
export type McpServerId = typeof McpServerId.Type;

const AbsolutePath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, {
    message: "Expected an absolute path.",
  }),
);

const HttpUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }),
);

const HttpHeaderName = Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/));

export const McpStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Values are credentials: kept in the secret store and redacted for clients. */
  env: Schema.Record(ProviderInstanceEnvironmentVariableName, SettingsSecretValue).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  /** `thread` runs the server in the thread's working directory, its worktree when it has one. */
  cwd: Schema.Union([Schema.Literal("thread"), AbsolutePath]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("thread" as const)),
  ),
});
export type McpStdioTransport = typeof McpStdioTransport.Type;

export const McpHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: HttpUrl,
  /** Values are credentials, like stdio `env`. */
  headers: Schema.Record(HttpHeaderName, SettingsSecretValue).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});
export type McpHttpTransport = typeof McpHttpTransport.Type;

export const McpServerTransport = Schema.Union([McpStdioTransport, McpHttpTransport]);
export type McpServerTransport = typeof McpServerTransport.Type;

/** One user MCP server, keyed by its `McpServerId` in `ServerSettings.mcpServers`. */
export const McpServerConfig = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  transport: McpServerTransport,
});
export type McpServerConfig = typeof McpServerConfig.Type;

/** A project's switch for one server; absent inherits the server's own `enabled`. */
export const ProjectMcpServerOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type ProjectMcpServerOverride = typeof ProjectMcpServerOverride.Type;
