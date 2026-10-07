import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../src/agent/agent";
import { computerApproval } from "../../src/agent/computerCore";
import { ApprovalCard } from "../../src/components/chat/ApprovalCard";
import type { CuAction } from "../../src/lib/api";
import { renderApp } from "./render";

const command: ApprovalRequest = { kind: "command", command: "npm install left-pad" };
const typeThenEnter: CuAction[] = [
  { type: "type", text: "hello" },
  { type: "keypress", keys: ["Return"] },
];

/** The request the agent loop would build for a computer batch under the given access mode. */
function computerRequest(actions: CuAction[], access: string): ApprovalRequest {
  const d = computerApproval({ actions, access });
  return {
    kind: "computer",
    actions,
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.allowTask ? { allowTask: true } : {}),
  };
}

describe("ApprovalCard", () => {
  it("shows the command and answers allow / deny / always allow", async () => {
    const onAnswer = vi.fn();
    renderApp(<ApprovalCard req={command} onAnswer={onAnswer} />);
    expect(screen.getByText("Run this command?")).toBeInTheDocument();
    expect(screen.getByText("npm install left-pad")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Allow/ }));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    expect(onAnswer).toHaveBeenLastCalledWith(false);
    await userEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(onAnswer).toHaveBeenLastCalledWith(true, true);
    expect(onAnswer).toHaveBeenCalledTimes(3);
  });

  it("answers from the keyboard: Cmd+Enter allows, Escape denies, plain Enter does nothing", () => {
    const onAnswer = vi.fn();
    renderApp(<ApprovalCard req={command} onAnswer={onAnswer} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onAnswer).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onAnswer).toHaveBeenLastCalledWith(false);
  });

  it("stops listening for keys once removed", () => {
    const onAnswer = vi.fn();
    const { unmount } = renderApp(<ApprovalCard req={command} onAnswer={onAnswer} />);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("offers 'Allow for this task' for a risky desktop batch in Full access, and answers always=true", async () => {
    const onAnswer = vi.fn();
    renderApp(<ApprovalCard req={computerRequest(typeThenEnter, "full")} onAnswer={onAnswer} />);
    expect(screen.getByText("Perform these actions on your computer?")).toBeInTheDocument();
    expect(screen.getByText('type "hello" · Return')).toBeInTheDocument();
    expect(screen.getByText(/Pressing Return after typing/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Allow for this task" }));
    expect(onAnswer).toHaveBeenCalledWith(true, true);
    expect(screen.queryByRole("button", { name: "Always allow" })).not.toBeInTheDocument();
  });

  it("does not offer 'Allow for this task' outside Full access", () => {
    for (const access of ["auto", "readonly"]) {
      const { unmount } = renderApp(<ApprovalCard req={computerRequest(typeThenEnter, access)} onAnswer={() => {}} />);
      expect(screen.queryByRole("button", { name: "Allow for this task" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Allow/ })).toBeInTheDocument();
      unmount();
    }
  });

  it("does not offer it when a provider safety check is attached, even in Full access", () => {
    const req: ApprovalRequest = {
      kind: "computer",
      actions: typeThenEnter,
      safety: ["Possible prompt injection on screen"],
    };
    renderApp(<ApprovalCard req={req} onAnswer={() => {}} />);
    expect(screen.getByText(/Possible prompt injection on screen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow for this task" })).not.toBeInTheDocument();
  });

  it("names the subagent that asks", () => {
    renderApp(<ApprovalCard req={{ ...command, agent: "Reviewer" }} onAnswer={() => {}} />);
    expect(screen.getByText(/Reviewer/)).toBeInTheDocument();
  });
});
