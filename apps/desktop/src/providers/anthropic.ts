import { tokenUsage } from "./usage";
import type { CuAction } from "../lib/api";
import { request, sse } from "./http";
import { resolveKey, type KeySource } from "../lib/keys";
import { makeError, streamError, withRetry } from "./retry";
import { flattenMsg, type Adapter, type Msg, type Part, type ProviderConfig, type TurnInput } from "./types";
import { anthropicLevels, pickLevel } from "./reasoning";

type XY = [number, number] | undefined;

/** Maps a `computer_toolset_20260801` member call to executor actions. */
export function memberToActions(name: string, input: any, screen: { width: number; height: number }): CuAction[] {
  const c: XY = input.coordinate;
  const at = c ? { x: c[0], y: c[1] } : { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) };
  switch (name) {
    case "left_click":
      return c ? [{ type: "click", ...at }] : [{ type: "mouse_down" }, { type: "mouse_up" }];
    case "right_click":
      return [{ type: "click", ...at, button: "right" }];
    case "middle_click":
      return [{ type: "click", ...at, button: "middle" }];
    case "double_click":
      return [{ type: "double_click", ...at }];
    case "triple_click":
      return [
        { type: "double_click", ...at },
        { type: "click", ...at },
      ];
    case "left_click_drag":
      return [{ type: "drag", path: [{ x: input.start_coordinate[0], y: input.start_coordinate[1] }, at] }];
    case "mouse_move":
      return [{ type: "move", ...at }];
    case "left_mouse_down":
      return [{ type: "mouse_down" }];
    case "left_mouse_up":
      return [{ type: "mouse_up" }];
    case "scroll": {
      const px = (input.scroll_amount ?? 3) * 40;
      const d = input.scroll_direction;
      return [
        {
          type: "scroll",
          ...at,
          scroll_y: d === "up" ? -px : d === "down" ? px : 0,
          scroll_x: d === "left" ? -px : d === "right" ? px : 0,
        },
      ];
    }
    case "type":
      return [{ type: "type", text: input.text ?? "" }];
    case "key":
    case "hold_key": // ponytail: hold_key is sent as a single press; add a timed press/release if a task needs it.
      return Array.from({ length: Math.min(input.repeat ?? 1, 100) }, () => ({
        type: "keypress" as const,
        keys: String(input.text).split("+"),
      }));
    case "wait":
      return [{ type: "wait", ms: Math.min(input.duration ?? 1, 300) * 1000 }];
    default: // screenshot, zoom (ponytail: returns the full screenshot), cursor_position
      return [{ type: "screenshot" }];
  }
}

function toAnthropic(messages: Msg[], providerId: string) {
  const out: { role: "user" | "assistant"; content: any[] }[] = [];
  const push = (role: "user" | "assistant", blocks: any[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    const native = m.meta?.provider === providerId || m.role === "user";
    if (m.role === "assistant" && native) {
      push(
        "assistant",
        m.parts.flatMap<any>((p) =>
          p.type === "text"
            ? p.text
              ? [{ type: "text", text: p.text }]
              : []
            : p.type === "tool_call"
              ? [
                  {
                    type: "tool_use",
                    id: p.id,
                    name: p.name,
                    input: p.args,
                    ...(p.computer ? { toolset_name: "computer" } : {}),
                  },
                ]
              : [],
        ),
      );
    } else if (m.role === "tool" && out[out.length - 1]?.content.some((b) => b.type === "tool_use")) {
      push(
        "user",
        m.parts.flatMap<any>((p) => {
          if (p.type !== "tool_result") return [];
          const content: any[] = [{ type: "text", text: p.output || "OK" }];
          if (p.image)
            content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: p.image } });
          return [
            {
              type: "tool_result",
              tool_use_id: p.id,
              content,
              is_error: p.isError || undefined,
              ...(p.computer ? { toolset_name: "computer" } : {}),
            },
          ];
        }),
      );
    } else if (m.role === "user") {
      push(
        "user",
        m.parts.flatMap<any>((p) =>
          p.type === "text"
            ? [{ type: "text", text: p.text }]
            : p.type === "image"
              ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: p.data } }]
              : [],
        ),
      );
    } else {
      const text = flattenMsg(m);
      if (text) push(m.role === "assistant" ? "assistant" : "user", [{ type: "text", text }]);
    }
  }
  return out;
}

