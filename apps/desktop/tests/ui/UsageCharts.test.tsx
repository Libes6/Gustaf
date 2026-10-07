import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UsageCharts } from "../../src/components/UsageCharts";
import { Settings } from "../../src/components/Settings";
import { makeApp, provider, renderApp } from "./render";
import { callsOf, mockInvoke, mockSettings } from "./tauri";

const usage = { input: 100, output: 20, cached: 5, cacheWrite: 0, reasoning: 0 };

describe("Usage statistics", () => {
  it("shows the empty state for a period without usage", async () => {
    mockSettings({});
    renderApp(<UsageCharts />);
    expect(await screen.findByText("No token usage in this period.")).toBeInTheDocument();
  });

  it("reads the range with one query and shows per-provider totals", async () => {
    mockSettings({});
    mockInvoke({ db_select: (a: { sql: string }) => /from messages/.test(a.sql) ? [{ created_at: Date.now() - 1000, meta: JSON.stringify({ provider: "p1", model: "m1", usage }) }] : [] });
    renderApp(<UsageCharts />, makeApp({ providers: [provider({ id: "p1", name: "Alpha" })] }));
    const legend = await screen.findByRole("list");
    expect(within(legend).getByText("Alpha")).toBeInTheDocument();
    expect(within(legend).getByText("120")).toBeInTheDocument();
    expect(callsOf("db_select").filter((a: any) => /from messages/.test(a.sql))).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Cached" }));
    await waitFor(() => expect(within(screen.getByRole("list")).getByText("5")).toBeInTheDocument());
  });

  it("the Usage page has no settings controls; they live on Agents & budgets", async () => {
    mockSettings({});
    renderApp(<Settings />, makeApp({ settingsPage: "usage" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Usage"));
    expect(screen.queryByText("Budgets")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
