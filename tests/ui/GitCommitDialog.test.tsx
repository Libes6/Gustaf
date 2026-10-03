import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitCommitDialog } from "../../src/components/GitCommitDialog";
import type { CommitContext, CommitResult, GitStatus } from "../../src/lib/api";
import { makeApp, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

// The model call is the only part that is not a Tauri command: replace the adapter factory.
const model = vi.hoisted(() => ({ requests: [] as any[], reply: (async () => ({ parts: [] })) as (req: any) => Promise<unknown> }));
vi.mock("../../src/providers", async (orig) => ({ ...(await orig<typeof import("../../src/providers")>()), getAdapter: async () => ({ turn: (req: any) => (model.requests.push(req), model.reply(req)) }) }));

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  repo: true, toplevel: "/work/alpha", prefix: "", branch: "main", detached: false, head: "abc1234", inProgress: null, total: 3,
  files: [
    { path: "src/a.ts", kind: "modified", staged: false },
    { path: "notes.md", kind: "untracked", staged: false },
    { path: "src/clash.ts", kind: "conflicted", staged: false },
  ],
  ...over,
});
const result: CommitResult = { sha: "f".repeat(40), short: "fffffff", branch: "main", files: ["src/a.ts"], createdBranch: false };
const context: CommitContext = { files: ["src/a.ts"], stat: " src/a.ts | 2 +-", diff: "diff --git a/src/a.ts b/src/a.ts\n+x", truncated: false, recent: ["Fix things"] };

const app = () => makeApp({
  providers: [provider()],
  models: [{ id: "m1", name: "Model One", providerId: "p1", contextWindow: 200_000, created: 1, firstSeen: 1 }],
  selection: { providerId: "p1", model: "m1" },
});

function open(over: { status?: GitStatus; accepted?: string[]; onClose?: () => void; onCommitted?: (r: CommitResult) => void; app?: ReturnType<typeof makeApp> } = {}) {
  mockInvoke({ git_status: over.status ?? status() });
  const onClose = over.onClose ?? vi.fn();
  const onCommitted = over.onCommitted ?? vi.fn();
  const view = renderApp(<GitCommitDialog root="/work/alpha" accepted={over.accepted ?? ["src/a.ts"]} onClose={onClose} onCommitted={onCommitted} />, over.app ?? app());
  return { ...view, onClose, onCommitted };
}
const commitButton = () => screen.getByRole("button", { name: /^Commit \d+ files?$/ });
const messageBox = () => screen.getByLabelText("Commit message") as HTMLTextAreaElement;
const checkbox = (path: string) => screen.getByRole("checkbox", { name: new RegExp(path.replace(".", "\\.")) });

beforeEach(() => { model.requests.length = 0; });

