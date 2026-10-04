import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { McpServers } from "../../src/components/McpServers";
import { callsOf, mockInvoke, mockSettings } from "./tauri";
import { renderApp } from "./render";

const http = { id: "h1", name: "remote", enabled: true, scope: "global", transport: "http", url: "https://example.com/sse", headers: [], alwaysAllow: false, allowedTools: [], readOnlyTools: [] };

/** The `mcpServers` setting as last written through `insert into settings`. */
const savedServers = () => {
  const writes = callsOf("db_execute").filter((a: any) => /insert into settings/.test(a.sql) && a.params[0] === "mcpServers");
  return writes.length ? JSON.parse(writes[writes.length - 1].params[1]).servers : null;
};

describe("MCP server form: transport and OAuth sign-out note", () => {
  it("offers the transport choice for remote servers, detecting automatically by default", async () => {
    mockSettings({ mcpServers: { servers: [] } });
    renderApp(<McpServers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Add remote server/ }));
    const select = screen.getByRole("combobox", { name: "Transport" }) as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect([...select.options].map((o) => o.value)).toEqual(["auto", "streamable", "sse"]);
    expect(screen.getByText(/switches to the legacy SSE transport/)).toBeInTheDocument();
    // Not offered for local (stdio) servers.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: /Add local server/ }));
    expect(screen.queryByRole("combobox", { name: "Transport" })).toBeNull();
  });

  it("saves an explicit SSE choice and keeps `auto` out of the stored settings", async () => {
    mockSettings({ mcpServers: { servers: [] } });
    renderApp(<McpServers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Add remote server/ }));
    await user.type(screen.getByPlaceholderText("github"), "legacy");
    await user.type(screen.getByPlaceholderText("https://example.com/mcp"), "https://example.com/sse");
    await user.selectOptions(screen.getByRole("combobox", { name: "Transport" }), "sse");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedServers()?.[0]?.httpTransport).toBe("sse"));
    expect(savedServers()[0]).toMatchObject({ name: "legacy", transport: "http", url: "https://example.com/sse" });
  });

  it("shows the stored choice when editing, and going back to automatic clears it", async () => {
    mockSettings({ mcpServers: { servers: [{ ...http, httpTransport: "streamable" }] } });
    mockInvoke({ mcp_status: [] });
    renderApp(<McpServers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const select = screen.getByRole("combobox", { name: "Transport" }) as HTMLSelectElement;
    expect(select.value).toBe("streamable");
    await user.selectOptions(select, "auto");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedServers()).not.toBeNull());
    expect(savedServers()[0]).not.toHaveProperty("httpTransport");
  });

  it("explains in the OAuth section that signing out revokes the tokens (best effort)", async () => {
    mockSettings({ mcpServers: { servers: [] } });
    renderApp(<McpServers />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Add remote server/ }));
    expect(screen.queryByText(/revoke the tokens/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /Sign in with OAuth/ }));
    expect(screen.getByText(/Sign out asks the authorization server to revoke the tokens/)).toBeInTheDocument();
  });
});
