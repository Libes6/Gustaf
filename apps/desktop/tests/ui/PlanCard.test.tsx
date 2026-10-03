import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlanCard } from "../../src/components/chat/PlanCard";
import { TurnView } from "../../src/components/chat/TurnView";
import { serializePlan, type Plan } from "../../src/agent/planCore";
import { renderApp } from "./render";

const plan: Plan = { title: "Add dark mode", steps: [{ id: "1", text: "Add theme tokens", files: ["src/theme.css"] }, { id: "2", text: "Wire the toggle" }], risks: ["Contrast"], questions: ["Persist per project?"] };

describe("PlanCard", () => {
  it("renders the steps as a checklist with risks and questions", () => {
    renderApp(<PlanCard plan={plan} actionable onApprove={() => {}} onReject={() => {}} />);
    const steps = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["Add theme tokenssrc/theme.css", "Wire the toggle"]);
    expect(screen.getByText("Contrast")).toBeInTheDocument();
    expect(screen.getByText("Persist per project?")).toBeInTheDocument();
  });

  it("Approve sends the plan, Reject calls back", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    renderApp(<PlanCard plan={plan} actionable onApprove={onApprove} onReject={onReject} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledWith(plan);
  });

  it("Edit lets the steps be changed, moved, removed and added before approving", async () => {
    const onApprove = vi.fn();
    renderApp(<PlanCard plan={plan} actionable onApprove={onApprove} onReject={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const first = screen.getByRole("textbox", { name: "Step 1" });
    await userEvent.clear(first);
    await userEvent.type(first, "Define tokens");
    await userEvent.click(screen.getByRole("button", { name: "Move step 1 down" }));
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Step 3" }), "Write tests");
    await userEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const sent = onApprove.mock.calls[0][0] as Plan;
    expect(sent.steps.map((s) => [s.id, s.text])).toEqual([["1", "Define tokens"], ["2", "Write tests"]]);
  });

  it("offers no actions when it is not the latest plan", () => {
    renderApp(<PlanCard plan={plan} actionable={false} onApprove={() => {}} onReject={() => {}} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("TurnView plan blocks", () => {
  const turn = (text: string) => ({ user: { id: 1, chat_id: 1, created_at: 1, role: "user", parts: [{ type: "text", text: "plan it" }] }, steps: [{ id: 2, chat_id: 1, created_at: 2, role: "assistant", parts: [{ type: "text", text }] }] }) as any;
  const handlers = { onEdit: vi.fn(), onRegenerate: vi.fn(), onDelete: vi.fn(), onBranch: vi.fn(), onApprovePlan: vi.fn(), onRejectPlan: vi.fn() };
  const view = (text: string, busy = false) => renderApp(<TurnView turn={turn(text)} live={false} liveResults={[]} busy={busy} isLastTurn handlers={handlers} />);

  it("shows a plan card for a valid mcode-plan block and Approve reaches the handler", async () => {
    view(`Findings.\n\n${serializePlan(plan)}`);
    expect(screen.getByText("Findings.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(handlers.onApprovePlan).toHaveBeenCalledWith(plan);
  });

  it("falls back to Markdown for an unparsable block", () => {
    view("```mcode-plan\n{not json\n```");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("{not json")).toBeInTheDocument();
  });

  it("does not offer Approve while a run is active", () => {
    view(serializePlan(plan), true);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
