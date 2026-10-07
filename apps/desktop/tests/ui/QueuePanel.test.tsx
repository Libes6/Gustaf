import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { QueuePanel } from "../../src/components/chat/QueuePanel";
import { joinChatReferences, splitChatReferences } from "../../src/lib/chatContext";
import type { QueueState } from "../../src/lib/chatQueue";
import { makeApp, renderApp } from "./render";

const reference = { sourceId: 9, title: "Reference", snapshot: "Frozen text", fullSize: 11, shortened: false };
let latest: QueueState;
function Harness({ initial }: { initial: QueueState }) {
  const [queue, setQueue] = useState(initial);
  latest = queue;
  return <QueuePanel queue={queue} onChange={setQueue} />;
}
const setup = (interrupted = false) =>
  renderApp(
    <Harness
      initial={{
        paused: interrupted,
        interrupted,
        items: [
          {
            id: "first",
            text: joinChatReferences("First request", [reference]),
            images: ["persisted-image"],
            clarify: false,
          },
          { id: "second", text: "Second request", images: [], clarify: false },
        ],
      }}
    />,
    makeApp(),
  );

describe("Compact queue", () => {
  it("shows previews and count; edits on demand with keyboard and preserves FIFO attachments", async () => {
    setup();
    expect(screen.getByRole("status")).toHaveTextContent("Queued messages · 2");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);
    const editor = screen.getByRole("textbox");
    await userEvent.clear(editor);
    await userEvent.type(editor, "Updated{Shift>}{Enter}{/Shift}line");
    expect(editor).toHaveValue("Updated\nline");
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(splitChatReferences(latest.items[0].text)).toEqual({ body: "Updated\nline", references: [reference] });
    expect(latest.items[0].images).toEqual(["persisted-image"]);
    expect(latest.items.map((i) => i.id)).toEqual(["first", "second"]);
    expect(screen.getAllByRole("button", { name: "Edit queued message" })[0]).toHaveFocus();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(latest.items.map((i) => i.id)).toEqual(["second"]);
    expect(screen.getByRole("status")).toHaveTextContent("Queued messages · 1");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(latest.items).toEqual([]);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("does not save an empty text-only message through Enter", async () => {
    setup();
    await userEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[1]);
    const editor = screen.getByRole("textbox");
    await userEvent.clear(editor);
    await userEvent.keyboard("{Enter}");
    expect(editor).toBeInTheDocument();
    expect(latest.items[1].text).toBe("Second request");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("cancels edits with Escape and only resumes interrupted work explicitly", async () => {
    setup(true);
    expect(latest.paused).toBe(true);
    await userEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);
    await userEvent.type(screen.getByRole("textbox"), " discard{Escape}");
    expect(splitChatReferences(latest.items[0].text).body).toBe("First request");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resume queue" }));
    expect(latest.paused).toBe(false);
    expect(latest.interrupted).toBe(false);
  });
});
