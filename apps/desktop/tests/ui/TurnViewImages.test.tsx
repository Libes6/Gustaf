import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnView } from "../../src/components/chat/TurnView";
import { renderApp } from "./render";

const handlers = { onEdit: vi.fn(), onRegenerate: vi.fn(), onDelete: vi.fn(), onBranch: vi.fn(), onApprovePlan: vi.fn(), onRejectPlan: vi.fn() };
const img = (data: string) => ({ type: "image", data });
const view = (parts: unknown[], meta?: unknown) => {
  const turn = { user: { id: 1, chat_id: 1, created_at: 1, role: "user", parts, meta }, steps: [] } as any;
  const r = renderApp(<TurnView turn={turn} live={false} liveResults={[]} busy={false} isLastTurn handlers={handlers} />);
  return r.container.querySelector(".msg-user") as HTMLElement;
};

describe("TurnView sent message with pictures", () => {
  it("1 picture + text: the picture comes first, outside the text bubble", () => {
    const user = view([{ type: "text", text: "what is this?" }, img("AAAA")]);
    const [first, second] = Array.from(user.children);
    expect(first).toHaveClass("msg-images");
    expect(second).toHaveClass("bubble");
    const pic = screen.getByRole("img", { name: "Attached image 1" });
    expect(first).toContainElement(pic);
    expect(user.querySelector(".bubble img")).toBeNull();
    expect(second.textContent).toBe("what is this?");
    expect(pic.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    // DOM order is the visual order: the picture precedes the text.
    expect(pic.compareDocumentPosition(screen.getByText("what is this?")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("3 pictures share one container, in their original order, each with its own alt text", () => {
    const user = view([{ type: "text", text: "three" }, img("A1"), img("B2"), img("C3")]);
    const box = user.querySelector(".msg-images")!;
    const pics = Array.from(box.querySelectorAll("img"));
    expect(pics.map((p) => p.getAttribute("src"))).toEqual(["data:image/png;base64,A1", "data:image/png;base64,B2", "data:image/png;base64,C3"]);
    expect(pics.map((p) => p.alt)).toEqual(["Attached image 1", "Attached image 2", "Attached image 3"]);
    expect(user.querySelectorAll(".msg-images")).toHaveLength(1);
    expect(user.querySelector(".bubble")?.textContent).toBe("three");
  });

  it("pictures only: no empty bubble", () => {
    const user = view([img("AAAA")]);
    expect(user.querySelector(".msg-images img")).not.toBeNull();
    expect(user.querySelector(".bubble")).toBeNull();
  });

  it("text only: just the bubble, no picture container", () => {
    const user = view([{ type: "text", text: "plain" }]);
    expect(user.querySelector(".msg-images")).toBeNull();
    expect(Array.from(user.children).map((c) => c.className)).toEqual(["bubble"]);
    expect(user.querySelector(".bubble")?.textContent).toBe("plain");
  });
});
