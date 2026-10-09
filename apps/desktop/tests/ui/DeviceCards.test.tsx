import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../src/agent/agent";
import { ApprovalCard } from "../../src/components/chat/ApprovalCard";
import { ToolCard } from "../../src/components/ToolCard";
import { renderApp } from "./render";

describe("device cards", () => {
  it("asks to use a device, naming it, and offers no always option", async () => {
    const onAnswer = vi.fn();
    const req: ApprovalRequest = {
      kind: "device",
      device: "iPhone 17 Pro (iOS 26.2)",
      text: "Let the agent use iPhone 17 Pro (iOS 26.2): read its screen.",
    };
    renderApp(<ApprovalCard req={req} onAnswer={onAnswer} />);
    expect(screen.getByText("Let the agent use a device?")).toBeInTheDocument();
    expect(screen.getByText(/Let the agent use iPhone 17 Pro/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Always allow|Allow for this task/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Allow/ }));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
  });

  it("asks differently for powering a device off", () => {
    const req: ApprovalRequest = { kind: "device", device: "iPhone", text: "Power off iPhone.", destructive: true };
    renderApp(<ApprovalCard req={req} onAnswer={vi.fn()} />);
    expect(screen.getByText("Power off the device?")).toBeInTheDocument();
  });

  it("shows a device call as a readable row with its screenshot", () => {
    const call = { type: "tool_call" as const, id: "1", name: "device_tap", args: { ref: "@e7" } };
    const result = { type: "tool_result" as const, id: "1", name: "device_tap", output: "Tapped @e7", image: "AAAA" };
    renderApp(<ToolCard call={call} result={result} />);
    expect(screen.getByText("Device")).toBeInTheDocument();
    expect(screen.getByText("tap @e7")).toBeInTheDocument();
  });
});
