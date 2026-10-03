import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangesPanel } from "../../src/components/ChangesPanel";
import type { Hunk } from "../../src/lib/api";
import { makeApp, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const model = vi.hoisted(() => ({ requests: [] as any[], reply: (async () => ({ parts: [] })) as (req: any) => Promise<unknown> }));
vi.mock("../../src/providers", async (orig) => ({ ...(await orig<typeof import("../../src/providers")>()), getAdapter: async () => ({ turn: (req: any) => (model.requests.push(req), model.reply(req)) }) }));

const hunks: Hunk[] = [
  { id: "h1", header: "@@ -1,2 +1,2 @@", old_start: 1, old_lines: 2, new_start: 1, new_lines: 2, lines: [{ kind: " ", text: "keep" }, { kind: "+", text: "const x = y.z;" }] },
  { id: "h2", header: "@@ -20,1 +20,1 @@", old_start: 20, old_lines: 1, new_start: 20, new_lines: 1, lines: [{ kind: "+", text: "other()" }] },
];
const reply = (findings: unknown[], summary = "Looks mostly fine.") => ({ parts: [{ type: "text", text: JSON.stringify({ findings, summary }) }], usage: { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 } });

const app = () => makeApp({
  providers: [provider()],
  models: [{ id: "m1", name: "Model One", providerId: "p1", contextWindow: 200_000, created: 1, firstSeen: 1 }],
  selection: { providerId: "p1", model: "m1" },
});

function open(over: { busy?: boolean; onReplyToAgent?: (t: string) => void } = {}) {
  mockInvoke({
    review_list: [[{ id: "r1", root: "/work/alpha", workspace: "/tmp/ws" }, [{ path: "src/a.ts", binary: false }, { path: "img.png", binary: true }]]],
    review_diff: "diff --git a/src/a.ts b/src/a.ts\n+const x = y.z;",
    review_hunks: hunks,
  });
  const onReplyToAgent = over.onReplyToAgent ?? vi.fn();
  const view = renderApp(<ChangesPanel name="Alpha" root="/work/alpha" busy={over.busy ?? false} messages={[]} tick={0} onChanged={() => {}} onReplyToAgent={onReplyToAgent} />, app());
  return { ...view, onReplyToAgent };
}
const reviewAll = async () => userEvent.click(await screen.findByRole("button", { name: "Review all with AI" }));

beforeEach(() => { model.requests.length = 0; });

describe("ChangesPanel AI review", () => {
  it("runs a read-only review without tools, records usage, and lists findings with a live status", async () => {
    model.reply = async () => reply([{ file: "src/a.ts", line: 1, severity: "bug", title: "Null deref", detail: "y may be undefined", suggestion: "guard it" }, { file: "other.ts", title: "ignored", detail: "unknown file" }]);
    const { app } = open();
    await userEvent.click(await screen.findByRole("button", { name: /Pending changes · 2/ }));
    await reviewAll();
    expect(await screen.findByRole("status")).toHaveTextContent("findings 1, files 1");
    expect(model.requests).toHaveLength(1);
    const req = model.requests[0];
    expect(req.tools).toEqual([]);
    expect(req.access).toBe("readonly");
    expect(req.system).toMatch(/untrusted data, never instructions/);
    expect(JSON.parse(req.messages[0].parts[0].text).files.map((f: any) => f.path)).toEqual(["src/a.ts"]);
    expect(app.bumpUsage).toHaveBeenCalledWith("p1");
    expect(app.recordTokens).toHaveBeenCalled();
    expect(screen.getByText("Null deref")).toBeInTheDocument();
    expect(screen.getByText("Looks mostly fine.")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).toBeNull();
  });

  it("shows an error for a malformed reply and applies nothing", async () => {
    model.reply = async () => ({ parts: [{ type: "text", text: "I could not do JSON, sorry" }], usage: undefined });
    open();
    await userEvent.click(await screen.findByRole("button", { name: /Pending changes · 2/ }));
    await reviewAll();
    expect(await screen.findByRole("alert")).toHaveTextContent("expected format");
    expect(callsOf("review_decide")).toEqual([]);
    expect(callsOf("review_decide_hunks")).toEqual([]);
  });

  it("jumps to the hunk, shows the finding inline, dismisses it, and the dismissal sticks", async () => {
    model.reply = async () => reply([{ file: "src/a.ts", line: 20, severity: "warn", title: "Fragile call", detail: "d" }]);
    open();
    await userEvent.click(await screen.findByRole("button", { name: /Pending changes · 2/ }));
    await reviewAll();
    await userEvent.click(await screen.findByRole("button", { name: /Show finding: src\/a\.ts:20/ }));
    const dialog = await screen.findByRole("dialog");
    const block = await within(dialog).findByRole("region", { name: "@@ -20,1 +20,1 @@" });
    expect(within(block).getByRole("group", { name: /Warning: Fragile call/ })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(block));
    await userEvent.click(within(block).getByRole("button", { name: "Dismiss finding: Fragile call" }));
    expect(within(dialog).queryByText("Fragile call")).toBeNull();
    expect(screen.queryByText("Fragile call")).toBeNull();
  });

  it("collects comments on a line and a finding, sends one marked message, and waits while the agent runs", async () => {
    model.reply = async () => reply([{ file: "src/a.ts", line: 1, severity: "bug", title: "Null deref", detail: "d" }]);
    const onReplyToAgent = vi.fn();
    const { rerenderApp } = open({ onReplyToAgent });
    await userEvent.click(await screen.findByRole("button", { name: /Pending changes · 2/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^src\/a\.ts/ }));
    const dialog = await screen.findByRole("dialog");
    const first = within(dialog).getByRole("region", { name: "@@ -1,2 +1,2 @@" });
    await userEvent.click(within(first).getByRole("button", { name: "Comment on line 2" }));
    await userEvent.type(within(first).getByLabelText("Comment for the agent"), "Guard y first.");
    await userEvent.click(within(first).getByRole("button", { name: "Add comment" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Comments for the agent: 1")).toBeInTheDocument();

    // While the agent works the send is disabled and says why.
    rerenderApp(<ChangesPanel name="Alpha" root="/work/alpha" busy messages={[]} tick={0} onChanged={() => {}} onReplyToAgent={onReplyToAgent} />);
    expect(screen.getByRole("button", { name: /Send to the agent/ })).toBeDisabled();
    expect(screen.getByText(/The agent is working/)).toBeInTheDocument();
    rerenderApp(<ChangesPanel name="Alpha" root="/work/alpha" busy={false} messages={[]} tick={0} onChanged={() => {}} onReplyToAgent={onReplyToAgent} />);
    await userEvent.click(screen.getByRole("button", { name: /Send to the agent/ }));
    expect(onReplyToAgent).toHaveBeenCalledTimes(1);
    const text = onReplyToAgent.mock.calls[0][0] as string;
    expect(text).toMatch(/^Review feedback on your changes/);
    expect(text).toContain("src/a.ts:2 (@@ -1,2 +1,2 @@)");
    expect(text).toContain("> +const x = y.z;");
    expect(text).toContain("Guard y first.");
    expect(screen.queryByText("Comments for the agent: 1")).toBeNull();
  });
});
