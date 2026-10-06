import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const render = vi.fn(async (_id: string, code: string) => {
  if (code.includes("broken")) throw new Error("Parse error");
  return { svg: `<svg data-testid="diagram"><text>${code.length}</text></svg>` };
});
const initialize = vi.fn();
vi.mock("mermaid", () => ({ default: { initialize, render } }));

const { Markdown } = await import("../../src/components/Markdown");
const { renderApp } = await import("./render");

describe("Mermaid code blocks", () => {
  it("render as a diagram in strict mode, with a switch back to the code", async () => {
    renderApp(<Markdown text={"```mermaid\nflowchart LR\n  A --> B\n```"} />);
    expect(screen.getByText(/flowchart LR/)).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Diagram" })).toBeInTheDocument();
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false }));
    await userEvent.click(screen.getByRole("button", { name: "Show code" }));
    expect(screen.queryByRole("img", { name: "Diagram" })).not.toBeInTheDocument();
    expect(screen.getByText(/flowchart LR/)).toBeInTheDocument();
  });

  it("a diagram that does not parse stays as code with a note", async () => {
    renderApp(<Markdown text={"```mermaid\nbroken\n```"} />);
    expect(await screen.findByText("Can't draw this diagram; showing the code")).toBeInTheDocument();
    expect(screen.getByText("broken")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Diagram" })).not.toBeInTheDocument();
  });

  it("other languages stay ordinary code blocks", async () => {
    renderApp(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    await waitFor(() => expect(render).not.toHaveBeenCalledWith(expect.anything(), "const a = 1;"));
    expect(screen.getByText("ts")).toBeInTheDocument();
  });
});
