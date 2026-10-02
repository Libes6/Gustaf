import { fetch } from "@tauri-apps/plugin-http";

export { fetch };

export async function ensureOk(res: Response) {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j.error?.message ?? j.message ?? body;
  } catch {}
  throw new Error(`HTTP ${res.status}: ${msg.slice(0, 500)}`);
}

/** Parses a text/event-stream body into JSON payloads. */
export async function* sse(res: Response): AsyncGenerator<any> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}
