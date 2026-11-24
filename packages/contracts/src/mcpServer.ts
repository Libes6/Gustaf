import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  ProviderInstanceId,
} from "./providerInstance.ts";
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
  /** Driver kinds whose sessions get this server; absent means every provider. */
  providers: Schema.optionalKey(Schema.Array(ProviderDriverKind)),
  /** Tool names providers must not offer; tools the server adds later stay on. */
  disabledTools: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type McpServerConfig = typeof McpServerConfig.Type;

/** Drivers whose sessions honor `disabledTools`; the others get every tool of the server. */
export const MCP_TOOL_FILTER_DRIVERS: ReadonlyArray<ProviderDriverKind> = [
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
];

/** A project's switch for one server; absent inherits the server's own `enabled`. */
export const ProjectMcpServerOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type ProjectMcpServerOverride = typeof ProjectMcpServerOverride.Type;

export const McpImportSource = Schema.Literals([
  "codex",
  "cursor",
  "claude",
  "gemini",
  "project-mcp-json",
]);
export type McpImportSource = typeof McpImportSource.Type;

/** Which native entry to import: `projectDir` tells Claude's per-project entries apart. */
export const McpImportEntryKey = Schema.Struct({
  source: McpImportSource,
  name: Schema.String,
  projectDir: Schema.optionalKey(Schema.String),
});
export type McpImportEntryKey = typeof McpImportEntryKey.Type;

/** A server another agent's config defines. Env and header values never leave the environment. */
export const McpImportableServer = Schema.Struct({
  ...McpImportEntryKey.fields,
  sourcePath: Schema.String,
  /** The id it would get here; may still fail `McpServerId`, so clients validate it. */
  suggestedId: Schema.String,
  enabledInSource: Schema.Boolean,
  transport: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("stdio"),
      command: Schema.String,
      args: Schema.Array(Schema.String),
      envKeys: Schema.Array(Schema.String),
    }),
    Schema.Struct({
      type: Schema.Literal("http"),
      url: Schema.String,
      headerKeys: Schema.Array(Schema.String),
      /** Codex reads the bearer token from this variable; importing does not carry it over. */
      bearerTokenEnvVar: Schema.optionalKey(Schema.String),
    }),
  ]),
  /** A Gustaf server already runs the same command and arguments, or the same URL. */
  alreadyInGustaf: Schema.Boolean,
});
export type McpImportableServer = typeof McpImportableServer.Type;

export const McpListImportableInput = Schema.Struct({
  /** Also reads the project's `.mcp.json` and `.cursor/mcp.json`. */
  projectDir: Schema.optionalKey(TrimmedNonEmptyString),
});
export type McpListImportableInput = typeof McpListImportableInput.Type;

export const McpListImportableResult = Schema.Struct({
  servers: Schema.Array(McpImportableServer),
  /** Config files that exist but could not be read. */
  unreadablePaths: Schema.Array(Schema.String),
});
export type McpListImportableResult = typeof McpListImportableResult.Type;

export const McpImportInput = Schema.Struct({
  projectDir: Schema.optionalKey(TrimmedNonEmptyString),
  entries: Schema.NonEmptyArray(
    Schema.Struct({
      ...McpImportEntryKey.fields,
      id: McpServerId,
      /** Declared so the required grant is known before the server reads the entry. */
      transport: Schema.Literals(["stdio", "http"]),
    }),
  ),
});
export type McpImportInput = typeof McpImportInput.Type;

export const McpImportResult = Schema.Struct({ imported: Schema.Array(McpServerId) });
export type McpImportResult = typeof McpImportResult.Type;

