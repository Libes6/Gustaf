import { OLLAMA_DEFAULT_BASE_URL } from "./settings.ts";

export interface OllamaChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export function ollamaBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  return trimmed.length > 0 ? trimmed : OLLAMA_DEFAULT_BASE_URL;
}

export function modelsFromTags(body: unknown): ReadonlyArray<string> {
  if (typeof body !== "object" || body === null || !("models" in body)) return [];
  const models = body.models;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null || !("name" in entry)) continue;
    if (typeof entry.name !== "string") continue;
    const name = entry.name.trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

export function appendChatDelta(
  text: string,
  line: string,
): { readonly text: string; readonly done: boolean } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { text, done: false };
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null) return { text, done: false };
  const message = "message" in parsed ? parsed.message : undefined;
  const chunk =
    typeof message === "object" &&
    message !== null &&
    "content" in message &&
    typeof message.content === "string"
      ? message.content
      : "";
  return {
    text: text + chunk,
    done: "done" in parsed && parsed.done === true,
  };
}

export function readGenerateResponse(body: unknown): string {
  if (typeof body !== "object" || body === null || !("response" in body)) return "";
  return typeof body.response === "string" ? body.response.trim() : "";
}
