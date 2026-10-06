import type { ApprovalDecision, ChatMessage, ChatSummary, ProjectSummary, SendMessageRequest, ServerEvent } from "@mcode/protocol";
import { PROTOCOL_VERSION } from "@mcode/protocol";
import type { ConnectionState, DesktopApi } from "./client.ts";

const DEMO_REPLY =
  "This is a demo reply from the in-memory mock desktop. A real desktop streams the assistant's answer here as it is written. " +
  "Mention “approve” in your message to see an approval card.";

/** In-memory stand-in for the desktop: a few projects and chats, and a fake streaming reply, so every screen works offline. */
export class MockServer implements DesktopApi {
  private readonly listeners = new Set<(e: ServerEvent) => void>();
  private readonly connListeners = new Set<(s: ConnectionState) => void>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 100;
  private state: ConnectionState = "closed";

  private projects: ProjectSummary[] = [
    { id: 1, name: "gustaf", pinned: true },
    { id: 2, name: "website", pinned: false },
  ];
  private chats: ChatSummary[] = [
    { id: 11, projectId: 1, title: "Mobile companion skeleton", archived: false, updatedAt: Date.now() - 3_600_000, running: false },
    { id: 12, projectId: 1, title: "Fix flaky e2e test", archived: false, updatedAt: Date.now() - 86_400_000, running: false },
    { id: 21, projectId: 2, title: "Landing page copy", archived: false, updatedAt: Date.now() - 172_800_000, running: false },
  ];
  private messages = new Map<number, ChatMessage[]>([
    [
      11,
      [
        { id: 1, chatId: 11, role: "user", text: "Scaffold the Expo app.", tools: [], createdAt: Date.now() - 3_700_000 },
        {
          id: 2,
          chatId: 11,
          role: "assistant",
          text: "Done. The app uses **expo-router** with a mock server.\n\n- screens: connection, pairing, projects, chat, settings",
          tools: [{ id: "t-1", tool: "write_file", summary: "apps/mobile/app/_layout.tsx", status: "done" }],
          createdAt: Date.now() - 3_650_000,
        },
      ],
    ],
  ]);

  private emit(e: ServerEvent) {
    for (const l of this.listeners) l(e);
  }
  private setState(s: ConnectionState) {
    this.state = s;
    for (const l of this.connListeners) l(s);
  }

  async listProjects() {
    return this.projects.map((p) => ({ ...p }));
  }
  async listChats(projectId: number) {
    return this.chats.filter((c) => c.projectId === projectId).map((c) => ({ ...c }));
  }
  async listMessages(chatId: number) {
    return (this.messages.get(chatId) ?? []).map((m) => ({ ...m, tools: [...m.tools] }));
  }

  async sendMessage(chatId: number, req: SendMessageRequest) {
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error("not found");
    const list = this.messages.get(chatId) ?? [];
    this.messages.set(chatId, list);
    const user: ChatMessage = { id: this.nextId++, chatId, role: "user", text: req.text, tools: [], createdAt: Date.now() };
    const reply: ChatMessage = { id: this.nextId++, chatId, role: "assistant", text: "", tools: [], createdAt: Date.now() };
    list.push(user, reply);
    this.setRunning(chat, true);
    this.emit({ type: "message.created", message: { ...user } });
    this.emit({ type: "message.created", message: { ...reply } });
    const needsApproval = /approv/i.test(req.text);
    const words = DEMO_REPLY.split(/(?<= )/);
    let i = 0;
    let approved = false;
    const step = () => {
      const word = words[i];
      if (word === undefined) return this.finish(chat, "done");
      if (needsApproval && !approved && i === 2) {
        const tool = { id: `t-${reply.id}`, tool: "bash", summary: "npm test", status: "running" as const };
        this.emit({ type: "tool.updated", chatId, messageId: reply.id, tool });
        this.emit({ type: "approval.requested", approval: { approvalId: `ap-${reply.id}`, chatId, tool: "bash", summary: "npm test" } });
        return; // paused until resolveApproval
      }
      i++;
      reply.text += word;
      this.emit({ type: "message.delta", chatId, messageId: reply.id, text: word });
      this.timers.set(chatId, setTimeout(step, 120));
    };
    this.resume.set(chatId, () => {
      approved = true;
      this.emit({ type: "tool.updated", chatId, messageId: reply.id, tool: { id: `t-${reply.id}`, tool: "bash", summary: "npm test", status: "done" } });
      step();
    });
    this.timers.set(chatId, setTimeout(step, 400));
  }

  private resume = new Map<number, () => void>();

  private setRunning(chat: ChatSummary, running: boolean) {
    chat.running = running;
    chat.updatedAt = Date.now();
    this.emit({ type: "chat.updated", chat: { ...chat } });
  }

  private finish(chat: ChatSummary, outcome: "done" | "stopped") {
    const t = this.timers.get(chat.id);
    if (t) clearTimeout(t);
    this.timers.delete(chat.id);
    this.resume.delete(chat.id);
    this.setRunning(chat, false);
    this.emit({ type: "run.finished", chatId: chat.id, outcome });
  }

  async stop(chatId: number) {
    const chat = this.chats.find((c) => c.id === chatId);
    if (chat?.running) this.finish(chat, "stopped");
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision) {
    const chatId = this.chats.find((c) => approvalId.startsWith("ap-") && c.running)?.id;
    this.emit({ type: "approval.resolved", approvalId, decision });
    if (chatId === undefined) return;
    if (decision === "allow") this.resume.get(chatId)?.();
    else {
      const chat = this.chats.find((c) => c.id === chatId)!;
      this.finish(chat, "stopped");
    }
  }

  connect() {
    if (this.state === "connected") return;
    this.setState("connecting");
    setTimeout(() => {
      this.setState("connected");
      this.emit({ type: "hello", protocol: PROTOCOL_VERSION });
    }, 150);
  }
  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.setState("closed");
  }
  subscribe(l: (e: ServerEvent) => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  onConnection(l: (s: ConnectionState) => void) {
    this.connListeners.add(l);
    return () => void this.connListeners.delete(l);
  }
}
