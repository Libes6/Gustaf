import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryExportDialog } from "../../src/components/MemoryExportDialog";
import { MemorySuggestDialog } from "../../src/components/MemoryDialogs";
import { MemorySettings } from "../../src/components/MemorySettings";
import { suggestMemories } from "../../src/lib/memorySuggestRun";
import { Sidebar } from "../../src/components/Sidebar";
import { chat, makeApp, project, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

// The model call is the only part that is not a Tauri command: replace the adapter factory.
const model = vi.hoisted(() => ({ requests: [] as any[], reply: (async () => ({ parts: [] })) as (req: any) => Promise<unknown> }));
vi.mock("../../src/providers", async (orig) => ({ ...(await orig<typeof import("../../src/providers")>()), getAdapter: async () => ({ turn: (req: any) => (model.requests.push(req), model.reply(req)) }) }));

type Row = { id: number; project_root: string | null; text: string; source_chat: number | null; created_at: number; updated_at: number };
const ROOT = "/work/alpha";
let rows: Row[];
let nextId: number;
let settings: Record<string, unknown>;
let messages: any[];

/** A tiny in-memory `memories` table behind db_select / db_execute, plus settings and chat messages. */
function backend(extra: Record<string, unknown> = {}) {
  mockInvoke({
    db_select: ({ sql, params }: { sql: string; params: any[] }) => {
      if (/from settings where key/.test(sql)) return params[0] in settings ? [{ value: JSON.stringify(settings[params[0]]) }] : [];
      if (/from messages where chat_id/.test(sql)) return messages.map((m, i) => ({ id: i + 1, chat_id: params[0], content: JSON.stringify(m), created_at: i }));
      if (/from memories where project_root is \? and text = \?/.test(sql)) return rows.filter((r) => r.project_root === params[0] && r.text === params[1]).slice(0, 1);
      if (/from memories where project_root is \?/.test(sql)) return rows.filter((r) => r.project_root === params[0]);
      return [];
    },
    db_execute: ({ sql, params }: { sql: string; params: any[] }) => {
      if (/insert into memories/.test(sql)) { rows.push({ id: nextId, project_root: params[0], text: params[1], source_chat: params[2], created_at: params[3], updated_at: params[4] }); return [1, nextId++]; }
      if (/update memories set text/.test(sql)) { const r = rows.find((x) => x.id === params[2] && x.project_root === params[3]); if (r) r.text = params[0]; return [r ? 1 : 0, 0]; }
      if (/delete from memories/.test(sql)) { const n = rows.length; rows = rows.filter((x) => !(x.id === params[0] && x.project_root === params[1])); return [n - rows.length, 0]; }
      if (/insert into settings/.test(sql)) { settings[params[0]] = JSON.parse(params[1]); return [1, 1]; }
      return [1, 1];
    },
    ...extra,
  });
}
const row = (id: number, text: string, project_root: string | null = ROOT): Row => ({ id, project_root, text, source_chat: null, created_at: 1, updated_at: id });

beforeEach(() => {
  rows = [row(1, "Use pnpm here"), row(2, "Prefers short answers", null)];
  nextId = 10;
  settings = {};
  messages = [];
  model.requests.length = 0;
  model.reply = async () => ({ parts: [] });
});

describe("project menu: Memory…", () => {
  const setup = () => renderApp(<Sidebar onCreateProject={() => {}} onSearch={() => {}} />, makeApp({ projects: [project({ path: ROOT })], chats: [chat({ id: 1, project_id: 1, title: "Fix the parser" })] }));
  const open = async () => {
    setup();
    fireEvent.contextMenu(screen.getByText("Alpha"));
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Memory…" }));
    return await screen.findByRole("dialog", { name: "Memory" });
  };

  it("lists this project's facts and the global ones", async () => {
    backend();
    const dialog = await open();
    expect(await within(dialog).findByText("Use pnpm here")).toBeInTheDocument();
    expect(within(dialog).getByText("Prefers short answers")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("This project");
    expect(dialog).toHaveTextContent("All chats");
  });

  it("is not offered for a project without a folder", () => {
    backend();
    renderApp(<Sidebar onCreateProject={() => {}} onSearch={() => {}} />, makeApp({ projects: [project({ path: null })], chats: [] }));
    fireEvent.contextMenu(screen.getByText("Alpha"));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Memory…" })).toBeNull();
  });

  it("adds to the project or to the global scope, edits and deletes in the entry's own scope", async () => {
    backend();
    const dialog = await open();
    await within(dialog).findByText("Use pnpm here");

    await userEvent.type(within(dialog).getByLabelText("Fact"), "Tests live in tests/");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rows.some((r) => r.text === "Tests live in tests/" && r.project_root === ROOT)).toBe(true));

    await userEvent.selectOptions(within(dialog).getByLabelText("Scope"), "global");
    await userEvent.type(within(dialog).getByLabelText("Fact"), "Answers in Russian");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rows.some((r) => r.text === "Answers in Russian" && r.project_root === null)).toBe(true));

    // Edit a global entry from the project dialog: it stays global.
    const globalRow = within(dialog).getByText("Prefers short answers").closest(".card-row") as HTMLElement;
    await userEvent.click(within(globalRow).getByRole("button", { name: "Edit" }));
    const box = within(dialog).getByLabelText("Fact");
    await userEvent.clear(box);
    await userEvent.type(box, "Prefers long answers");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rows.find((r) => r.id === 2)?.text).toBe("Prefers long answers"));
    expect(rows.find((r) => r.id === 2)?.project_root).toBeNull();

    const projectRow = within(dialog).getByText("Use pnpm here").closest(".card-row") as HTMLElement;
    await userEvent.click(within(projectRow).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rows.some((r) => r.id === 1)).toBe(false));
    expect(within(dialog).queryByText("Use pnpm here")).toBeNull();
  });

  it("Escape closes it", async () => {
    backend();
    const dialog = await open();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
});

