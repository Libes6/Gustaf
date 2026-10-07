import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TurnView } from "../../src/components/chat/TurnView";
import { renderApp } from "./render";

const handlers = {
  onEdit: vi.fn(),
  onRegenerate: vi.fn(),
  onDelete: vi.fn(),
  onBranch: vi.fn(),
  onApprovePlan: vi.fn(),
  onRejectPlan: vi.fn(),
};
const view = (meta: unknown, onRewind = vi.fn()) => {
  const turn = {
    user: { id: 7, chat_id: 1, created_at: 1, role: "user", parts: [{ type: "text", text: "fix it" }], meta },
    steps: [],
  } as any;
  renderApp(
    <TurnView
      turn={turn}
      live={false}
      liveResults={[]}
      busy={false}
      isLastTurn
      handlers={handlers}
      onRewind={onRewind}
    />,
  );
  return onRewind;
};

describe("TurnView rewind", () => {
  it("with a checkpoint offers keeping the files or restoring them", async () => {
    const onRewind = view({ checkpoint: "abc" });
    await userEvent.click(screen.getByRole("button", { name: "Return to this point" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Return here, keep files/ }));
    expect(onRewind).toHaveBeenLastCalledWith(expect.objectContaining({ id: 7 }), { files: false });
    await userEvent.click(screen.getByRole("button", { name: "Return to this point" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Return here and restore files/ }));
    expect(onRewind).toHaveBeenLastCalledWith(expect.objectContaining({ id: 7 }), { files: true });
  });

  it("without a checkpoint only history can be rewound", async () => {
    view(undefined);
    await userEvent.click(screen.getByRole("button", { name: "Return to this point" }));
    expect(screen.getByRole("menuitem", { name: /keep files/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /restore files/ })).not.toBeInTheDocument();
  });
});
