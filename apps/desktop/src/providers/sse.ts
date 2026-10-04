// text/event-stream parser, kept separate from http.ts (which imports Tauri) so it runs under plain Node tests.
import { isAbortError, makeError, networkError } from "./retry.ts";

/**
 * Parses a text/event-stream body into JSON payloads. A connection that breaks mid-stream is reported as a
 * retryable network `ProviderError` (unless the request was aborted, which is rethrown as is).
 */
export async function* sse(res: Response, signal?: AbortSignal): AsyncGenerator<any> {
  if (!res.body) throw makeError("network", { detail: "the response had no body" });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal?.aborted || isAbortError(e)) throw e;
        throw networkError(e);
      }
      if (chunk.done) break;
      // Normalised on the joined buffer: a CRLF pair may be split between two chunks.
      buf = (buf + dec.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        yield ev;
      }
    }
  } finally {
    // Closes the connection when the consumer stops early (an error event, an abort); a no-op after a clean end.
    reader.cancel().catch(() => {});
  }
}