describe("GitCommitDialog", () => {
  it("loads the repository status and pre-selects only the files accepted in review", async () => {
    open();
    expect(screen.getByText("Reading repository…")).toBeInTheDocument();
    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(callsOf("git_status")).toEqual([{ root: "/work/alpha" }]);
    expect(screen.getByText("Accepted in review")).toBeInTheDocument();
    expect(screen.getByText("Other changes in the working tree")).toBeInTheDocument();
    expect(checkbox("src/a.ts")).toBeChecked();
    expect(checkbox("notes.md")).not.toBeChecked();
    expect(checkbox("src/clash.ts")).toBeDisabled();
  });

  it("blocks the commit until there is a message, then commits exactly the ticked files", async () => {
    const { onCommitted } = open();
    await screen.findByText("main");
    expect(commitButton()).toBeDisabled();
    expect(commitButton()).toHaveTextContent("Commit 1 file");
    expect(screen.getByText("Enter a commit message.")).toBeInTheDocument();

    await userEvent.type(messageBox(), "Add parser");
    expect(commitButton()).toBeEnabled();

    mockInvoke({ git_commit: result });
    await userEvent.click(commitButton());
    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(result));
    expect(callsOf("git_commit")).toEqual([{ root: "/work/alpha", message: "Add parser", paths: ["src/a.ts"], newBranch: null }]);
  });

  it("ticking another file updates the count; unticking everything blocks the commit", async () => {
    open();
    await screen.findByText("main");
    await userEvent.type(messageBox(), "msg");
    await userEvent.click(checkbox("notes.md"));
    expect(commitButton()).toHaveTextContent("Commit 2 files");
    mockInvoke({ git_commit: result });
    await userEvent.click(commitButton());
    await waitFor(() => expect(callsOf("git_commit")).toHaveLength(1));
    expect(callsOf("git_commit")[0].paths).toEqual(["src/a.ts", "notes.md"]);

    await userEvent.click(checkbox("src/a.ts"));
    await userEvent.click(checkbox("notes.md"));
    expect(commitButton()).toBeDisabled();
    expect(screen.getByText("Select at least one file.")).toBeInTheDocument();
  });

  it("'Select all' never ticks a conflicted file", async () => {
    open();
    await screen.findByText("main");
    const others = screen.getByText("Other changes in the working tree").closest(".git-group-head") as HTMLElement;
    await userEvent.click(others.querySelector("button")!);
    expect(checkbox("notes.md")).toBeChecked();
    expect(checkbox("src/clash.ts")).not.toBeChecked();
  });

  it("generates a message with the selected model from the bounded diff context", async () => {
    mockInvoke({ git_commit_context: context });
    model.reply = async () => ({ parts: [{ type: "text", text: "Fix parser edge case\n\nHandle empty input." }] });
    open();
    await screen.findByText("main");
    await userEvent.click(screen.getByRole("button", { name: /Generate message/ }));
    await waitFor(() => expect(messageBox().value).toBe("Fix parser edge case\n\nHandle empty input."));
    expect(callsOf("git_commit_context")[0]).toMatchObject({ root: "/work/alpha", paths: ["src/a.ts"] });
    const req = model.requests[0];
    expect(req).toMatchObject({ tools: [], access: "readonly", model: "m1", cwd: "/work/alpha" });
    expect(req.messages[0].parts[0].text).toContain("diff --git a/src/a.ts");
    expect(screen.getByRole("button", { name: /Regenerate/ })).toBeInTheDocument();
    expect(commitButton()).toBeEnabled();
  });

  it("shows the model error and keeps the message empty when generation fails", async () => {
    mockInvoke({ git_commit_context: context });
    model.reply = async () => { throw new Error("rate limited"); };
    open();
    await screen.findByText("main");
    await userEvent.click(screen.getByRole("button", { name: /Generate message/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("rate limited");
    expect(messageBox().value).toBe("");
  });

  it("shows a commit failure and stays open for another try", async () => {
    const { onCommitted, onClose } = open();
    await screen.findByText("main");
    await userEvent.type(messageBox(), "msg");
    mockInvoke({ git_commit: () => Promise.reject(new Error("pre-commit hook failed")) });
    await userEvent.click(commitButton());
    expect(await screen.findByText("pre-commit hook failed")).toBeInTheDocument();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(commitButton()).toBeEnabled();
  });

  it("creates a branch first when asked: the typed name wins, an empty field uses the suggestion", async () => {
    open();
    await screen.findByText("main");
    await userEvent.type(messageBox(), "Add parser");
    await userEvent.click(screen.getByLabelText("Create a new branch first"));
    const name = screen.getByLabelText("Branch name") as HTMLInputElement;
    expect(name.placeholder).toBe("mcode/add-parser");
    mockInvoke({ git_commit: { ...result, createdBranch: true } });
    await userEvent.click(commitButton());
    await waitFor(() => expect(callsOf("git_commit")).toHaveLength(1));
    expect(callsOf("git_commit")[0].newBranch).toBe("mcode/add-parser");
  });

  it("rejects an invalid branch name", async () => {
    open();
    await screen.findByText("main");
    await userEvent.type(messageBox(), "msg");
    await userEvent.click(screen.getByLabelText("Create a new branch first"));
    await userEvent.type(screen.getByLabelText("Branch name"), "bad name");
    expect(screen.getByLabelText("Branch name")).toHaveAttribute("aria-invalid", "true");
    expect(commitButton()).toBeDisabled();
  });

  it("starts with the branch option on for a detached HEAD", async () => {
    open({ status: status({ branch: null, detached: true }) });
    expect(await screen.findByText(/Detached HEAD at abc1234/)).toBeInTheDocument();
    expect(screen.getByLabelText("Create a new branch first")).toBeChecked();
  });

  it("explains a folder that is not a repository and offers no commit form", async () => {
    open({ status: status({ repo: false, files: [], total: 0 }) });
    expect(await screen.findByText("This project is not a git repository.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Commit message")).not.toBeInTheDocument();
    expect(commitButton()).toBeDisabled();
  });

  it("blocks committing during an unfinished merge", async () => {
    open({ status: status({ inProgress: "merge" }) });
    await screen.findByText("main");
    await userEvent.type(messageBox(), "msg");
    expect(commitButton()).toBeDisabled();
  });

  it("shows a load error", async () => {
    mockInvoke({ git_status: () => Promise.reject(new Error("git not found")) });
    renderApp(<GitCommitDialog root="/work/alpha" accepted={[]} onClose={() => {}} onCommitted={() => {}} />, app());
    expect(await screen.findByRole("alert")).toHaveTextContent("git not found");
  });

  it("Escape and Cancel close it; Cmd+Enter in the message commits", async () => {
    const { onClose, onCommitted } = open();
    await screen.findByText("main");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]);
    expect(onClose).toHaveBeenCalledTimes(2);

    await userEvent.type(messageBox(), "msg");
    mockInvoke({ git_commit: result });
    fireEvent.keyDown(messageBox(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(result));
  });
});
