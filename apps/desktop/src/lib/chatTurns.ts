import type { StoredMsg } from "./data";

export type Turn = { user?: StoredMsg; steps: StoredMsg[] };

// Imported Cursor chats keep the agent harness wrappers; null means a pure system message.
export function userText(text: string): string | null {
  if (text.includes("<system_notification>")) return null;
  const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
  if (query) return query[1].trim();
  return text.replace(/<(timestamp|attached_files|image_files|system_reminder)>[\s\S]*?<\/\1>/g, "").trim();
}

export function groupTurns(msgs: StoredMsg[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of msgs) {
    if (m.role === "user" || !turns.length) turns.push({ user: m.role === "user" ? m : undefined, steps: [] });
    if (m.role !== "user") turns[turns.length - 1].steps.push(m);
  }
  return turns;
}
