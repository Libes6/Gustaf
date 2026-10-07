import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PrWatchBar } from "../../src/components/chat/PrWatchBar";
import { getQueue } from "../../src/lib/chatQueue";
import { getPrWatch, parseWatchCommand, pollPrWatches, startPrWatch } from "../../src/lib/prWatch";
import { renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const pr = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    state: "OPEN",
    mergeable: "MERGEABLE",
    title: "Add parser",
    url: "https://github.com/o/r/pull/7",
    number: 7,
    author: "me",
    checks: [{ name: "ci", status: "IN_PROGRESS", conclusion: "" }],
    comments: [],
    reviews: [],
    ...over,
  });

describe("PR watch", () => {
  it("parses /watch commands", () => {
    expect(parseWatchCommand("/watch https://github.com/o/r/pull/7")).toBe("https://github.com/o/r/pull/7");
    expect(parseWatchCommand("/watch-pr 12")).toBe("12");
    expect(parseWatchCommand("/watch")).toBeNull();
    expect(parseWatchCommand("please /watch 7")).toBeNull();
  });

  it("a failing check after the baseline queues a wake message and shows in the bar; Stop ends it", async () => {
    mockInvoke({ gh_pr_view: pr() });
    await startPrWatch(41, "/work/alpha", "7");
    expect(callsOf("gh_pr_view")[0]).toEqual({ root: "/work/alpha", pr: "7" });
    renderApp(<PrWatchBar chatId={41} />);
    expect(screen.getByText("#7 Add parser")).toBeInTheDocument();
    await act(() =>
      pollPrWatches(Date.now(), async () =>
        pr({ checks: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] }),
      ),
    );
    const q = getQueue(41)!;
    expect(q.paused).toBe(false);
    expect(q.items[0].text).toMatch(/Checks failed: ci/);
    expect(screen.getByRole("status")).toHaveTextContent("checks 0/1 passed · 1 failing");
    await act(() =>
      pollPrWatches(Date.now(), async () =>
        pr({ checks: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] }),
      ),
    );
    expect(getQueue(41)!.items).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    expect(getPrWatch(41)?.stopped?.reason).toBe("user");
    expect(screen.getByRole("status")).toHaveTextContent("stopped");
  });
});
