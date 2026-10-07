import { requireOptionalNativeModule } from "expo";
import type { PinnedTransport } from "../../../src/api/client.ts";

// JS side of the native module (ios/GustafPinnedModule.swift): HTTPS and WebSocket that accept exactly one certificate,
// the one whose SHA-256 fingerprint was in the pairing QR. Where the native module is missing (Expo Go, tests) `isPinningAvailable` is false and the caller must not pretend the connection is protected.

type NativeSocketEvent = { id: string; data?: string; code?: number; reason?: string };
interface Native {
  request(url: string, method: string, headers: Record<string, string>, body: string | null, fingerprint: string): Promise<{ status: number; body: string }>;
  wsOpen(id: string, url: string, headers: Record<string, string>, fingerprint: string): void;
  wsClose(id: string): void;
  addListener(event: "wsMessage" | "wsClose" | "wsOpen", cb: (e: NativeSocketEvent) => void): { remove(): void };
}

const native = requireOptionalNativeModule<Native>("GustafPinned");

export const isPinningAvailable = native !== null;

let nextSocket = 0;

class PinnedSocket {
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly id = `s${++nextSocket}`;
  private readonly subs: { remove(): void }[] = [];
  private closed = false;

  constructor(url: string, fingerprint: string, headers: Record<string, string>) {
    const n = native!;
    this.subs.push(
      n.addListener("wsMessage", (e) => {
        if (e.id === this.id && typeof e.data === "string") this.onmessage?.({ data: e.data });
      }),
      n.addListener("wsClose", (e) => {
        if (e.id !== this.id) return;
        this.finish();
        this.onclose?.();
      }),
    );
    n.wsOpen(this.id, url, headers, fingerprint);
  }

  close() {
    if (this.closed) return;
    native!.wsClose(this.id);
    this.finish();
  }

  private finish() {
    this.closed = true;
    for (const s of this.subs.splice(0)) s.remove();
  }
}

export const pinnedTransport: PinnedTransport = {
  async fetch(url, init, fingerprint) {
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => { headers[k] = v; });
    const r = await native!.request(url, init.method ?? "GET", headers, typeof init.body === "string" ? init.body : null, fingerprint);
    return new Response(r.status === 204 ? null : r.body, { status: r.status });
  },
  createWebSocket(url, fingerprint, headers) {
    return new PinnedSocket(url, fingerprint, headers) as unknown as WebSocket;
  },
};
