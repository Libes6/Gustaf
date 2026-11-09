import { makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

export const OllamaSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    baseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed(OLLAMA_DEFAULT_BASE_URL)),
      Schema.annotateKey({
        title: "Server URL",
        description: "Ollama server. Gustaf reads models from /api/tags and chats through /api/chat.",
        providerSettingsForm: {
          placeholder: OLLAMA_DEFAULT_BASE_URL,
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  { order: ["baseUrl"] },
);
export type OllamaSettings = typeof OllamaSettings.Type;
