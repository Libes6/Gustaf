import { flattenMsg, type Msg, type ModelInfo } from "../providers/types.ts";

/** Originals remain stored; a summary starts a fresh provider session. */
export function effectiveHistory<T extends Msg>(messages: T[]): Msg[] {
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].meta?.compacted) {
      boundary = i;
      break;
    }
  if (boundary < 0) return messages;
  return messages.slice(boundary);
}

/** Deliberately an estimate, not billing usage. Images/tool schemas are not counted. */
export function estimateContext(messages: Msg[], draft = "") {
  return Math.ceil((messages.reduce((n, m) => n + flattenMsg(m).length + 16, 0) + draft.length) / 3);
}

/** Split even a single oversized message; no history text is silently dropped. */
export function summaryChunks(messages: Msg[], tokens = 2000): string[] {
  const size = Math.max(256, Math.floor(tokens * 3));
  const chunks: string[] = [];
  let chunk = "";
  for (const m of messages) {
    let text = `${m.role.toUpperCase()}:\n${flattenMsg(m)}${m.parts.some((p) => p.type === "image") ? "\n[Image attachment: pixels omitted from text summary]" : ""}\n\n`;
    while (text) {
      const take = size - chunk.length;
      chunk += text.slice(0, take);
      text = text.slice(take);
      if (chunk.length === size) {
        chunks.push(chunk);
        chunk = "";
      }
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function modelMetadata(m: any): Pick<ModelInfo, "contextWindow" | "images" | "tools"> {
  const context = Number(m.context_length ?? m.context_window ?? m.contextWindow);
  const inputs = m.architecture?.input_modalities ?? m.input_modalities;
  const parameters = m.supported_parameters;
  return {
    contextWindow: Number.isFinite(context) && context > 0 ? context : undefined,
    images: Array.isArray(inputs) ? inputs.includes("image") : undefined,
    tools: Array.isArray(parameters) ? parameters.includes("tools") : undefined,
  };
}