export class McpServerImportError extends Schema.TaggedError<McpServerImportError>()(
  "McpServerImportError",
  {
    reason: Schema.Literals([
      "entry-not-found",
      "transport-mismatch",
      "id-taken",
      "invalid-entry",
      "local-servers-disallowed",
      "settings",
    ]),
    id: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const subject = this.id === undefined ? "An MCP server" : `MCP server "${this.id}"`;
    switch (this.reason) {
      case "entry-not-found":
        return `${subject} is no longer in its source config.`;
      case "transport-mismatch":
        return `${subject} changed transport in its source config.`;
      case "id-taken":
        return `${subject} already exists.`;
      case "invalid-entry":
        return `${subject} cannot be imported: its command, URL, or a key is not valid here.`;
      case "local-servers-disallowed":
        return "Your organization's policy does not allow local MCP servers.";
      case "settings":
        return "The MCP servers could not be saved.";
    }
  }
}

export const McpConnectorStatus = Schema.Literals([
  "connected",
  "needs-auth",
  "failed",
  "pending",
  "disabled",
]);
export type McpConnectorStatus = typeof McpConnectorStatus.Type;

/** An MCP server a provider loads from its own config or account, such as a claude.ai connector. */
export const McpConnector = Schema.Struct({
  name: Schema.String,
  status: McpConnectorStatus,
  /** `claudeai` is a claude.ai connector, signed in on claude.ai; `oauth` signs in through the provider. */
  auth: Schema.Literals(["claudeai", "oauth", "none"]),
  /** Where the provider found it, such as `user`, `project` or `claudeai`. */
  source: Schema.optionalKey(Schema.String),
  /** A sign-in started here is waiting for its browser callback. */
  authorizing: Schema.Boolean,
});
export type McpConnector = typeof McpConnector.Type;

export const McpConnectorsListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Includes the project's own servers, such as Claude's `.mcp.json`. */
  projectDir: Schema.optionalKey(TrimmedNonEmptyString),
});
export type McpConnectorsListInput = typeof McpConnectorsListInput.Type;

export const McpConnectorsListResult = Schema.Struct({
  connectors: Schema.Array(McpConnector),
});
export type McpConnectorsListResult = typeof McpConnectorsListResult.Type;

export const McpConnectorAuthorizeInput = Schema.Struct({
  ...McpConnectorsListInput.fields,
  name: TrimmedNonEmptyString,
});
export type McpConnectorAuthorizeInput = typeof McpConnectorAuthorizeInput.Type;

export const McpConnectorAuthorizeResult = Schema.Struct({
  /** Absent when the provider signed in without asking the user. */
  authUrl: Schema.optionalKey(Schema.String),
  /**
   * The provider waits for the browser to return to its loopback address. A browser on another
   * device cannot reach it, so the client offers to paste the address it landed on.
   */
  callbackExpected: Schema.Boolean,
});
export type McpConnectorAuthorizeResult = typeof McpConnectorAuthorizeResult.Type;

export const McpConnectorSubmitCallbackInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: TrimmedNonEmptyString,
  callbackUrl: TrimmedNonEmptyString,
});
export type McpConnectorSubmitCallbackInput = typeof McpConnectorSubmitCallbackInput.Type;

export class McpConnectorError extends Schema.TaggedError<McpConnectorError>()(
  "McpConnectorError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const McpServerStatusListInput = Schema.Struct({
  /** Checks these servers again instead of answering from the environment's cache. */
  refresh: Schema.optionalKey(Schema.Array(McpServerId)),
});
export type McpServerStatusListInput = typeof McpServerStatusListInput.Type;

export const McpServerToolSummary = Schema.Struct({
  name: Schema.String,
  /** The tool's `annotations.readOnlyHint`, when it declares one. */
  readOnly: Schema.optionalKey(Schema.Boolean),
});
export type McpServerToolSummary = typeof McpServerToolSummary.Type;

