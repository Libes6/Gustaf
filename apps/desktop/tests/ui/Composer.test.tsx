import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/chat/Composer";
import type { ModelInfo } from "../../src/providers/types";
import { makeApp, provider, renderApp } from "./render";

const model = { id: "m1", name: "Model One", providerId: "p1", contextWindow: 200_000, images: true, tools: true, created: 1, firstSeen: 1 };

type Over = {
  text?: string;
  images?: string[];
  root?: string | null;
  running?: boolean;
  supports?: { computer: boolean; reasoning: boolean };
  selectedModel?: ModelInfo | undefined;
  canCompact?: boolean;
  onSend?: () => void;
  onStop?: () => void;
  onCompact?: () => void;
  onRestore?: () => void;
  files?: string[];
  onModeChange?: (m: string) => void;
};

/** Holds the text/attachment state the way ChatView does, so typing and removing really change what Composer gets. */
function Harness(o: Over) {
  const [text, setText] = useState(o.text ?? "");
  const [images, setImages] = useState(o.images ?? []);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"ask" | "plan" | "agent">("agent");
  return (
    <Composer
      text={text} setText={setText} images={images} setImages={setImages} taRef={taRef} visible
      root={o.root ?? null} projectName={undefined} files={o.files ?? []}
      provider={provider()} selectedModel={"selectedModel" in o ? o.selectedModel : model} modelName="Model One"
      supports={o.supports ?? { computer: false, reasoning: false }}
      running={o.running ?? false} mode={mode} onModeChange={(m) => { setMode(m); o.onModeChange?.(m); }} onSend={o.onSend ?? (() => {})} onStop={o.onStop ?? (() => {})}
      contextTokens={1234} lastInput={900} canCompact={o.canCompact ?? true} canRestore={false}
      onCompact={o.onCompact ?? (() => {})} onRestore={o.onRestore ?? (() => {})}
    />
  );
}

const sendButton = () => screen.getByRole("button", { name: "Send" });
const box = () => screen.getByPlaceholderText("Ask anything") as HTMLTextAreaElement;