describe("Settings -> Memory", () => {
  it("the end-of-chat suggestion setting is off by default and persisted when switched on", async () => {
    backend();
    renderApp(<MemorySettings />, makeApp({ projects: [project({ path: ROOT })] }));
    const toggle = await screen.findByRole("switch", { name: "Suggest memories at the end of chats" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    await waitFor(() => expect(settings.memorySuggestAuto).toBe(true));
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("offers the AGENTS.md export only with a project selected", async () => {
    backend();
    renderApp(<MemorySettings />, makeApp({ projects: [project({ path: ROOT })] }));
    await screen.findByText("Prefers short answers");
    expect(screen.queryByRole("button", { name: "Export to AGENTS.md…" })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Scope"), ROOT);
    expect(await screen.findByRole("button", { name: "Export to AGENTS.md…" })).toBeInTheDocument();
  });
});

describe("MemorySuggestDialog", () => {
  const app = () => makeApp({
    projects: [project({ path: ROOT })], providers: [provider()],
    models: [{ id: "m1", name: "Model One", providerId: "p1", contextWindow: 200_000, created: 1, firstSeen: 1 }],
    selection: { providerId: "p1", model: "m1" },
  });
  const reply = (facts: unknown) => { model.reply = async () => ({ parts: [{ type: "text", text: JSON.stringify({ facts }) }], usage: { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 } }); };
  const open = (initial?: any) => renderApp(<MemorySuggestDialog chat={{ id: 7, title: "Parser work" }} project={project({ path: ROOT })} initial={initial} onClose={() => {}} />, app());

  beforeEach(() => {
    messages = [
      { role: "user", parts: [{ type: "text", text: "We always use pnpm; my key is sk-" + "a".repeat(30) }] },
      { role: "assistant", parts: [{ type: "text", text: "Understood." }, { type: "tool_call", id: "1", name: "bash", args: { command: "SECRET_TOOL_ARGS" } }] },
      { role: "tool", parts: [{ type: "tool_result", id: "1", name: "bash", output: "SECRET_TOOL_OUTPUT" }] },
    ];
  });

  it("shows the cost note and sends nothing until the user asks", async () => {
    backend();
    open();
    expect(screen.getByText(/one more model request that sends the text of this chat/)).toBeInTheDocument();
    expect(model.requests).toHaveLength(0);
  });

  it("one request with the redacted chat text only; only the ticked, edited facts are stored; known facts are not offered again", async () => {
    backend();
    reply([
      { text: "Use pnpm, not npm", scope: "project" },
      { text: "Prefers short answers", scope: "global" }, // already saved
      { text: "Answers in Russian", scope: "global" },
      { text: "Tests live in tests/", scope: "project" },
    ]);
    open();
    await userEvent.click(screen.getByRole("button", { name: "Suggest" }));
    expect(await screen.findByLabelText("Suggestion 1")).toBeInTheDocument();

    expect(model.requests).toHaveLength(1);
    const req = model.requests[0];
    expect(req.tools).toEqual([]);
    expect(req.access).toBe("readonly");
    const sent = JSON.stringify(req);
    for (const leaked of ["SECRET_TOOL_ARGS", "SECRET_TOOL_OUTPUT", "a".repeat(30)]) expect(sent).not.toContain(leaked);
    expect(sent).toContain("We always use pnpm");

    // "Prefers short answers" is dropped as a duplicate of a saved global entry.
    expect(screen.queryByDisplayValue("Prefers short answers")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);

    // Untick the third, edit the second and move it to the project; nothing is stored yet.
    await userEvent.click(screen.getByLabelText("Save suggestion 3"));
    const second = screen.getByLabelText("Suggestion 2");
    await userEvent.clear(second);
    await userEvent.type(second, "Answers in English");
    await userEvent.selectOptions(screen.getByLabelText("Scope of suggestion 2"), "project");
    expect(rows).toHaveLength(2);
    expect(callsOf("db_execute").some((a) => /insert into memories/.test(a.sql))).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Save 2 selected" }));
    expect(await screen.findByText("Saved 2, already known 0.")).toBeInTheDocument();
    expect(rows.slice(2).map((r) => [r.project_root, r.text, r.source_chat])).toEqual([[ROOT, "Use pnpm, not npm", 7], [ROOT, "Answers in English", 7]]);
    expect(rows.some((r) => r.text === "Tests live in tests/")).toBe(false);
  });

  it("does not store a duplicate that appeared after the suggestions were shown, and needs at least one ticked fact", async () => {
    backend();
    open([{ id: "s0", text: "Use pnpm here", scope: "project" }, { id: "s1", text: "Fresh fact", scope: "project" }]);
    await userEvent.click(screen.getByLabelText("Save suggestion 2"));
    await userEvent.click(screen.getByRole("button", { name: "Save 1 selected" }));
    expect(await screen.findByText("Saved 0, already known 1.")).toBeInTheDocument();
    expect(rows).toHaveLength(2);
  });

  it("with nothing ticked the save button is disabled", async () => {
    backend();
    open([{ id: "s0", text: "Fresh fact", scope: "project" }]);
    await userEvent.click(screen.getByLabelText("Save suggestion 1"));
    expect(screen.getByRole("button", { name: "Save 0 selected" })).toBeDisabled();
  });

  it("an unreadable answer is reported with a retry; an empty one says so", async () => {
    backend();
    model.reply = async () => ({ parts: [{ type: "text", text: "I could not do that." }] });
    open();
    await userEvent.click(screen.getByRole("button", { name: "Suggest" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be read as a list of facts");
    reply([]);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No new durable facts found in this chat.")).toBeInTheDocument();
    expect(rows).toHaveLength(2);
  });
});

describe("MemoryExportDialog", () => {
  let files: Record<string, string>;
  beforeEach(() => { files = {}; });
  const fsBackend = () => backend({
    read_instructions: () => Object.entries(files).map(([name, text]) => ({ name, bytes: new TextEncoder().encode(text).length, text })),
    fs_list: () => ["src/", ...Object.keys(files)].join("\n"),
    fs_write: ({ path, content }: { path: string; content: string }) => { files[path] = content; return "ok"; },
  });
  const open = () => renderApp(<MemoryExportDialog root={ROOT} name="Alpha" onClose={() => {}} />);
  const preview = () => screen.getByLabelText("Resulting AGENTS.md").textContent ?? "";

  it("previews a new file, writes nothing before the confirm, then writes the managed section", async () => {
    fsBackend();
    open();
    await screen.findByText(/AGENTS\.md will be created/);
    expect(preview()).toContain("<!-- gustaf-memory:start -->");
    expect(preview()).toContain("- Use pnpm here");
    expect(preview()).not.toContain("Prefers short answers");
    expect(callsOf("fs_write")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Write AGENTS.md" }));
    expect(await screen.findByText("AGENTS.md was written.")).toBeInTheDocument();
    expect(callsOf("fs_write")).toEqual([{ root: ROOT, path: "AGENTS.md", content: files["AGENTS.md"] }]);
    expect(files["AGENTS.md"]).toBe(preview());
  });

  it("includes global facts only when ticked and keeps the text around an existing section", async () => {
    files["AGENTS.md"] = "# Notes\n\nHand-written.\n\n<!-- gustaf-memory:start -->\nold\n<!-- gustaf-memory:end -->\n\nTail.\n";
    fsBackend();
    open();
    await screen.findByText(/existing Gustaf section will be updated/);
    expect(preview()).not.toContain("Prefers short answers");
    await userEvent.click(screen.getByRole("checkbox", { name: /Include global facts \(1\)/ }));
    await waitFor(() => expect(preview()).toContain("- Prefers short answers"));
    expect(preview().startsWith("# Notes\n\nHand-written.\n\n")).toBe(true);
    expect(preview().endsWith("\n\nTail.\n")).toBe(true);
    expect(preview()).not.toContain("\nold\n");
    await userEvent.click(screen.getByRole("button", { name: "Write AGENTS.md" }));
    await screen.findByText("AGENTS.md was written.");
    expect(files["AGENTS.md"]).toBe(preview());
  });

  it("an up-to-date file has nothing to write", async () => {
    fsBackend();
    const first = open();
    await screen.findByText(/will be created/);
    await userEvent.click(screen.getByRole("button", { name: "Write AGENTS.md" }));
    await screen.findByText("AGENTS.md was written.");
    // A second dialog finds the file already current.
    first.unmount();
    open();
    await screen.findByText(/AGENTS\.md is already up to date/);
    expect(screen.getByRole("button", { name: "Write AGENTS.md" })).toBeDisabled();
  });

  it("refuses a file with broken markers and writes nothing", async () => {
    files["AGENTS.md"] = "<!-- gustaf-memory:start -->\nno end\n";
    fsBackend();
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("unbalanced or duplicated gustaf-memory markers");
    expect(screen.getByRole("button", { name: "Write AGENTS.md" })).toBeDisabled();
    expect(callsOf("fs_write")).toHaveLength(0);
  });

  it("if the file changed after the preview nothing is written until the new text is confirmed", async () => {
    fsBackend();
    open();
    await screen.findByText(/will be created/);
    files["AGENTS.md"] = "# Someone else wrote this\n";
    await userEvent.click(screen.getByRole("button", { name: "Write AGENTS.md" }));
    expect(await screen.findByText(/changed since the preview/)).toBeInTheDocument();
    expect(callsOf("fs_write")).toHaveLength(0);
    expect(preview().startsWith("# Someone else wrote this\n")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Write AGENTS.md" }));
    await screen.findByText("AGENTS.md was written.");
    expect(files["AGENTS.md"].startsWith("# Someone else wrote this\n")).toBe(true);
  });

  it("with no project facts there is nothing to write", async () => {
    rows = [];
    fsBackend();
    open();
    expect(await screen.findByText("There are no facts to export.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write AGENTS.md" })).toBeDisabled();
  });
});

describe("automatic memory suggestions", () => {
  it("never run a CLI agent on their own (it would start a full agent turn in the project); a manual request still may", async () => {
    backend();
    messages = [{ role: "user", parts: [{ type: "text", text: "We always use pnpm" }] }];
    const app = {
      providers: [provider({ id: "cli1", kind: "cli", cli: "claude", name: "Claude Code" })],
      models: [{ id: "default", name: "default", providerId: "cli1", created: 0 }],
      selection: { providerId: "cli1", model: "default" },
      bumpUsage: () => {}, recordTokens: () => {},
    };
    const signal = new AbortController().signal;
    expect(await suggestMemories(app, { chatId: 7, projectRoot: ROOT, signal, auto: true })).toEqual({ suggestions: [], model: "default" });
    expect(model.requests).toHaveLength(0);
    model.reply = async () => ({ parts: [{ type: "text", text: JSON.stringify({ facts: [] }) }] });
    await suggestMemories(app, { chatId: 7, projectRoot: ROOT, signal });
    expect(model.requests).toHaveLength(1);
  });
});
