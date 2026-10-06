import * as chatData from "../../src/lib/data";
import { joinChatReferences, freezeChat } from "../../src/lib/chatContext";
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
  supports?: { computer: boolean; reasoning: boolean; levels?: ("low" | "medium" | "high" | "xhigh" | "max")[] };
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

describe("Composer mode menu", () => {
  it("offers modes in the plus menu and retains the selection", async () => {
    const seen: string[] = [];
    renderApp(<Harness onModeChange={m => seen.push(m)} />);
    const plus = screen.getByRole("button", { name: "Attach" });
    await userEvent.click(plus);
    expect(screen.getByRole("menuitemradio", { name: /^Agent/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Plan/ }));
    expect(seen).toEqual(["plan"]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(plus);
    expect(screen.getByRole("menuitemradio", { name: /^Plan/ })).toHaveAttribute("aria-checked", "true");
    screen.getByRole("menuitemradio", { name: /^Plan/ }).focus();
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: /^Plan/ }), { key: "ArrowUp" });
    expect(screen.getByRole("menuitemradio", { name: /^Ask/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(seen).toEqual(["plan", "ask"]);
  });
  it("toggles closed on a repeated trigger click and restores focus on Escape", async () => {
    renderApp(<Harness />);
    const plus = screen.getByRole("button", { name: "Attach" });
    await userEvent.click(plus);
    await userEvent.click(plus);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(plus);
    await userEvent.keyboard("{Escape}");
    expect(plus).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
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

  it("shows the effort level on the model chip only when the model supports it, and never a Computer Use chip", () => {
    const { unmount } = renderApp(<Harness />, makeApp({ providers: [provider()] }));
    expect(screen.queryByText("Medium")).not.toBeInTheDocument();
    unmount();
    renderApp(<Harness supports={{ computer: true, reasoning: true }} />, makeApp({ providers: [provider()] }));
    expect(screen.getByRole("button", { name: "Model One Medium" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Computer use/i })).not.toBeInTheDocument();
  });

  it("the model chip opens a menu listing the model's effort levels with the current one checked", async () => {
    const app = makeApp({ providers: [provider()], selection: { providerId: "p1", model: "m1" }, models: [model] });
    renderApp(<Harness supports={{ computer: false, reasoning: true }} />, app);
    await userEvent.click(screen.getByRole("button", { name: "Model One Medium" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Reasoning effort")).toBeInTheDocument();
    const levels = within(menu).getAllByRole("menuitemradio");
    expect(levels.map((el) => el.querySelector(".grow > span")?.textContent)).toEqual(["Low", "Medium", "High"]);
    expect(within(menu).getByRole("menuitemradio", { name: /^Medium/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /^Low/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /^High/ }));
    expect(app.setReasoning).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("the effort menu works from the keyboard and leads to the model list", async () => {
    const app = makeApp({ providers: [provider()], selection: { providerId: "p1", model: "m1" }, models: [model] });
    renderApp(<Harness supports={{ computer: false, reasoning: true }} />, app);
    const chip = screen.getByRole("button", { name: "Model One Medium" });
    chip.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitemradio", { name: /^Medium/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(app.setReasoning).toHaveBeenCalledWith("high");
    await userEvent.click(chip);
    await userEvent.click(screen.getByRole("menuitem", { name: /Choose model/ }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
  });

  it("uses the model's own levels and shows a level from another model as the nearest one", async () => {
    const all = ["low", "medium", "high", "xhigh", "max"] as const;
    const app = makeApp({ providers: [provider()], selection: { providerId: "p1", model: "m1" }, models: [model], reasoning: "max" });
    const { unmount } = renderApp(<Harness supports={{ computer: false, reasoning: true, levels: [...all] }} />, app);
    await userEvent.click(screen.getByRole("button", { name: "Model One Max" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
    expect(screen.getByRole("menuitemradio", { name: /^Max/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Extra high/ }));
    expect(app.setReasoning).toHaveBeenCalledWith("xhigh");
    unmount();
    renderApp(<Harness supports={{ computer: false, reasoning: true, levels: ["low", "medium", "high"] }} />, makeApp({ providers: [provider()], reasoning: "xhigh" }));
    await userEvent.click(screen.getByRole("button", { name: "Model One High" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(screen.getByRole("menuitemradio", { name: /^High/ })).toHaveAttribute("aria-checked", "true");
  });

  it("uses Russian level names in the effort menu", async () => {
    renderApp(<Harness supports={{ computer: false, reasoning: true }} />, makeApp({ providers: [provider()], reasoning: "low" }), "ru");
    await userEvent.click(screen.getByRole("button", { name: /Лёгкое/ }));
    expect(screen.getByText("Вдумчивость")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^Лёгкое/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /^Глубокое/ })).toBeInTheDocument();
  });

  it("without effort levels the model chip opens the model list directly, with no effort section", async () => {
    renderApp(<Harness />, makeApp({ providers: [provider()], selection: { providerId: "p1", model: "m1" }, models: [model] }));
    await userEvent.click(screen.getByRole("button", { name: "Model One" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
  });

  it("the bar holds only mode, access, context ring, model, mic and send: no Computer Use or Review copy chip", () => {
    // Everything that used to add a chip is on: a project, a computer-capable model, Computer Use and the review copy.
    const { container } = renderApp(
      <Harness root="/work/alpha" supports={{ computer: true, reasoning: false }} />,
      makeApp({ computerUse: true, reviewCopy: true, providers: [provider()], selection: { providerId: "p1", model: "m1" }, models: [model] }),
    );
    const bar = container.querySelector(".composer-bar")!;
    expect(bar.querySelector(".composer-mode")).toHaveTextContent("Agent");
    // Keyboard (DOM) order: attach menu, access, context ring, model, voice input, send.
    expect(within(bar as HTMLElement).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())).toEqual([
      "Attach", "Ask for commands", "Context: about 1,234 tokens, 1% of the window", "Model One", "Voice input", "Send",
    ]);
    expect(screen.queryByText(/Computer use/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Review copy/i)).not.toBeInTheDocument();
  });

  it("the context ring popover says Computer Use is on when it is on (and the model can use it), else nothing", async () => {
    const supports = { computer: true, reasoning: false };
    const on = renderApp(<Harness supports={supports} />, makeApp({ computerUse: true }));
    await userEvent.click(on.container.querySelector(".chip.ctx")!);
    expect(screen.getByText("Computer Use on")).toBeInTheDocument();
    on.unmount();

    const off = renderApp(<Harness supports={supports} />, makeApp({ computerUse: false }));
    await userEvent.click(off.container.querySelector(".chip.ctx")!);
    expect(screen.getByText("Compress chat")).toBeInTheDocument();
    expect(screen.queryByText("Computer Use on")).not.toBeInTheDocument();
    off.unmount();

    // On, but this model has no computer support: the agent gets no computer tools, so nothing is claimed.
    const unsupported = renderApp(<Harness supports={{ computer: false, reasoning: false }} />, makeApp({ computerUse: true }));
    await userEvent.click(unsupported.container.querySelector(".chip.ctx")!);
    expect(screen.getByText("Compress chat")).toBeInTheDocument();
    expect(screen.queryByText("Computer Use on")).not.toBeInTheDocument();
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

describe("Composer slash commands", () => {
  it("selects a command with keyboard without sending and accepts arguments afterwards", async () => {
    const send = vi.fn();
    renderApp(<Harness onSend={send} />);
    await userEvent.type(box(), "/rev");
    expect(await screen.findByRole("option", { name: /\/review/ })).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box()).toHaveValue("/review ");
    expect(send).not.toHaveBeenCalled();
    await userEvent.type(box(), "src/main.ts");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("Escape dismisses suggestions without changing the draft", async () => {
    renderApp(<Harness />);
    await userEvent.type(box(), "/ex");
    expect(await screen.findByRole("option", { name: /\/explain/ })).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box()).toHaveValue("/ex");
  });
});


describe("Screenshot paste",()=>{
 it("accepts clipboard image items even when files collection is empty",async()=>{
 const {container}=renderApp(<Harness/>);
 const file=new File(["screenshot"],"Screenshot.png",{type:"image/png"});
 fireEvent.paste(box(),{clipboardData:{files:[],items:[{kind:"file",type:"image/png",getAsFile:()=>file}]}});
 await vi.waitFor(()=>expect(container.querySelector(".attach img")).not.toBeNull());
 expect(box().value).toBe("");
 });
 it("leaves ordinary text paste to the textarea",()=>{renderApp(<Harness/>);const event=new Event("paste",{bubbles:true,cancelable:true});Object.defineProperty(event,"clipboardData",{value:{files:[],items:[]}});box().dispatchEvent(event);expect(event.defaultPrevented).toBe(false);});
});

describe("Composer image viewer", () => {
  it("opens a thumbnail in a dialog, closes on Esc and returns focus; remove does not open", async () => {
    const { container } = renderApp(<Harness images={["AAAA", "BBBB"]} />);
    const thumb = screen.getByRole("button", { name: "Attached image 1 of 2" });
    await userEvent.click(thumb);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByAltText("Attached image 1 of 2")).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(within(dialog).getByRole("button", { name: "Close image" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(thumb).toHaveFocus();
    thumb.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close image" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(container.querySelectorAll<HTMLButtonElement>(".attach button")[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelectorAll(".attach img")).toHaveLength(1);
  });
});


describe("chat reference attachments", () => {
  it("accepts sidebar drag, offers full or short versions and previews the chosen snapshot", async () => {
    const read = vi.spyOn(chatData, "loadMessages").mockResolvedValue([{ id: 1, chat_id: 5, created_at: 0, role: "user", parts: [{ type: "text", text: "a".repeat(30_000) }] }]);
    const app = makeApp({ chats: [{ id: 5, title: "Large source", project_id: null }] });
    const { container } = renderApp(<Harness />, app);
    fireEvent.drop(container.querySelector(".composer")!, { dataTransfer: { getData: () => "5", files: [] } });
    await screen.findByRole("button", { name: "Attach shortened version" });
    expect(screen.getByRole("button", { name: "Attach full version" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Attach shortened version" }));
    expect(box().value).toBe("");
    await userEvent.click(screen.getByText("Exact text to send"));
    expect(screen.getByText(/Middle omitted by user choice/)).toBeInTheDocument();
    read.mockRestore();
  });

  it("shows an exact snapshot separate from textarea, preserves it while typing and removes it", async () => {
    const ref = freezeChat(5, "Source chat", [{ role: "user", parts: [{ type: "text", text: "frozen content" }] }]);
    renderApp(<Harness text={joinChatReferences("Question", [ref])} />);
    expect(box().value).toBe("Question");
    await userEvent.click(screen.getByText("Exact text to send"));
    expect(screen.getByText("user: frozen content")).toBeInTheDocument();
    await userEvent.type(box(), " edited");
    expect(screen.getByText("user: frozen content")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(screen.queryByText("Source chat")).not.toBeInTheDocument();
    expect(box().value).toBe("Question edited");
  });
  it("offers chats in the @ picker without a project and keeps source navigation", async () => {
    const ref = freezeChat(5, "Source chat", []);
    const app = makeApp({ chats: [{ id: 5, title: "Source chat", project_id: null }] });
    renderApp(<Harness text={joinChatReferences("", [ref])} />, app);
    await userEvent.click(screen.getByRole("button", { name: "Source chat" }));
    expect(app.openChat).toHaveBeenCalledWith(5, null);
    await userEvent.type(box(), "@Source");
    expect(screen.getByRole("option", { name: "💬 Source chat" })).toBeInTheDocument();
  });
});

describe("Composer: large pastes", () => {
  const big = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join("\n");
  const paste = (el: HTMLElement, text: string) => fireEvent.paste(el, { clipboardData: { getData: (type: string) => (type === "text/plain" ? text : ""), items: [], files: [] } });

  it("a large paste becomes a card; the field keeps only what was typed", () => {
    renderApp(<Harness text="check this" />);
    const field = screen.getByRole("textbox", { name: "Ask anything" }) as HTMLTextAreaElement;
    field.setSelectionRange(field.value.length, field.value.length);
    paste(field, big);
    expect(field.value).toBe("check this");
    const card = screen.getByRole("group", { name: "Pasted text" });
    expect(card).toHaveTextContent("40 lines");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("the card can be put back into the message or removed", async () => {
    renderApp(<Harness text="" />);
    const field = screen.getByRole("textbox", { name: "Ask anything" }) as HTMLTextAreaElement;
    paste(field, big);
    await userEvent.click(screen.getByRole("button", { name: "Put into message" }));
    expect(field.value).toBe(big);
    expect(screen.queryByRole("group", { name: "Pasted text" })).not.toBeInTheDocument();
    await userEvent.clear(field);
    paste(field, big);
    await userEvent.click(within(screen.getByRole("group", { name: "Pasted text" })).getByRole("button", { name: "Remove attachment" }));
    expect(screen.queryByRole("group", { name: "Pasted text" })).not.toBeInTheDocument();
  });

  it("a short paste goes into the field as usual", () => {
    renderApp(<Harness text="" />);
    const field = screen.getByRole("textbox", { name: "Ask anything" });
    paste(field, "short");
    expect(screen.queryByRole("group", { name: "Pasted text" })).not.toBeInTheDocument();
  });
});

