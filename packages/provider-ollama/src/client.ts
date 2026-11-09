import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OllamaSettings } from "./settings.ts";

export const ollamaClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("ollama"),
  label: "Ollama",
  settingsSchema: OllamaSettings,
});
