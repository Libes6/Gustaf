// Settings, Model providers: pinned drivers, status rows from cached health, details, the enable switch, the
// "Add provider" wizard (Grok), several instances of one driver, old providers, the model picker's grouping, and no
// Keychain reads when the page opens.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../src/components/ModelPicker";
import { ProvidersPage } from "../../src/components/ProvidersPage";
import { invalidateSecret } from "../../src/lib/keys";
import { resetModelState } from "../../src/providers";
import { driverOf, orderProviders } from "../../src/providers/drivers";
import type { ProviderConfig } from "../../src/providers/types";
import { makeApp as baseApp, renderApp } from "./render";
const makeApp = (over: Record<string, unknown> = {}) => baseApp({ refreshModels: vi.fn(async () => []), ...over });
import { callsOf, mockInvoke } from "./tauri";

const settings = new Map<string, string>();
function backend() {
  mockInvoke({
    db_select: ({ sql, params }: { sql: string; params: unknown[] }) => {
      if (/from settings where key/.test(sql)) {
        const v = settings.get(String(params[0]));
        return v === undefined ? [] : [{ value: v }];
      }
      return [];
    },
    db_execute: ({ sql, params }: { sql: string; params: unknown[] }) => {
      if (/insert into settings/.test(sql)) settings.set(String(params[0]), String(params[1]));
      return [1, 1];
    },
    secret_get: () => "should-not-be-read",
    secret_set: () => undefined,
    secret_delete: () => undefined,
  });
}
const saved = (key: string) => JSON.parse(settings.get(key) ?? "null");
const fetchMock = vi.mocked(tauriFetch);

