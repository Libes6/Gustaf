import type { ApprovalRequest, ChatMessage, ServerEvent, ToolActivity } from "@mcode/protocol";

/** Everything the chat screen shows for one chat, built only from `ServerEvent`s and the initial message list. */
export interface ChatState {
  chatId: number;
  messages: ChatMessage[];
  /** Approvals waiting for the user's decision. */
  approvals: ApprovalRequest[];
  running: boolean;
  /** Id of the assistant message currently receiving text (drives the streaming placeholder). */
  streamingMessageId: number | null;
  error?: string;
}

export function initialChatState(chatId: number, messages: ChatMessage[] = [], running = false): ChatState {
  return { chatId, messages, approvals: [], running, streamingMessageId: null };
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === next.id);
  if (i < 0) return [...messages, next];
  const old = messages[i]!;
  // A delta may have created the placeholder first; keep whichever text is longer so no streamed text is lost.
  const merged: ChatMessage = { ...next, text: old.text.length > next.text.length ? old.text : next.text };
  return messages.map((m, j) => (j === i ? merged : m));
}

function upsertTool(tools: ToolActivity[], tool: ToolActivity): ToolActivity[] {
  const i = tools.findIndex((t) => t.id === tool.id);
  return i < 0 ? [...tools, tool] : tools.map((t, j) => (j === i ? tool : t));
}

function placeholder(chatId: number, id: number): ChatMessage {
  return { id, chatId, role: "assistant", text: "", tools: [], createdAt: Date.now() };
}

/** Pure reducer: returns the same object when the event does not concern this chat or changes nothing. */
export function reduceEvent(state: ChatState, event: ServerEvent): ChatState {
  switch (event.type) {
    case "hello":
      return state;
    case "chat.updated":
      if (event.chat.id !== state.chatId || event.chat.running === state.running) return state;
      return { ...state, running: event.chat.running };
    case "message.created": {
      if (event.message.chatId !== state.chatId) return state;
      const messages = upsertMessage(state.messages, event.message);
      const assistant = event.message.role === "assistant";
      return {
        ...state,
        messages,
        running: assistant ? true : state.running,
        streamingMessageId: assistant ? event.message.id : state.streamingMessageId,
      };
    }
    case "message.delta": {
      if (event.chatId !== state.chatId) return state;
      const exists = state.messages.some((m) => m.id === event.messageId);
      const base = exists ? state.messages : [...state.messages, placeholder(state.chatId, event.messageId)];
      const messages = base.map((m) => (m.id === event.messageId ? { ...m, text: m.text + event.text } : m));
      return { ...state, messages, running: true, streamingMessageId: event.messageId };
    }
    case "tool.updated": {
      if (event.chatId !== state.chatId) return state;
      const exists = state.messages.some((m) => m.id === event.messageId);
      const base = exists ? state.messages : [...state.messages, placeholder(state.chatId, event.messageId)];
      const messages = base.map((m) => (m.id === event.messageId ? { ...m, tools: upsertTool(m.tools, event.tool) } : m));
      return { ...state, messages };
    }
    case "approval.requested": {
      if (event.approval.chatId !== state.chatId) return state;
      if (state.approvals.some((a) => a.approvalId === event.approval.approvalId)) return state;
      return { ...state, approvals: [...state.approvals, event.approval] };
    }
    case "approval.resolved": {
      if (!state.approvals.some((a) => a.approvalId === event.approvalId)) return state;
      return { ...state, approvals: state.approvals.filter((a) => a.approvalId !== event.approvalId) };
    }
    case "run.finished": {
      if (event.chatId !== state.chatId) return state;
      return {
        ...state,
        running: false,
        streamingMessageId: null,
        approvals: [],
        error: event.outcome === "error" ? (event.error ?? "error") : undefined,
      };
    }
  }
}
