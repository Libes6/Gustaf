import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/api", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/api")>()),
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async (_k: string, d: unknown) => d),
}));
const { GoalBar } = await import("../../src/components/chat/GoalBar");
const { getGoal, setGoal } = await import("../../src/lib/goalStore");
const { getQueue, updateQueue } = await import("../../src/lib/chatQueue");
const { continuePrompt, newGoal } = await import("../../src/lib/goalCore");
const { renderApp } = await import("./render");

describe("GoalBar", () => {
  beforeEach(async () => {
    await setGoal(5, { ...newGoal("make CI green", 1, 20), turns: 2, tokens: 1500 });
    await updateQueue(5, () => ({
      items: [
        { id: "c", text: continuePrompt({ ...newGoal("make CI green", 1), turns: 2 }), images: [], clarify: false },
        { id: "u", text: "user note", images: [], clarify: false },
      ],
      paused: false,
    }));
  });

  it("shows the objective, status, turns and tokens; Pause drops the queued continuation only", async () => {
    renderApp(<GoalBar chatId={5} running />);
    expect(screen.getByText("make CI green")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Working · turn 2 of 20 · 1,500 tokens");
    await userEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(getGoal(5)?.status).toBe("paused");
    expect(getQueue(5)?.items.map((i) => i.id)).toEqual(["u"]);
    expect(screen.getByRole("button", { name: /Resume/ })).toBeInTheDocument();
  });

  it("Resume queues the next turn when idle; Clear removes the goal", async () => {
    await setGoal(5, { ...getGoal(5)!, status: "paused", note: "limit" });
    renderApp(<GoalBar chatId={5} running={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Paused · turn limit reached");
    await userEvent.click(screen.getByRole("button", { name: /Resume/ }));
    expect(getGoal(5)?.status).toBe("active");
    const q = getQueue(5)!;
    expect(q.paused).toBe(false);
    expect(q.items[q.items.length - 1]?.text).toMatch(/^Continue working toward the goal: make CI green/);
    expect(q.items.filter((i) => i.text.startsWith("Continue")).length).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    expect(getGoal(5)).toBeNull();
    expect(screen.queryByText("make CI green")).not.toBeInTheDocument();
  });
});
