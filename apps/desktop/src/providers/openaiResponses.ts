import { tokenUsage } from "./usage";
import type { CuAction } from "../lib/api";
import { request, sse } from "./http";
import { makeError, streamError, withRetry } from "./retry";
import { flattenMsg, type Adapter, type Msg, type Part, type ProviderConfig, type TurnInput } from "./types";

function toAction(a: any): CuAction {
  switch (a.type) {
    case "drag":
      return { type: "drag", path: a.path };
    case "keypress":
      return { type: "keypress", keys: a.keys };
    case "wait":
      return { type: "wait", ms: a.ms ?? 1000 };
    default:
      return a;
  }
}

function userContent(m: Msg) {
  return m.parts.flatMap<any>((p) =>
    p.type === "text"
      ? [{ type: "input_text", text: p.text }]
      : p.type === "image"
        ? [{ type: "input_image", image_url: `data:image/png;base64,${p.data}` }]
        : [],
  );
}

/** OpenAI Responses API: function tools plus the native `computer` tool. */
export function openaiResponses(cfg: ProviderConfig, key: string): Adapter {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  function buildInput(messages: Msg[]) {
    let start = 0;
    let previous: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.meta?.provider === cfg.id && m.meta.responseId) {
        previous = m.meta.responseId;
        start = i + 1;
        break;
      }
    }
    const input: any[] = [];
    for (const m of messages.slice(start)) {
      if (m.role === "tool" && previous) {
        for (const p of m.parts) {
          if (p.type !== "tool_result") continue;
          if (p.computer) {
            input.push({
              type: "computer_call_output",
              call_id: p.id,
              output: { type: "computer_screenshot", image_url: `data:image/png;base64,${p.image ?? ""}`, detail: "original" },
            });
          } else {
            input.push({ type: "function_call_output", call_id: p.id, output: p.output });
          }
        }
      } else if (m.role === "user") {
        input.push({ role: "user", content: userContent(m) });
      } else {
        input.push({ role: m.role === "tool" ? "user" : m.role, content: flattenMsg(m) });
      }
    }
    return { input, previous };
  }

  return {
    supportsComputer: true,
    supportsReasoning: (model) => /^(o\d|gpt-5|gpt-6)/.test(model),

    async listModels() {
      const res = await request(`${base}/models`, { headers });
      const j = await res.json();
      return (j.data ?? [])
        .filter((m: any) => !/embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image/.test(m.id))
        .map((m: any) => ({ id: m.id, name: m.id, providerId: cfg.id, created: (m.created ?? 0) * 1000 }));
    },

    async turn(t: TurnInput) {
      const { input, previous } = buildInput(t.messages);
      const acks = new Map<string, any[]>();
      for (const m of t.messages) for (const p of m.parts) if (p.type === "tool_call" && p.computer?.safetyChecks?.length) acks.set(p.id, p.computer.safetyChecks);
      for (const item of input) if (item.type === "computer_call_output" && acks.has(item.call_id)) item.acknowledged_safety_checks = acks.get(item.call_id);

      const tools: any[] = t.tools.map((d) => ({ type: "function", name: d.name, description: d.description, parameters: d.parameters, strict: false }));
      if (t.computer) tools.push({ type: "computer" });
      const body: any = { model: t.model, instructions: t.system, input, tools, stream: true, previous_response_id: previous };
      if (t.reasoning && this.supportsReasoning(t.model)) body.reasoning = { effort: t.reasoning };

      const final = await withRetry(
        async (onText) => {
          const res = await request(`${base}/responses`, { method: "POST", headers, body: JSON.stringify(body), signal: t.signal });
          let final: any;
          for await (const ev of sse(res, t.signal)) {
            if (ev.type === "response.output_text.delta") onText(ev.delta);
            else if (ev.type === "response.completed" || ev.type === "response.incomplete") final = ev.response;
            else if (ev.type === "response.failed") throw streamError({ ...ev.response?.error, message: ev.response?.error?.message ?? "response failed" });
            else if (ev.type === "error") throw streamError({ code: ev.code, message: ev.message ?? "response failed" });
          }
          if (!final) throw makeError("network", { detail: "the stream ended without a response" });
          return final;
        },
        { signal: t.signal, onText: t.onText, onRetry: t.onRetry },
      );

      const parts: Part[] = [];
      for (const item of final.output ?? []) {
        if (item.type === "message") {
          const text = (item.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
          if (text) parts.push({ type: "text", text });
        } else if (item.type === "function_call") {
          let args = {};
          try {
            args = JSON.parse(item.arguments || "{}");
          } catch {}
          parts.push({ type: "tool_call", id: item.call_id, name: item.name, args });
        } else if (item.type === "computer_call") {
          const raw = item.actions ?? (item.action ? [item.action] : []);
          parts.push({
            type: "tool_call",
            id: item.call_id,
            name: "computer",
            args: { actions: raw },
            computer: { actions: raw.map(toAction), safetyChecks: item.pending_safety_checks },
          });
        }
      }
      return { parts, responseId: final.id, usage: tokenUsage(final.usage) };
    },
  };
}
