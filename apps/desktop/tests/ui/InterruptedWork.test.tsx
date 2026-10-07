import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { describe, expect, it, vi } from "vitest";
import { InterruptedWorkSection } from "../../src/components/InterruptedWork";
import { useStopGuard } from "../../src/lib/stopGuard";
import type { InterruptedWork } from "../../src/lib/interruptedWork";
import { renderApp } from "./render";

const work = (over: Partial<InterruptedWork> = {}): InterruptedWork => ({
  taskId: "w1", branch: "gustaf/parser-fix", path: "/data/wt/w1", commits: 2, files: 3, provider: "claude", model: "opus", createdAt: 1, ...over,
});

// The backend wrapper is replaced (the tests are about what the UI asks for, not about the Tauri bridge).
const wt = vi.hoisted(() => ({ diff: vi.fn(), remove: vi.fn() }));
vi.mock("../../src/lib/worktrees", async (orig) => ({ ...(await orig<typeof import("../../src/lib/worktrees")>()), worktrees: wt }));

const setup = (items: InterruptedWork[]) => {
  wt.diff.mockResolvedValue({ base: "aaa", truncated: false, files: ["a.ts", "b.ts", "c.ts"].map((path) => ({ path, status: "modified", additions: 1, deletions: 0, binary: false })) });
  wt.remove.mockResolvedValue({ removed: true, branchDeleted: true, branchKeptReason: null });
  renderApp(<InterruptedWorkSection root="/work/alpha" items={items} />);
};

describe("InterruptedWorkSection", () => {
  it("lists the branch, commit count and dirty files, and renders nothing without work", async () => {
    setup([work()]);
    const card = screen.getByRole("article", { name: "gustaf/parser-fix" });
    expect(within(card).getByText("2 unmerged commits")).toBeInTheDocument();
    expect(within(card).getByText("3 uncommitted files")).toBeInTheDocument();
    expect(await within(card).findByText("a.ts, b.ts, c.ts")).toBeInTheDocument();
    // Listing never removes anything.
    expect(wt.remove).not.toHaveBeenCalled();
  });

  it("renders nothing when there is no interrupted work", () => {
    setup([]);
    expect(screen.queryByText("Interrupted agent work")).toBeNull();
  });

  it("Open reveals the checkout folder", () => {
    setup([work()]);
    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(revealItemInDir).toHaveBeenCalledWith("/data/wt/w1");
  });

  it("Discard asks first, naming the branch and the lost work; Cancel removes nothing", () => {
    setup([work()]);
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("gustaf/parser-fix");
    expect(dialog).toHaveTextContent("3 uncommitted files");
    expect(dialog).toHaveTextContent("2 unmerged commits");
    expect(wt.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByText("Cancel"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(wt.remove).not.toHaveBeenCalled();
  });

  it("confirming removes the checkout and its branch", async () => {
    setup([work()]);
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard work" }));
    await waitFor(() => expect(wt.remove).toHaveBeenCalledWith({ root: "/work/alpha", taskId: "w1", force: true, deleteBranch: true }));
  });
});

describe("useStopGuard", () => {
  function Probe({ count, onStop, onAgents }: { count: number; onStop: () => void; onAgents: () => void }) {
    const g = useStopGuard(count, onAgents);
    return <><button onClick={() => void Promise.resolve(g.confirmStop()).then((ok) => ok && onStop())}>stop</button>{g.node}</>;
  }

  it("stops at once when no agent is running", async () => {
    let stopped = 0;
    renderApp(<Probe count={0} onStop={() => stopped++} onAgents={() => {}} />);
    fireEvent.click(screen.getByText("stop"));
    await waitFor(() => expect(stopped).toBe(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks \"N agents are running, stop them?\" and stops nothing until confirmed", async () => {
    let stopped = 0; let agents = 0;
    renderApp(<Probe count={3} onStop={() => stopped++} onAgents={() => agents++} />);
    fireEvent.click(screen.getByText("stop"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("3 agents are running, stop them?");
    expect(stopped + agents).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop agents" }));
    await waitFor(() => expect(stopped).toBe(1));
    expect(agents).toBe(1);
  });

  it("keeping the agents running cancels the stop", async () => {
    let stopped = 0; let agents = 0;
    renderApp(<Probe count={2} onStop={() => stopped++} onAgents={() => agents++} />);
    fireEvent.click(screen.getByText("stop"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep running" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stopped + agents).toBe(0);
  });
});
