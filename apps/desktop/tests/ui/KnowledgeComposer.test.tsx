import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/chat/Composer";
import { useChatKnowledge } from "../../src/lib/useChatKnowledge";
import { makeApp, provider, renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const col = (id: string, name: string, chunks: number) => ({
  id,
  name,
  sources: [],
  include: [],
  config: {},
  createdAt: 1,
  consentedAt: 1,
  indexing: false,
  status: { state: "ready", files: 1, chunks, bytes: 1, indexedAt: 1, issues: [], warnings: [], lastError: null },
});
const model = {
  id: "m1",
  name: "Model One",
  providerId: "p1",
  contextWindow: 200_000,
  images: true,
  tools: true,
  created: 1,
  firstSeen: 1,
};

function Harness({ chatId, onManage }: { chatId: number | null; onManage?: () => void }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const knowledge = useChatKnowledge(chatId);
  return (
    <Composer
      text={text}
      setText={setText}
      images={images}
      setImages={setImages}
      taRef={taRef}
      visible
      root={null}
      projectName={undefined}
      files={[]}
      provider={provider()}
      selectedModel={model}
      modelName="Model One"
      supports={{ computer: false, reasoning: false }}
      running={false}
      mode="agent"
      onModeChange={() => {}}
      onSend={() => {}}
      onStop={() => {}}
      contextTokens={0}
      lastInput={undefined}
      canCompact={false}
      canRestore={false}
      onCompact={() => {}}
      onRestore={() => {}}
      knowledge={{ ...knowledge, onManage }}
    />
  );
}
/** Settings stored through the `settings` table stand-in. */
function settingsBackend(collections: unknown[], initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  mockInvoke({
    knowledge_list: () => collections,
    db_select: ({ sql, params }: any) =>
      /from settings where key/.test(sql) && String(params[0]) in store
        ? [{ value: JSON.stringify(store[String(params[0])]) }]
        : [],
    db_execute: ({ params }: any) => {
      store[String(params[0])] = JSON.parse(params[1]);
      return [1, 1];
    },
  });
  return store;
}

describe("Composer knowledge picker", () => {
  it("toggles collections for the chat from the plus menu and persists the choice", async () => {
    const store = settingsBackend([col(A, "Team wiki", 5), col(B, "Papers", 0)]);
    renderApp(<Harness chatId={7} />, makeApp());
    const plus = screen.getByRole("button", { name: "Attach" });
    await waitFor(() => expect(callsOf("knowledge_list").length).toBeGreaterThan(0));
    await userEvent.click(plus);
    expect(screen.getByText("Knowledge")).toBeInTheDocument();
    const wiki = await screen.findByRole("menuitemradio", { name: /Team wiki/ });
    expect(wiki).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemradio", { name: /Papers/ })).toHaveTextContent("Not indexed yet");
    await userEvent.click(wiki);
    await waitFor(() => expect(store.chatKnowledge).toEqual({ "7": [A] }));
    await userEvent.click(plus);
    expect(await screen.findByRole("menuitemradio", { name: /Team wiki/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Team wiki/ }));
    await waitFor(() => expect(store.chatKnowledge).toEqual({}));
  });

  it("restores the stored selection of a chat", async () => {
    settingsBackend([col(A, "Team wiki", 5)], { chatKnowledge: { "9": [A] } });
    renderApp(<Harness chatId={9} />, makeApp());
    await waitFor(() => expect(callsOf("knowledge_list").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: /Team wiki/ })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("keeps the choice of a chat that does not exist yet in memory only", async () => {
    const store = settingsBackend([col(A, "Team wiki", 5)]);
    renderApp(<Harness chatId={null} />, makeApp());
    await waitFor(() => expect(callsOf("knowledge_list").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Team wiki/ }));
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByRole("menuitemradio", { name: /Team wiki/ })).toHaveAttribute("aria-checked", "true");
    expect(store.chatKnowledge).toBeUndefined();
  });

  it("offers setup when there are no collections", async () => {
    settingsBackend([]);
    const manage = vi.fn();
    renderApp(<Harness chatId={1} onManage={manage} />, makeApp());
    await waitFor(() => expect(callsOf("knowledge_list").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Set up knowledge collections/ }));
    expect(manage).toHaveBeenCalled();
  });
});
