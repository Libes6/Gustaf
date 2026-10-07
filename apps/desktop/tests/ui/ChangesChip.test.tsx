import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChangesPanel } from "../../src/components/ChangesPanel";
import { renderApp } from "./render";
import { mockInvoke } from "./tauri";

const status = (files: { path: string; kind: string }[], total = files.length) => ({
  repo: true,
  toplevel: "/work/alpha",
  prefix: "",
  branch: "gustaf/ui-fixes",
  detached: false,
  head: "abc",
  files: files.map((f) => ({ ...f, staged: false })),
  total,
  inProgress: null,
});
const checkpointMessage = {
  id: 1,
  chat_id: 1,
  role: "user",
  parts: [],
  meta: { checkpoint: "cp1" },
  created_at: 1,
} as any;

/** A fake backend: `git` answers the branch, the project's shortstat and the checkpoint numstat; `review_*` the review copies. */
function backend(
  over: { stat?: string; numstat?: string; reviews?: unknown[]; diffs?: Record<string, string>; status?: unknown } = {},
) {
  mockInvoke({
    git: ({ args }: { args: string[] }) => {
      if (args[0] === "rev-parse") return "gustaf/ui-fixes\n";
      if (args.includes("--shortstat")) return over.stat ?? "";
      if (args.includes("--numstat")) return over.numstat ?? "";
      return "";
    },
    git_status: over.status ?? status([]),
    review_list: over.reviews ?? [],
    review_diff: ({ id, path }: { id: string; path: string }) => over.diffs?.[`${id}:${path}`] ?? "",
  });
}
const open = (messages: any[] = []) =>
  renderApp(
    <ChangesPanel name="Alpha" root="/work/alpha" busy={false} messages={messages} tick={0} onChanged={() => {}} />,
  );
const branchRow = () => document.querySelector(".panel-branch") as HTMLElement;
const head = () => document.querySelector(".panel-head") as HTMLElement;

describe("pending-changes chip", () => {
  it("counts and +/- both come from the pending review copy, not from the project tree", async () => {
    backend({
      stat: " 1 file changed, 40 insertions(+), 40 deletions(-)",
      reviews: [
        [
          { id: "r1", root: "/work/alpha", workspace: "/tmp/ws" },
          [
            { path: "a.ts", binary: false },
            { path: "b.ts", binary: false },
          ],
        ],
      ],
      diffs: { "r1:a.ts": "@@ -1 +1,2 @@\n-a\n+b\n+c", "r1:b.ts": "@@ -1 +0,0 @@\n-x" },
    });
    open();
    expect(await screen.findByRole("button", { name: /Pending changes · 2/ })).toBeInTheDocument();
    await waitFor(() => expect(branchRow()).toHaveTextContent("gustaf/ui-fixes+2−2"));
  });

  it("direct-edit chat: the chip is not called pending, and the numbers are the chat's checkpoint diff with untracked files", async () => {
    backend({ numstat: "5\t1\tsrc/a.ts\0" + "12\t0\tsrc/new.ts\0", stat: " 1 file changed, 1 insertion(+)" });
    open([checkpointMessage]);
    expect(await screen.findByRole("button", { name: "Changed files · 2" })).toBeInTheDocument();
    expect(screen.queryByText(/Pending changes/)).toBeNull();
    await waitFor(() => expect(branchRow()).toHaveTextContent("+17−1"));
  });

  it("no copy and a dirty tree: a neutral chip with the tree's numbers", async () => {
    backend({
      stat: " 2 files changed, 7 insertions(+), 2 deletions(-)",
      status: status([
        { path: "a", kind: "modified" },
        { path: "b", kind: "modified" },
      ]),
    });
    open();
    expect(await screen.findByText("Uncommitted · 2")).toBeInTheDocument();
    expect(screen.queryByText(/Pending changes/)).toBeNull();
    expect(head().querySelector("button.btn-soft")).toBeNull();
    await waitFor(() => expect(branchRow()).toHaveTextContent("+7−2"));
  });

  it("untracked-only changes are counted but never shown as +0 −0", async () => {
    backend({
      stat: "",
      status: status([
        { path: "new.ts", kind: "untracked" },
        { path: "n2.ts", kind: "untracked" },
      ]),
    });
    open();
    expect(await screen.findByText("Uncommitted · 2")).toBeInTheDocument();
    expect(branchRow()).toHaveTextContent("gustaf/ui-fixes");
    expect(branchRow().querySelector(".plus")).toBeNull();
    expect(branchRow().querySelector(".minus")).toBeNull();
  });

  it("clean tree: no chip and no numbers, the branch is still shown", async () => {
    backend();
    open();
    await waitFor(() => expect(branchRow()).toHaveTextContent("gustaf/ui-fixes"));
    expect(within(head()).queryByText(/·/)).toBeNull();
    expect(screen.queryByText(/Pending changes/)).toBeNull();
    expect(branchRow().querySelector(".plus")).toBeNull();
  });
});
