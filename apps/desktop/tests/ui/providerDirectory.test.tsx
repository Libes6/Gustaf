import { describe, expect, it } from "vitest";
import { providerDirectory } from "../../src/lib/modelRouting";
import { provider } from "./render";

const model = (providerId: string, id: string, name: string, tools?: boolean) => ({
  id,
  name,
  providerId,
  created: 0,
  ...(tools === undefined ? {} : { tools }),
});

describe("the provider directory behind the gustaf-agent command", () => {
  it("lists models, and says why a provider cannot run subagents", () => {
    const dir = providerDirectory({
      providers: [
        provider({ id: "cur", name: "Cursor", kind: "cli", cli: "cursor-agent" }),
        provider({ id: "ag", name: "Antigravity", kind: "antigravity" }),
        provider({ id: "sdk", name: "Cursor SDK", kind: "cursor" }),
        provider({ id: "oai", name: "OpenAI", kind: "openai" }),
        provider({ id: "off", name: "Off", kind: "openai", disabled: true }),
      ],
      models: [
        model("cur", "composer-2", "Composer 2", true),
        model("oai", "gpt-6.1", "GPT 6.1"),
        model("oai", "embed", "Embed", false),
      ],
    });
    const list = dir.list();
    expect(list.map((p) => p.id)).toEqual(["cur", "ag", "sdk", "oai"]);
    expect(list[0].models).toEqual([{ id: "composer-2", name: "Composer 2" }]);
    expect(list[0].unusable).toBeUndefined();
    expect(list[1].unusable).toMatch(/Antigravity/);
    expect(list[2].unusable).toMatch(/Cursor Agent CLI/);
    expect(list[3].models).toEqual([{ id: "gpt-6.1", name: "GPT 6.1" }]);
  });
});