export function anthropic(cfg: ProviderConfig, key: KeySource): Adapter {
  const base = cfg.baseUrl.replace(/\/$/, "");
  // The key is read on the first request that needs it (lib/keys.ts), not when the adapter is built.
  const authHeaders = async () => ({
    "x-api-key": await resolveKey(key),
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "Content-Type": "application/json",
  });
  return {
    supportsComputer: true,
    supportsReasoning: (model) => anthropicLevels(model).length > 0,
    reasoningLevels: anthropicLevels,

    async listModels() {
      const res = await request(`${base}/v1/models?limit=100`, { headers: await authHeaders() });
      const j = await res.json();
      return (j.data ?? []).map((m: any) => ({
        id: m.id,
        name: m.display_name ?? m.id,
        providerId: cfg.id,
        created: Date.parse(m.created_at) || 0,
      }));
    },

    async turn(t: TurnInput) {
      const tools: any[] = t.tools.map((d) => ({
        name: d.name,
        description: d.description,
        input_schema: d.parameters,
      }));
      if (t.computer) tools.push({ type: "computer_toolset_20260801" });
      // Effort goes in output_config (GA); models without effort support get no field. The upper levels think longer, so
      // they get more room before max_tokens cuts the reply (the request streams, so a large cap does not time out).
      const effort = pickLevel(t.reasoning, anthropicLevels(t.model));
      const body = {
        model: t.model,
        max_tokens: effort === "xhigh" || effort === "max" ? 64000 : 16000,
        system: t.system,
        messages: toAnthropic(t.messages, cfg.id),
        tools,
        stream: true,
        ...(effort ? { output_config: { effort } } : {}),
      };
      const { blocks, usageRaw } = await withRetry(
        async (onText) => {
          const blocks: any[] = [];
          let usageRaw = {};
          let stopped = false;
          const res = await request(`${base}/v1/messages`, {
            method: "POST",
            headers: await authHeaders(),
            body: JSON.stringify(body),
            signal: t.signal,
          });
          for await (const ev of sse(res, t.signal)) {
            if (ev.type === "message_start") usageRaw = { ...usageRaw, ...ev.message?.usage };
            else if (ev.type === "message_delta") usageRaw = { ...usageRaw, ...ev.usage };
            else if (ev.type === "content_block_start") blocks[ev.index] = { ...ev.content_block, json: "" };
            else if (ev.type === "content_block_delta") {
              const b = blocks[ev.index];
              if (ev.delta.type === "text_delta") {
                b.text = (b.text ?? "") + ev.delta.text;
                onText(ev.delta.text);
              } else if (ev.delta.type === "input_json_delta") b.json += ev.delta.partial_json;
            } else if (ev.type === "message_stop") stopped = true;
            else if (ev.type === "error") throw streamError(ev.error);
          }
          // A connection closed early would otherwise pass for a complete reply (and a cut tool call would run with partial input).
          if (!stopped) throw makeError("network", { detail: "the stream ended before the reply was complete" });
          return { blocks, usageRaw };
        },
        { signal: t.signal, onText: t.onText, onRetry: t.onRetry },
      );
      const screen = t.computer ?? { width: 1440, height: 900 };
      const parts: Part[] = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
        if (b.type === "tool_use") {
          let args = b.input ?? {};
          try {
            if (b.json) args = JSON.parse(b.json);
          } catch {}
          const isComputer = b.toolset_name === "computer";
          parts.push({
            type: "tool_call",
            id: b.id,
            name: b.name,
            args,
            computer: isComputer ? { actions: memberToActions(b.name, args, screen) } : undefined,
          });
        }
      }
      return { parts, usage: tokenUsage(usageRaw, true) };
    },
  };
}
