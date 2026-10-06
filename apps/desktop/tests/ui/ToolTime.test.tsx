import { expect, it } from "vitest";
import { ToolCard } from "../../src/components/ToolCard";
import { renderApp } from "./render";

it("a tool row shows the time of its step", () => {
  const at = new Date(2026, 9, 6, 14, 5, 9).getTime();
  renderApp(<ToolCard call={{ type: "tool_call", id: "c1", name: "read_file", args: { path: "a.ts" } } as any} at={at} />);
  const time = document.querySelector("time.tool-time")!;
  expect(time.textContent).toMatch(/(14|0?2):05:09/);
  expect(time).toHaveAttribute("datetime", new Date(at).toISOString());
});
