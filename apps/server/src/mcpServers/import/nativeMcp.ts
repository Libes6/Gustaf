import * as Schema from "effect/Schema";
import { parse } from "smol-toml";

export type NativeMcpSource = "codex" | "cursor" | "claude" | "gemini" | "project-mcp-json";

export type NativeMcpServer = {
  readonly source: NativeMcpSource;
  readonly sourcePath: string;
  readonly projectDir?: string;
  readonly name: string;
  readonly enabled: boolean;
} & (
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly bearerTokenEnvVar?: string;
    }
);

export class NativeMcpConfigError extends Schema.TaggedError<
  NativeMcpConfigError,
  { readonly brand: unique symbol }
>()("NativeMcpConfigError", {
  sourcePath: Schema.String,
  operation: Schema.Literals(["read", "decode"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to ${this.operation} native MCP config at ${this.sourcePath}.`;
  }
}

const stringMap = Schema.Record(Schema.String, Schema.String);
const object = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownSync(object);
const entry = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(stringMap),
  url: Schema.optional(Schema.String),
  httpUrl: Schema.optional(Schema.String),
  headers: Schema.optional(stringMap),
  http_headers: Schema.optional(stringMap),
  bearer_token_env_var: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
});
const decodeEntry = Schema.decodeUnknownSync(entry);

const serversFromObject = (
  value: unknown,
  source: NativeMcpSource,
  sourcePath: string,
  projectDir?: string,
): NativeMcpServer[] => {
  if (value === undefined) return [];
  return Object.entries(decodeObject(value)).map(([name, raw]) => {
    const config = decodeEntry(raw);
    const base = {
      source,
      sourcePath,
      ...(projectDir === undefined ? {} : { projectDir }),
      name,
      enabled: config.enabled !== false && config.disabled !== true,
    };
    const url = source === "gemini" ? (config.httpUrl ?? config.url) : config.url;
    if (url !== undefined) {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("Unsupported MCP URL protocol");
      }
      return {
        ...base,
        transport: "http",
        url,
        headers: (source === "codex" ? config.http_headers : config.headers) ?? {},
        ...(source === "codex" && config.bearer_token_env_var !== undefined
          ? { bearerTokenEnvVar: config.bearer_token_env_var }
          : {}),
      };
    }
    if (!config.command?.trim()) throw new Error("Missing MCP command or URL");
    return {
      ...base,
      transport: "stdio",
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
    };
  });
};

const decode = (sourcePath: string, read: () => NativeMcpServer[]): NativeMcpServer[] => {
  try {
    return read();
  } catch (cause) {
    throw new NativeMcpConfigError({ sourcePath, operation: "decode", cause });
  }
};

export const parseCodexConfig = (content: string, sourcePath: string) =>
  decode(sourcePath, () => serversFromObject(parse(content).mcp_servers, "codex", sourcePath));

export const parseCursorConfig = (content: string, sourcePath: string, projectDir?: string) =>
  decode(sourcePath, () =>
    serversFromObject(
      decodeObject(JSON.parse(content)).mcpServers,
      "cursor",
      sourcePath,
      projectDir,
    ),
  );

export const parseClaudeConfig = (content: string, sourcePath: string) =>
  decode(sourcePath, () => {
    const config = decodeObject(JSON.parse(content));
    const servers = serversFromObject(config.mcpServers, "claude", sourcePath);
    for (const [projectDir, raw] of Object.entries(decodeObject(config.projects ?? {}))) {
      const project = decodeObject(raw);
      servers.push(...serversFromObject(project.mcpServers, "claude", sourcePath, projectDir));
    }
    return servers;
  });

export const parseGeminiConfig = (content: string, sourcePath: string) =>
  decode(sourcePath, () =>
    serversFromObject(decodeObject(JSON.parse(content)).mcpServers, "gemini", sourcePath),
  );

export const parseProjectMcpConfig = (content: string, sourcePath: string, projectDir: string) =>
  decode(sourcePath, () =>
    serversFromObject(
      decodeObject(JSON.parse(content)).mcpServers,
      "project-mcp-json",
      sourcePath,
      projectDir,
    ),
  );