describe("Composer mode switch", () => {
  it("is a labelled radiogroup with Agent selected by default", () => {
    renderApp(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "Chat mode" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Ask", "Plan", "Agent"]);
    expect(within(group).getByRole("radio", { name: "Agent" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Plan" })).not.toBeChecked();
  });

  it("switches on click and with the arrow keys (roving tabindex)", async () => {
    const seen: string[] = [];
    renderApp(<Harness onModeChange={(m) => seen.push(m)} />);
    await userEvent.click(screen.getByRole("radio", { name: "Plan" }));
    expect(screen.getByRole("radio", { name: "Plan" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Plan" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Agent" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Plan" }), { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "Ask" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Ask" })).toHaveFocus();
    expect(seen).toEqual(["plan", "ask"]);
  });
});

describe("Composer", () => {
  it("disables Send while the message is empty or whitespace and enables it with text", async () => {
    renderApp(<Harness />);
    expect(sendButton()).toBeDisabled();
    await userEvent.type(box(), "   ");
    expect(sendButton()).toBeDisabled();
    await userEvent.type(box(), "hi");
    expect(sendButton()).toBeEnabled();
  });

  it("enables Send for an attachment alone", () => {
    renderApp(<Harness images={["AAAA"]} />);
    expect(sendButton()).toBeEnabled();
  });

  it("Enter sends, Shift+Enter inserts a newline instead", async () => {
    const onSend = vi.fn();
    renderApp(<Harness onSend={onSend} />);
    await userEvent.type(box(), "line one{Shift>}{Enter}{/Shift}line two");
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe("line one\nline two");
    await userEvent.type(box(), "{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Enter during IME composition does not send", () => {
    const onSend = vi.fn();
    renderApp(<Harness text="draft" onSend={onSend} />);
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("the Send button calls onSend", async () => {
    const onSend = vi.fn();
    renderApp(<Harness text="go" onSend={onSend} />);
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("while a run is active the button is Stop and Send is gone", async () => {
    const onStop = vi.fn();
    renderApp(<Harness text="x" running onStop={onStop} />);
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("removes one attachment at a time", async () => {
    const { container } = renderApp(<Harness images={["AAAA", "BBBB", "CCCC"]} />);
    const thumbs = () => [...container.querySelectorAll<HTMLImageElement>(".attach img")].map((i) => i.getAttribute("src"));
    expect(thumbs()).toEqual(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB", "data:image/png;base64,CCCC"]);
    await userEvent.click(container.querySelectorAll<HTMLButtonElement>(".attach button")[1]);
    expect(thumbs()).toEqual(["data:image/png;base64,AAAA", "data:image/png;base64,CCCC"]);
    await userEvent.click(container.querySelectorAll<HTMLButtonElement>(".attach button")[0]);
    await userEvent.click(container.querySelectorAll<HTMLButtonElement>(".attach button")[0]);
    expect(container.querySelector(".attach-list")).toBeNull();
    expect(sendButton()).toBeDisabled();
  });

  it("the attach menu offers images only when the model accepts them and @file only inside a project", async () => {
    const { unmount } = renderApp(<Harness root="/work/alpha" />);
    await userEvent.click(screen.getByTitle("Attach"));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Attach image/ })).toBeInTheDocument();
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Mention a file/ })).toBeInTheDocument();
    unmount();

    renderApp(<Harness root="/work/alpha" selectedModel={{ ...model, images: false }} />);
    await userEvent.click(screen.getByTitle("Attach"));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: /Attach image/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Mention a file/ })).toBeInTheDocument();
  });

  it("outside a project the attach menu has no @file entry", async () => {
    renderApp(<Harness root={null} />);
    await userEvent.click(screen.getByTitle("Attach"));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: /Mention a file/ })).not.toBeInTheDocument();
  });

  it("typing @ in a project lists matching files and Enter inserts the highlighted one instead of sending", async () => {
    const onSend = vi.fn();
    renderApp(<Harness root="/work/alpha" files={["src/app.ts", "src/main.ts", "README.md"]} onSend={onSend} />);
    await userEvent.type(box(), "look at @src/m");
    expect(screen.getByRole("option", { name: "src/main.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "README.md" })).not.toBeInTheDocument();
    await userEvent.type(box(), "{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe("look at @src/main.ts ");
  });

  describe("context chip", () => {
    it("shows the estimate and toggles its popover on click", async () => {
      renderApp(<Harness />);
      const chip = screen.getByRole("button", { name: /1,234/ });
      expect(chip).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(/Model window/)).not.toBeInTheDocument();
      await userEvent.click(chip);
      expect(chip).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(/Model window: 200,000/)).toBeInTheDocument();
      expect(screen.getByText(/900/)).toBeInTheDocument();
      await userEvent.click(chip);
      expect(chip).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText(/Model window/)).not.toBeInTheDocument();
    });

    it("closes on Escape and on a click outside, but not on a click inside", async () => {
      renderApp(<Harness />);
      const chip = screen.getByRole("button", { name: /1,234/ });
      await userEvent.click(chip);
      fireEvent.mouseDown(screen.getByText(/Model window/));
      expect(screen.getByText(/Model window/)).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByText(/Model window/)).not.toBeInTheDocument();
      await userEvent.click(chip);
      fireEvent.mouseDown(document.body);
      expect(screen.queryByText(/Model window/)).not.toBeInTheDocument();
    });

    it("compress calls onCompact, and is disabled when there is nothing to compact", async () => {
      const onCompact = vi.fn();
      const { unmount } = renderApp(<Harness onCompact={onCompact} />);
      await userEvent.click(screen.getByRole("button", { name: /1,234/ }));
      await userEvent.click(screen.getByRole("button", { name: "Compress chat" }));
      expect(onCompact).toHaveBeenCalledTimes(1);
      unmount();
      renderApp(<Harness canCompact={false} />);
      await userEvent.click(screen.getByRole("button", { name: /1,234/ }));
      expect(screen.getByRole("button", { name: "Compress chat" })).toBeDisabled();
    });
  });

  describe("model chip", () => {
    it("shows the selected model name", () => {
      renderApp(<Harness />);
      expect(screen.getByRole("button", { name: /Model One/ })).toBeInTheDocument();
    });

    it("without providers it opens the providers page in Settings instead of the picker", async () => {
      const { app } = renderApp(<Harness />, makeApp({ providers: [] }));
      await userEvent.click(screen.getByRole("button", { name: /Model One/ }));
      expect(app.openSettings).toHaveBeenCalledWith("providers");
    });

    it("with providers it opens the picker, and choosing a model selects it and closes the picker", async () => {
      const app = makeApp({
        providers: [provider()],
        models: [{ ...model, id: "m2", name: "Model Two", created: 5, firstSeen: 5 }],
        selection: { providerId: "p1", model: "m1" },
      });
      renderApp(<Harness />, app);
      await userEvent.click(screen.getByRole("button", { name: /Model One/ }));
      const entry = await screen.findByText("Model Two");
      await userEvent.click(entry);
      expect(app.setSelection).toHaveBeenCalledWith({ providerId: "p1", model: "m2" });
      expect(screen.queryByText("Model Two")).not.toBeInTheDocument();
    });
  });

  it("shows the reasoning and computer-use chips only when the model supports them", () => {
    const { unmount } = renderApp(<Harness />);
    expect(screen.queryByRole("button", { name: /Medium/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Computer use/i })).not.toBeInTheDocument();
    unmount();
    renderApp(<Harness supports={{ computer: true, reasoning: true }} />);
    expect(screen.getByRole("button", { name: /Medium/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Computer use/i })).toBeInTheDocument();
  });

  it("the access chip lists the three modes and switches the mode", async () => {
    const { app } = renderApp(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /Ask for commands/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Read only", "Ask for commands✓", "Full access"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Full access/ }));
    expect(app.setAccess).toHaveBeenCalledWith("full");
  });
});
