import { open } from "@tauri-apps/plugin-dialog";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeSettings } from "../../src/components/KnowledgeSettings";
import type { KnowledgeCollection, KnowledgeStatus } from "../../src/agent/knowledgeCore";
import { makeApp, project, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const status = (over: Partial<KnowledgeStatus> = {}): KnowledgeStatus => ({
  state: "new",
  files: 0,
  chunks: 0,
  bytes: 0,
  indexedAt: null,
  issues: [],
  warnings: [],
  lastError: null,
  ...over,
});
const collection = (over: Partial<KnowledgeCollection> = {}): KnowledgeCollection => ({
  id: A,
  name: "Team wiki",
  sources: [{ path: "/docs/wiki", kind: "folder" }],
  include: ["**/*.md"],
  createdAt: 1,
  consentedAt: null,
  indexing: false,
  config: { kind: "ollama", endpoint: "http://127.0.0.1:11434", model: "embeddinggemma", keyId: null },
  status: status(),
  ...over,
});

/** A tiny stateful backend behind the knowledge_* commands. */
function backend(initial: KnowledgeCollection[]) {
  let list = initial;
  const set = (id: string, f: (c: KnowledgeCollection) => KnowledgeCollection) => {
    list = list.map((c) => (c.id === id ? f(c) : c));
    return list.find((c) => c.id === id);
  };
  mockInvoke({
    knowledge_list: () => list,
    knowledge_create: ({ name, config }: any) => {
      const c = collection({ id: B, name, config, sources: [] });
      list = [...list, c];
      return c;
    },
    knowledge_add_source: ({ id, path }: any) =>
      set(id, (c) => ({ ...c, sources: [...c.sources, { path, kind: "folder" }] })),
    knowledge_remove_source: ({ id, path }: any) =>
      set(id, (c) => ({ ...c, sources: c.sources.filter((s) => s.path !== path) })),
    knowledge_estimate: () => ({ files: 12, pdfs: 2, bytes: 3_400_000, skipped: 0, warnings: [] }),
    knowledge_reindex: ({ id }: any) => {
      set(id, (c) => ({
        ...c,
        consentedAt: 5,
        status: status({ state: "ready", files: 12, chunks: 40, indexedAt: 9 }),
      }));
      return { files: 12, chunks: 40 };
    },
    knowledge_delete: ({ id }: any) => {
      list = list.filter((c) => c.id !== id);
    },
    knowledge_rename: ({ id, name }: any) => set(id, (c) => ({ ...c, name })),
  });
}
const render = (projects = [project({ path: "/work/alpha" })]) =>
  renderApp(<KnowledgeSettings />, makeApp({ projects }));

describe("Settings → Knowledge", () => {
  it("lists collections with status, provider and the privacy note", async () => {
    backend([
      collection({ status: status({ state: "ready", files: 12, chunks: 40, indexedAt: 9 }), consentedAt: 5 }),
      collection({
        id: B,
        name: "Papers",
        status: status({
          state: "stale",
          files: 2,
          chunks: 8,
          indexedAt: 3,
          issues: [{ path: "papers/scan.pdf", reason: "No extractable text (scanned PDF? OCR is not supported)" }],
        }),
      }),
      collection({ id: "33333333-3333-4333-8333-333333333333", name: "Fresh", sources: [] }),
    ]);
    render();
    const wiki = await screen.findByRole("region", { name: "Team wiki" });
    expect(within(wiki).getByRole("status")).toHaveTextContent("Ready");
    expect(wiki).toHaveTextContent("12 files, 40 passages, Ollama (127.0.0.1:11434)");
    expect(within(await screen.findByRole("region", { name: "Papers" })).getByRole("status")).toHaveTextContent(
      "Needs re-index",
    );
    expect(screen.getByText(/1 files skipped or failed/)).toBeInTheDocument();
    const fresh = screen.getByRole("region", { name: "Fresh" });
    expect(within(fresh).getByRole("status")).toHaveTextContent("Not indexed");
    expect(within(fresh).getByRole("button", { name: "Index" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(/sends the text of the files to the embeddings provider/);
    expect(callsOf("knowledge_reindex")).toHaveLength(0);
  });

  it("adds a folder and a file through the dialog and removes a source", async () => {
    backend([collection()]);
    render();
    const wiki = await screen.findByRole("region", { name: "Team wiki" });
    vi.mocked(open).mockResolvedValueOnce("/docs/more");
    await userEvent.click(within(wiki).getByRole("button", { name: "Add folder" }));
    await waitFor(() => expect(callsOf("knowledge_add_source")).toEqual([{ id: A, path: "/docs/more" }]));
    expect(vi.mocked(open)).toHaveBeenLastCalledWith({ directory: true, multiple: false });
    expect(await screen.findByText("/docs/more")).toBeInTheDocument();
    vi.mocked(open).mockResolvedValueOnce("/docs/notes.md");
    await userEvent.click(within(wiki).getByRole("button", { name: "Add file" }));
    await waitFor(() => expect(callsOf("knowledge_add_source")).toHaveLength(2));
    expect(vi.mocked(open)).toHaveBeenLastCalledWith({ directory: false, multiple: false });
    vi.mocked(open).mockResolvedValueOnce(null);
    await userEvent.click(within(wiki).getByRole("button", { name: "Add file" }));
    expect(callsOf("knowledge_add_source")).toHaveLength(2);
    await userEvent.click(within(wiki).getByRole("button", { name: "Remove source /docs/wiki" }));
    await waitFor(() => expect(callsOf("knowledge_remove_source")).toEqual([{ id: A, path: "/docs/wiki" }]));
    await waitFor(() => expect(screen.queryByText("/docs/wiki")).not.toBeInTheDocument());
  });

  it("asks for confirmation with the provider and the size before the first index, and only then sends", async () => {
    backend([
      collection({
        config: { kind: "openai", endpoint: "https://api.example.com/v1", model: "text-embedding-3-small", keyId: "k" },
      }),
    ]);
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Index" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("12 files (3.4 MB)");
    expect(dialog).toHaveTextContent("api.example.com");
    expect(dialog).toHaveTextContent("leaves this computer");
    expect(callsOf("knowledge_estimate")).toEqual([{ id: A }]);
    expect(callsOf("knowledge_reindex")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(callsOf("knowledge_reindex")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Index" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Send and index" }),
    );
    await waitFor(() => expect(callsOf("knowledge_reindex")).toEqual([{ id: A, confirm: true }]));
    expect(await screen.findByRole("button", { name: "Re-index" })).toBeInTheDocument();
    // Consent is remembered: re-indexing needs no dialog.
    await userEvent.click(screen.getByRole("button", { name: "Re-index" }));
    await waitFor(() => expect(callsOf("knowledge_reindex")).toHaveLength(2));
    expect(callsOf("knowledge_reindex")[1]).toEqual({ id: A, confirm: false });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("says nothing leaves the computer for a local endpoint", async () => {
    backend([collection()]);
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Index" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("nothing leaves it");
  });

  it("deletes a collection only after a second click", async () => {
    backend([collection()]);
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Delete collection" }));
    expect(callsOf("knowledge_delete")).toHaveLength(0);
    expect(screen.getByText('Delete "Team wiki" and its index?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(callsOf("knowledge_delete")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Delete collection" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Delete collection" })[0]);
    await waitFor(() => expect(callsOf("knowledge_delete")).toEqual([{ id: A }]));
    expect(await screen.findByText("No collections yet.")).toBeInTheDocument();
  });

  it("creates a collection with the chosen provider settings", async () => {
    backend([]);
    render();
    await screen.findByText("No collections yet.");
    expect(screen.getByRole("button", { name: "Create collection" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Collection name"), "Handbook");
    await userEvent.click(screen.getByRole("button", { name: "Create collection" }));
    await waitFor(() => expect(callsOf("knowledge_create")).toHaveLength(1));
    expect(callsOf("knowledge_create")[0]).toEqual({
      name: "Handbook",
      include: null,
      config: { kind: "ollama", endpoint: "http://127.0.0.1:11434", model: "embeddinggemma", keyId: null },
    });
    expect(await screen.findByRole("region", { name: "Handbook" })).toBeInTheDocument();
  });

  it("shows backend errors", async () => {
    backend([collection()]);
    mockInvoke({
      knowledge_add_source: () => {
        throw "Pick a folder inside your home folder, not the home folder itself";
      },
    });
    render();
    vi.mocked(open).mockResolvedValueOnce("/Users/me");
    await userEvent.click(await screen.findByRole("button", { name: "Add folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not the home folder itself");
  });
});
