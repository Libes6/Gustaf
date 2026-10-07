import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { McpPromptDialog } from "../../src/components/McpPromptDialog";
import { callsOf, mockInvoke, mockSettings } from "./tauri";
import { renderApp } from "./render";

const server = {
  id: "s1",
  name: "docs",
  enabled: true,
  scope: "global",
  transport: "stdio",
  command: "node",
  args: [],
  env: [],
  alwaysAllow: false,
  allowedTools: [],
  readOnlyTools: [],
};

/** A stdio MCP server that offers one prompt with a required argument, behind the mocked backend. */
function backend() {
  mockSettings({ mcpServers: { servers: [server] } });
  mockInvoke({
    mcp_start: {
      id: "s1",
      state: "running",
      error: null,
      pid: 1,
      restarts: 0,
      toolsEpoch: 0,
      resourcesEpoch: 0,
      promptsEpoch: 0,
      init: { protocolVersion: "2025-06-18", capabilities: { prompts: {} }, serverInfo: { name: "docs" } },
    },
    mcp_status: [
      {
        id: "s1",
        state: "running",
        error: null,
        pid: 1,
        restarts: 0,
        toolsEpoch: 0,
        resourcesEpoch: 0,
        promptsEpoch: 0,
        init: null,
      },
    ],
    mcp_request: ({ method, params }: { method: string; params: any }) => {
      if (method === "prompts/list")
        return {
          prompts: [
            {
              name: "review",
              title: "Review code",
              description: "Reviews a snippet",
              arguments: [{ name: "code", required: true, description: "Code to review" }],
            },
          ],
        };
      if (method === "prompts/get")
        return {
          messages: [{ role: "user", content: { type: "text", text: `Please review: ${params.arguments.code}` } }],
        };
      throw new Error("unexpected " + method);
    },
  });
}

describe("MCP prompt picker", () => {
  it("lists prompts, asks for required arguments, and inserts the rendered text only on Insert", async () => {
    backend();
    const onInsert = vi.fn();
    renderApp(<McpPromptDialog project={null} onInsert={onInsert} onClose={() => {}} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Review code/ }));
    // Nothing was fetched or inserted by merely listing and choosing.
    expect(callsOf("mcp_request").filter((a: any) => a.method === "prompts/get")).toHaveLength(0);
    expect(onInsert).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fill in: code");
    expect(onInsert).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: /code/ }), "fn()");
    await user.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(onInsert).toHaveBeenCalledWith("Please review: fn()"));
    expect(callsOf("mcp_request").filter((a: any) => a.method === "prompts/get")).toHaveLength(1);
  });

  it("says so when no server offers prompts", async () => {
    mockSettings({ mcpServers: { servers: [] } });
    renderApp(<McpPromptDialog project={null} onInsert={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("No MCP server offers prompts.")).toBeInTheDocument();
  });

  it("shows a failing server without hiding the others", async () => {
    mockSettings({ mcpServers: { servers: [server] } });
    mockInvoke({
      mcp_start: () => {
        throw new Error("boom");
      },
    });
    renderApp(<McpPromptDialog project={null} onInsert={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(/docs: boom/)).toBeInTheDocument();
  });
});
