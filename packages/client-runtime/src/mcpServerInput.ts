import { McpServerConfig, McpServerId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeDocument = Schema.decodeUnknownSync(
  Schema.Struct({
    mcpServers: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
const decodeNative = Schema.decodeUnknownSync(
  Schema.Struct({
    command: Schema.optionalKey(Schema.String),
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    cwd: Schema.optionalKey(Schema.String),
    url: Schema.optionalKey(Schema.String),
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);
const decodeId = Schema.decodeSync(McpServerId);
const decodeConfig = Schema.decodeUnknownSync(McpServerConfig);

export function parseMcpServerJson(text: string): Record<string, McpServerConfig> {
  const input = decodeDocument(JSON.parse(text));
  return Object.fromEntries(
    Object.entries(input.mcpServers).map(([id, value]) => {
      decodeId(id);
      const native = decodeNative(value);
      return [
        id,
        decodeConfig({
          enabled: false,
          transport:
            native.url === undefined
              ? {
                  type: "stdio",
                  command: native.command,
                  args: native.args ?? [],
                  env: native.env ?? {},
                  cwd: native.cwd ?? "thread",
                }
              : { type: "http", url: native.url, headers: native.headers ?? {} },
        }),
      ];
    }),
  );
}