/** What starting or reaching one of the user's MCP servers here showed. */
export const McpServerStatus = Schema.Struct({
  id: McpServerId,
  status: McpConnectorStatus,
  /** Set when connected. */
  tools: Schema.optionalKey(Schema.Array(McpServerToolSummary)),
  resourceCount: Schema.optionalKey(Schema.Number),
  /**
   * About how many tokens the tools' names, descriptions and schemas take when a provider puts them
   * all in the model's context (JSON bytes ÷ 3.7). Providers that load tools on demand cost less.
   */
  approxTokens: Schema.optionalKey(Schema.Number),
  /** Why it failed: the server's first stderr lines, or the error. */
  error: Schema.optionalKey(Schema.String),
  /** Gustaf holds a sign-in for this http server and sends its token to every provider. */
  signedIn: Schema.optionalKey(Schema.Boolean),
});
export type McpServerStatus = typeof McpServerStatus.Type;

export const McpServerStatusListResult = Schema.Struct({
  servers: Schema.Array(McpServerStatus),
});
export type McpServerStatusListResult = typeof McpServerStatusListResult.Type;

export class McpServerStatusError extends Schema.TaggedError<McpServerStatusError>()(
  "McpServerStatusError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The MCP servers could not be read.";
  }
}

export const McpServerSignInInput = Schema.Struct({ id: McpServerId });
export type McpServerSignInInput = typeof McpServerSignInInput.Type;

export const McpServerSignInResult = Schema.Struct({
  authUrl: Schema.String,
  /**
   * The authorization server returns the browser to this environment's loopback address. A
   * browser on another device cannot reach it, so the client offers to paste the address it
   * landed on.
   */
  redirectUri: Schema.String,
});
export type McpServerSignInResult = typeof McpServerSignInResult.Type;

export const McpServerSignInCallbackInput = Schema.Struct({
  callbackUrl: TrimmedNonEmptyString,
});
export type McpServerSignInCallbackInput = typeof McpServerSignInCallbackInput.Type;

export const McpServerSignInCallbackResult = Schema.Struct({ id: McpServerId });
export type McpServerSignInCallbackResult = typeof McpServerSignInCallbackResult.Type;

export const McpServerSignOutInput = Schema.Struct({ id: McpServerId });
export type McpServerSignOutInput = typeof McpServerSignOutInput.Type;

export class McpServerAuthError extends Schema.TaggedError<McpServerAuthError>()(
  "McpServerAuthError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const McpRegistryRequiredSecret = Schema.Struct({
  key: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
});
export type McpRegistryRequiredSecret = typeof McpRegistryRequiredSecret.Type;

export const McpRegistryTransport = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    url: HttpUrl,
    headers: Schema.Array(McpRegistryRequiredSecret),
  }),
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    env: Schema.Array(McpRegistryRequiredSecret),
  }),
]);
export type McpRegistryTransport = typeof McpRegistryTransport.Type;

export const McpRegistryEntry = Schema.Struct({
  registryName: TrimmedNonEmptyString,
  suggestedId: Schema.String,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  version: Schema.optionalKey(Schema.String),
  homepageUrl: Schema.optionalKey(HttpUrl),
  repositoryUrl: Schema.optionalKey(HttpUrl),
  tags: Schema.Array(Schema.String),
  transport: McpRegistryTransport,
});
export type McpRegistryEntry = typeof McpRegistryEntry.Type;

export const McpRegistrySearchInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type McpRegistrySearchInput = typeof McpRegistrySearchInput.Type;

export const McpRegistrySearchResult = Schema.Struct({
  entries: Schema.Array(McpRegistryEntry),
});
export type McpRegistrySearchResult = typeof McpRegistrySearchResult.Type;

export class McpRegistryError extends Schema.TaggedError<McpRegistryError>()("McpRegistryError", {
  reason: Schema.Literals(["unreachable", "http-error", "invalid-response"]),
  status: Schema.optionalKey(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unreachable":
        return "Could not reach the MCP Registry.";
      case "http-error":
        return this.status === undefined
          ? "The MCP Registry returned an error."
          : `The MCP Registry returned HTTP ${this.status}.`;
      case "invalid-response":
        return "The MCP Registry returned an unreadable response.";
    }
  }
}