const claudeCli: ProviderConfig = { id: "cli-claude", kind: "cli", cli: "claude", name: "Claude Code", baseUrl: "" };
const cursorA: ProviderConfig = {
  id: "cli-acc-a",
  kind: "cli",
  cli: "cursor-agent",
  cliProfile: "acc-a",
  name: "work@cursor",
  baseUrl: "",
};
const cursorB: ProviderConfig = {
  id: "cli-acc-b",
  kind: "cli",
  cli: "cursor-agent",
  cliProfile: "acc-b",
  name: "home@cursor",
  baseUrl: "",
};
const openai: ProviderConfig = { id: "oa", kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" };
const grok: ProviderConfig = { id: "gx", kind: "xai", name: "Grok", baseUrl: "https://api.x.ai/v1", disabled: true };
const router: ProviderConfig = {
  id: "or",
  kind: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
};
const ollama: ProviderConfig = { id: "ol", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1" };
const custom: ProviderConfig = {
  id: "cu",
  kind: "custom",
  name: "My endpoint",
  baseUrl: "https://llm.example.test/v1",
};

const list = () => screen.getByRole("list", { name: "Model providers" });
const rowNames = () =>
  within(list())
    .getAllByRole("listitem")
    .map((li) => li.querySelector(".t")!.textContent!.trim());
const row = (name: string) =>
  within(list())
    .getAllByRole("listitem")
    .find((li) => li.querySelector(".t")!.textContent!.startsWith(name))!;

beforeEach(() => {
  settings.clear();
  invalidateSecret();
  resetModelState();
  fetchMock.mockReset();
  backend();
});

describe("ProvidersPage", () => {
  it("pins Claude, GPT / Codex, Cursor and Grok in that order when nothing is configured", async () => {
    renderApp(<ProvidersPage />, makeApp({ settingsPage: "providers" }));
    expect(rowNames()).toEqual(["Claude", "GPT / Codex", "Cursor", "Grok"]);
    for (const li of within(list()).getAllByRole("listitem")) expect(li).toHaveTextContent("Not set up · Connect");
    // The first pinned driver is selected: its explanation and the connect actions.
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Claude");
    expect(screen.getByText(/Claude is not set up yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Claude" })).toBeInTheDocument();
    // The Claude Code CLI was not detected (no shell in tests), so its connect button is off.
    expect(screen.getByRole("button", { name: "Connect Claude Code CLI" })).toBeDisabled();
    await userEvent.click(within(row("Grok")).getByRole("button"));
    expect(screen.getByText(/api\.x\.ai/)).toBeInTheDocument();
  });

  it("shows authenticated, not authenticated, unavailable and disabled from cached health", () => {
    const app = makeApp({
      providers: [claudeCli, cursorA, openai, grok],
      providerHealth: {
        [claudeCli.id]: { status: "ok", message: "" },
        [cursorA.id]: { status: "auth", message: "Cursor Agent is not authenticated" },
      },
      modelErrors: { [openai.id]: "probe failed: 401" },
      limits: {
        [claudeCli.id]: {
          windows: [{ id: "5h", label: "5h", usedPercent: 3, plan: "Claude Pro Subscription" }],
          checkedAt: 1,
        },
      },
    });
    renderApp(<ProvidersPage />, app);
    expect(row("Claude Code")).toHaveTextContent("Authenticated · Claude Pro Subscription");
    expect(row("work@cursor")).toHaveTextContent("Not authenticated · Cursor Agent is not authenticated");
    expect(row("OpenAI")).toHaveTextContent("Unavailable · probe failed: 401");
    expect(row("Grok")).toHaveTextContent("Disabled");
    expect(within(row("Grok")).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(within(row("OpenAI")).getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("detail shows when the status was last checked, marks an old one as outdated, and rechecks on demand", async () => {
    const now = Date.now();
    const app = makeApp({
      providers: [openai, router],
      providerHealth: {
        [openai.id]: { status: "ok", message: "", at: now - 3 * 24 * 3600_000 },
        [router.id]: { status: "error", message: "HTTP 503 from upstream", at: now - 60_000 },
      },
    });
    renderApp(<ProvidersPage />, app);
    expect(screen.getByTestId("prov-checked")).toHaveTextContent(/Last checked: /);
    expect(screen.getByText(/may be outdated/)).toBeInTheDocument();
    expect(row("OpenAI")).toHaveTextContent("outdated");
    await userEvent.click(screen.getByRole("button", { name: "Check sign-in" }));
    expect(app.checkProvider).toHaveBeenCalledWith(openai);
    // one provider failing does not hide the others: the failure reason is on its own row and detail
    expect(row("OpenRouter")).toHaveTextContent("Unavailable · HTTP 503 from upstream");
    expect(row("OpenRouter")).not.toHaveTextContent("outdated");
    await userEvent.click(within(row("OpenRouter")).getByRole("button"));
    expect(screen.getByTestId("prov-status")).toHaveTextContent("HTTP 503 from upstream");
    expect(screen.queryByText(/may be outdated/)).toBeNull();
    expect(row("OpenAI")).toHaveTextContent("Authenticated");
  });

  it("a provider that was never checked says so", () => {
    renderApp(<ProvidersPage />, makeApp({ providers: [openai] }));
    expect(screen.getByTestId("prov-checked")).toHaveTextContent("Not checked yet.");
    expect(screen.queryByText(/may be outdated/)).toBeNull();
  });

  it("selecting a row shows that provider's details", async () => {
    renderApp(
      <ProvidersPage />,
      makeApp({
        providers: [openai, router],
        models: [{ id: "or/model-x", name: "Model X", providerId: router.id, created: 0, firstSeen: 0 }],
      }),
    );
    // The first configured provider is selected at first.
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("OpenAI");
    await userEvent.click(within(row("OpenRouter")).getByRole("button"));
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("OpenRouter");
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(router.baseUrl);
    expect(screen.getByText("Model X")).toBeInTheDocument();
    expect(within(row("OpenRouter")).getByRole("button")).toHaveAttribute("aria-current", "true");
  });

  it("the enable switch saves `disabled` and refreshes from cache", async () => {
    settings.set("providers", JSON.stringify([openai, router]));
    const app = makeApp({ providers: [openai, router] });
    renderApp(<ProvidersPage />, app);
    await userEvent.click(within(row("OpenRouter")).getByRole("switch"));
    await waitFor(() => expect(saved("providers")).toEqual([openai, { ...router, disabled: true }]));
    expect(app.refreshModels).toHaveBeenCalledWith({ refresh: "startup" });
  });

  it("the + wizard walks Driver, Identity, Config and saves a Grok provider", async () => {
    fetchMock.mockImplementation(
      (async () =>
        new Response(JSON.stringify({ data: [{ id: "grok-4" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof tauriFetch,
    );
    const app = makeApp({ providers: [] });
    renderApp(<ProvidersPage />, app);
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog", { name: "Add provider instance" });
    expect(within(dialog).getByText("Driver").closest("li")).toHaveAttribute("aria-current", "step");
    for (const name of [
      "Claude",
      "Codex / OpenAI",
      "Cursor",
      "Grok",
      "OpenRouter",
      "Ollama / LM Studio",
      "Custom (OpenAI-compatible)",
    ])
      expect(
        within(dialog).getByRole("button", { name: new RegExp(`^${name.replace(/[()/]/g, "\\$&")}`) }),
      ).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: /GitHub Copilot/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /GitHub Copilot/ })).toHaveTextContent("Coming soon");

    await userEvent.click(within(dialog).getByRole("button", { name: /^Grok/ }));
    expect(within(dialog).getByText("Identity").closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.type(within(dialog).getByPlaceholderText("xai-…"), "xai-test-key");
    await userEvent.click(within(dialog).getByRole("button", { name: "Next" }));

    expect(within(dialog).getByText("Config").closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(dialog).getByPlaceholderText("https://example.com/v1")).toHaveValue("https://api.x.ai/v1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved("providers")).toHaveLength(1));
    const [p] = saved("providers") as ProviderConfig[];
    expect(p).toMatchObject({ kind: "xai", name: "Grok", baseUrl: "https://api.x.ai/v1" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.x.ai/v1/models");
    expect(callsOf("secret_set")).toEqual([{ id: `provider:${p.id}`, value: "xai-test-key" }]);
    await waitFor(() => expect(app.refreshModels).toHaveBeenCalledWith({ only: [p.id] }));
    expect(app.setSelection).toHaveBeenCalledWith({ providerId: p.id, model: "grok-4" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists two instances of one driver as separate rows inside the pinned group", () => {
    renderApp(<ProvidersPage />, makeApp({ providers: [router, cursorA, openai, cursorB] }));
    expect(rowNames()).toEqual(["Claude", "OpenAI", "work@cursor", "home@cursor", "Grok", "OpenRouter"]);
    expect(row("work@cursor")).not.toHaveTextContent("Not set up");
  });

  it("keeps existing providers of every kind, unchanged, after the pinned drivers in their saved order", async () => {
    const old = [
      custom,
      ollama,
      {
        id: "ge",
        kind: "gemini",
        name: "Gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      } as ProviderConfig,
      router,
    ];
    const app = makeApp({ providers: old });
    renderApp(<ProvidersPage />, app);
    expect(rowNames()).toEqual([
      "Claude",
      "GPT / Codex",
      "Cursor",
      "Grok",
      "My endpoint",
      "Ollama",
      "Gemini",
      "OpenRouter",
    ]);
    // Grouping is derived, never written back.
    expect(callsOf("db_execute").filter((a) => /insert into settings/.test(a.sql))).toEqual([]);
    expect(orderProviders(old)).toEqual(old);
    expect(driverOf({ kind: "custom", baseUrl: "https://api.x.ai/v1" })).toBe("grok");
    expect(driverOf({ kind: "cli", cli: "codex", baseUrl: "" })).toBe("codex");
  });

  it("opening the page reads no Keychain item and sends no request", async () => {
    const app = makeApp({ providers: [openai, router, claudeCli, cursorA, custom] });
    renderApp(<ProvidersPage />, app);
    await userEvent.click(within(row("OpenRouter")).getByRole("button"));
    await new Promise((r) => setTimeout(r, 20));
    expect(callsOf("secret_get")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(app.refreshModels).not.toHaveBeenCalled();
    expect(app.checkProvider).not.toHaveBeenCalled();
  });
  it("Check all re-checks the providers through one action; it is off while a check runs and with nothing enabled", async () => {
    const app = makeApp({ providers: [openai, router] });
    const { rerenderApp } = renderApp(<ProvidersPage />, app);
    await userEvent.click(screen.getByRole("button", { name: "Check all" }));
    expect(app.checkAllProviders).toHaveBeenCalledTimes(1);
    app.checkingProvider = "oa";
    rerenderApp(<ProvidersPage />);
    expect(screen.getByRole("button", { name: "Checking all…" })).toBeDisabled();
  });

  it("Check all is disabled when every provider is off", () => {
    renderApp(<ProvidersPage />, makeApp({ providers: [{ ...openai, disabled: true }] }));
    expect(screen.getByRole("button", { name: "Check all" })).toBeDisabled();
  });
});

describe("ModelPicker", () => {
  const m = (providerId: string, id: string, created = 0) => ({ id, name: id, providerId, created, firstSeen: 0 });
  it("groups models by provider in the pinned order and links to the providers page", async () => {
    const anthropic: ProviderConfig = { id: "an", kind: "anthropic", name: "Anthropic", baseUrl: "" };
    const app = makeApp({
      providers: [router, { ...grok, disabled: false }, anthropic, openai],
      models: [
        m(router.id, "model-router", 9),
        m(grok.id, "model-grok", 5),
        m(anthropic.id, "model-claude", 1),
        m(openai.id, "model-gpt", 2),
      ],
    });
    renderApp(<ModelPicker onClose={() => {}} />, app);
    // The provider rail follows the same order.
    const rail = [...document.querySelectorAll(".picker-rail button")].map((b) => b.getAttribute("aria-label"));
    expect(rail).toEqual(["Favorites", "Anthropic", "OpenAI", "Grok", "OpenRouter"]);
    await userEvent.type(screen.getByRole("combobox"), "model");
    expect(screen.getAllByRole("option").map((o) => o.querySelector(".model-name")!.textContent!.trim())).toEqual([
      "model-claude",
      "model-gpt",
      "model-grok",
      "model-router",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Manage providers…" }));
    expect(app.openSettings).toHaveBeenCalledWith("providers");
  });
});
