import { save } from "@tauri-apps/plugin-dialog";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ShareHtmlDialog } from "../../src/components/ShareHtmlDialog";
import { Sidebar } from "../../src/components/Sidebar";
import { chat, makeApp, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const KEY = "sk-ant-api03-" + "a1B2c3D4e5F6g7H8i9J0k1L2";
const row = (id: number, role: string, text: string) => ({
  id,
  chat_id: 1,
  created_at: 1_700_000_000_000,
  content: JSON.stringify({ role, parts: [{ type: "text", text }] }),
});

const backend = () =>
  mockInvoke({
    db_select: ({ sql }: { sql: string }) =>
      /from messages/.test(sql) ? [row(1, "user", `use ${KEY} please`), row(2, "assistant", "**done**")] : [],
  });
const c = chat({ id: 1, project_id: null, title: "Deploy notes" });

describe("Share as HTML", () => {
  // The page builder is loaded on demand (react-markdown, highlighting); warm it so the first test is not racing the transform.
  beforeAll(() => import("../../src/lib/shareHtml"), 30_000);

  it("offers the item in the chat context menu and opens the review dialog", async () => {
    backend();
    renderApp(<Sidebar onCreateProject={() => {}} onSearch={() => {}} />, makeApp({ chats: [c] }));
    fireEvent.contextMenu(screen.getAllByText("Deploy notes")[0]);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Share as HTML/ }));
    expect(await screen.findByRole("dialog", { name: "Share as HTML" })).toBeInTheDocument();
  });

  it("shows the redaction count and a preview toggle before saving", async () => {
    backend();
    renderApp(<ShareHtmlDialog chat={c} onClose={() => {}} />);
    expect(await screen.findByText(/1 secret was redacted/)).toBeInTheDocument();
    expect(screen.queryByTitle("Preview of the page")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Show a preview"));
    const frame = screen.getByTitle("Preview of the page") as HTMLIFrameElement;
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain("[REDACTED]");
    expect(frame.getAttribute("srcdoc")).not.toContain(KEY);
  });

  it("saves the page through the native dialog and never writes the secret", async () => {
    backend();
    vi.mocked(save).mockResolvedValueOnce("/tmp/out/Deploy-notes.html");
    mockInvoke({ fs_write: "ok" });
    renderApp(<ShareHtmlDialog chat={c} onClose={() => {}} />);
    await screen.findByText(/1 secret was redacted/);
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(callsOf("fs_write")).toHaveLength(1));
    const [call] = callsOf("fs_write");
    expect(call).toMatchObject({ root: "/tmp/out", path: "Deploy-notes.html" });
    expect(call.content).toContain("Content-Security-Policy");
    expect(call.content).not.toContain(KEY);
    expect(vi.mocked(save).mock.lastCall?.[0]).toMatchObject({ defaultPath: "Deploy-notes.html" });
  });

  it("writes nothing when the save dialog is cancelled", async () => {
    backend();
    vi.mocked(save).mockResolvedValueOnce(null);
    renderApp(<ShareHtmlDialog chat={c} onClose={() => {}} />);
    await screen.findByText(/1 secret was redacted/);
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(callsOf("fs_write")).toHaveLength(0);
  });
});
