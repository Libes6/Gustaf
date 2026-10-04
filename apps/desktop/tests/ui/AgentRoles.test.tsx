import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSettingsSection } from "../../src/components/AgentSettingsSection";
import { resetAgentSettings } from "../../src/agent/agentSettingsStore";
import { makeApp, provider, renderApp } from "./render";
import { callsOf, mockSettings } from "./tauri";

const providers = [
  provider({ id: "api1", name: "Anthropic", kind: "anthropic" }),
  provider({ id: "codex1", name: "Codex", kind: "cli", cli: "codex" }),
  provider({ id: "sdk", name: "Cursor SDK", kind: "cursor" }),
  provider({ id: "off", name: "Disabled CLI", kind: "cli", cli: "claude", disabled: true }),
];
const models = [
  { id: "sonnet", name: "Sonnet", providerId: "api1", created: 0, tools: true },
  { id: "default", name: "Default", providerId: "codex1", created: 0, tools: true },
  { id: "gpt-5", name: "GPT-5", providerId: "codex1", created: 0, tools: true },
  { id: "x", name: "SDK model", providerId: "sdk", created: 0, tools: true },
];

const saved = () => {
  const writes = callsOf("db_execute").filter((a: any) => /insert into settings/.test(a.sql) && a.params[0] === "agentSettings");
  return writes.length ? JSON.parse((writes[writes.length - 1] as any).params[1]) : null;
};

describe("Settings: agent roles and providers", () => {
  beforeEach(() => resetAgentSettings());

  it("offers API providers and non-interactive CLI agents, not the Cursor SDK or disabled providers", async () => {
    mockSettings({});
    renderApp(<AgentSettingsSection />, makeApp({ providers, models }));
    const select = await screen.findByRole("combobox", { name: "Provider and model for the Planner role" });
    const labels = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(labels).toEqual(["Not set", "Anthropic · Sonnet", "Codex · Default", "Codex · GPT-5"]);
    const add = screen.getByRole("combobox", { name: "Allow a provider" });
    expect(within(add).getAllByRole("option").map((o) => o.textContent)).toEqual(["Allow a provider", "Anthropic", "Codex"]);
  });

  it("stores a role preset and allows its provider; the preset survives a reload", async () => {
    mockSettings({});
    renderApp(<AgentSettingsSection />, makeApp({ providers, models }));
    const select = await screen.findByRole("combobox", { name: "Provider and model for the Implementer role" });
    fireEvent.change(select, { target: { value: "codex1\ngpt-5" } });
    await waitFor(() => expect(saved()?.roles).toEqual({ implementer: { providerId: "codex1", model: "gpt-5" } }));
    expect(saved().allowedProviders).toEqual(["codex1"]);
    expect(screen.getByRole("button", { name: "Stop allowing Codex" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(saved().roles).toEqual({}));
  });

  it("reads stored roles and removes an allowed provider", async () => {
    resetAgentSettings();
    mockSettings({ agentSettings: { roles: { reviewer: { providerId: "api1", model: "sonnet" } }, allowedProviders: ["api1", "codex1"] } });
    renderApp(<AgentSettingsSection />, makeApp({ providers, models }));
    const select = (await screen.findByRole("combobox", { name: "Provider and model for the Reviewer role" })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("api1\nsonnet"));
    fireEvent.click(screen.getByRole("button", { name: "Stop allowing Codex" }));
    await waitFor(() => expect(saved().allowedProviders).toEqual(["api1"]));
  });

  it("the cleanup switch is off by default and stores its value", async () => {
    mockSettings({});
    renderApp(<AgentSettingsSection />, makeApp({ providers, models }));
    const sw = await screen.findByRole("switch", { name: "Remove untouched subagent worktrees" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    await waitFor(() => expect(saved()?.cleanupUntouchedWorktrees).toBe(true));
  });
});
