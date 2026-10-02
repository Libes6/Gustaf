import { fetch } from "@tauri-apps/plugin-http";
import { requestWith } from "./retry";

export { fetch };
export { ensureOk } from "./retry";
export { sse } from "./sse";

/** One HTTP call through Tauri's fetch: network failures and non-2xx statuses are thrown as classified `ProviderError`s (see retry.ts). */
export const request = (url: string, init?: RequestInit) => requestWith(fetch, url, init);
