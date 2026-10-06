import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Markdown } from "../../src/components/Markdown";
import { renderApp } from "./render";

it("an html-page block shows the page in a fully sandboxed frame, with a switch to its source", async () => {
  const { container } = renderApp(<Markdown text={'```html-page title="Report"\n<h1>Totals</h1>\n```'} />);
  const frame = container.querySelector("iframe")!;
  expect(frame).toHaveAttribute("sandbox", "");
  expect(frame).toHaveAttribute("title", "Report");
  expect(frame.getAttribute("srcdoc")).toBe("<h1>Totals</h1>");
  await userEvent.click(screen.getByRole("button", { name: "Show HTML" }));
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.getByText("<h1>Totals</h1>")).toBeInTheDocument();
});

it("a page still being written is not rendered yet", () => {
  const { container } = renderApp(<Markdown text={'```html-page title="Report"\n<h1>Tot'} />);
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Writing the page…");
});
