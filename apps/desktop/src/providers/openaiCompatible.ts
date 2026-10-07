import { resolveKey, type KeySource } from "../lib/keys";
import { modelMetadata } from "../lib/context";
import { tokenUsage } from "./usage";
import { openRouterEffort, pickLevel, reportedEffort, specLevels } from "./reasoning";
import { request, sse } from "./http";
import { streamError, withRetry } from "./retry";
import { flattenMsg, type Adapter, type Msg, type Part, type ProviderConfig, type TurnInput } from "./types";

function toChat(system: string, messages: Msg[], providerId: string) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const native = m.meta?.provider === providerId;
    if (m.role === "user") {
      const imgs = m.parts.filter((p) => p.type === "image");
      const text = flattenMsg(m);
      out.push({
        role: "user",
        content: imgs.length
          ? [
              { type: "text", text },
              ...imgs.map((p: any) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${p.data}` } })),
            ]
          : text,
      });
    } else if (m.role === "assistant" && native) {
      const calls = m.parts.filter((p) => p.type === "tool_call") as Extract<Part, { type: "tool_call" }>[];
      out.push({
        role: "assistant",
        content:
          m.parts
            .filter((p) => p.type === "text")
            .map((p: any) => p.text)
            .join("") || null,
        tool_calls: calls.length
          ? calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            }))
          : undefined,
      });
    } else if (m.role === "tool" && out[out.length - 1]?.tool_calls) {
      for (const p of m.parts)
        if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.id, content: p.output });
    } else {
      out.push({ role: m.role === "assistant" ? "assistant" : "user", content: flattenMsg(m) });
    }
  }
  return out;
}

/** Chat Completions: OpenRouter, Ollama, LM Studio and any OpenAI-compatible endpoint. */
export function openaiCompatible(cfg: ProviderConfig, key: KeySource): Adapter {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.kind === "openrouter") headers["X-Title"] = "Gustaf";
  // The key is read on the first request that needs it (lib/keys.ts), not when the adapter is built.
  const authHeaders = async () => {
    const k = await resolveKey(key);
    return k ? { ...headers, Authorization: `Bearer ${k}` } : headers;
  };

  return {
    supportsComputer: false,
    // Only OpenRouter reports per-model support (`supported_parameters`); other endpoints get no effort field.
    supportsReasoning: (model) => specLevels(reportedEffort(cfg.id, model)).length > 0,
    reasoningLevels: (model) => specLevels(reportedEffort(cfg.id, model)),

    async listModels() {
      const res = await request(`${base}/models`, { headers: await authHeaders() });
      const j = await res.json();
      return (j.data ?? []).map((m: any) => ({
        id: m.id,
        name: m.name ?? m.id,
        providerId: cfg.id,
        created: (m.created ?? 0) * 1000,
        ...modelMetadata(m),
        ...(cfg.kind === "openrouter" ? { effort: openRouterEffort(m.supported_parameters) } : {}),
      }));
    },

    async turn(t: TurnInput) {
      const body: any = {
        model: t.model,
        messages: toChat(t.system, t.messages, cfg.id),
        stream: true,
        stream_options: { include_usage: true },
      };
      const effort = pickLevel(t.reasoning, specLevels(reportedEffort(cfg.id, t.model)));
      if (effort) body.reasoning = { effort };
      if (t.tools.length)
        body.tools = t.tools.map((d) => ({
          type: "function",
          function: { name: d.name, description: d.description, parameters: d.parameters },
        }));
      const { text, calls, usage } = await withRetry(
        async (onText) => {
          const res = await request(`${base}/chat/completions`, {
            method: "POST",
            headers: await authHeaders(),
            body: JSON.stringify(body),
            signal: t.signal,
          });
          let usage;
          let text = "";
          const calls: { id: string; name: string; args: string }[] = [];
          for await (const ev of sse(res, t.signal)) {
            if (ev.error) throw streamError(ev.error);
            if (ev.usage) usage = tokenUsage(ev.usage);
            const d = ev.choices?.[0]?.delta;
            if (!d) continue;
            if (d.content) {
              text += d.content;
              onText(d.content);
            }
            for (const tc of d.tool_calls ?? []) {
              const c = (calls[tc.index ?? 0] ??= { id: "", name: "", args: "" });
              if (tc.id) c.id = tc.id;
              if (tc.function?.name) c.name += tc.function.name;
              if (tc.function?.arguments) c.args += tc.function.arguments;
            }
          }
          return { text, calls, usage };
        },
        { signal: t.signal, onText: t.onText, onRetry: t.onRetry },
      );
      const parts: Part[] = text ? [{ type: "text", text }] : [];
      for (const c of calls) {
        if (!c) continue;
        let args = {};
        try {
          args = JSON.parse(c.args || "{}");
        } catch {}
        parts.push({ type: "tool_call", id: c.id || crypto.randomUUID(), name: c.name, args });
      }
      return { parts, usage };
    },
  };
}
