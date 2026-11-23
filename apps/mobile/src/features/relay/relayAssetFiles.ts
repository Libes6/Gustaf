import { useAtomValue } from "@effect/atom-react";
import { relayHostFromUrl } from "@t3tools/shared/relayTunnelClient";
import * as Effect from "effect/Effect";
import { Atom, AsyncResult } from "effect/reactivity";
import type { File } from "expo-file-system";

export const isRelayUrl = (url: string) => relayHostFromUrl(url) !== null;

/** Native image, video and PDF views load URLs themselves and cannot reach the tunnel. */
async function downloadRelayFile(url: string, file: File, signal?: AbortSignal): Promise<void> {
  // Loaded on use, so screens that never meet a relay URL skip the tunnel and its native modules.
  const { relayAwareFetch } = await import("./relayLayers");
  const response = await relayAwareFetch(url, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`The computer answered ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal?.throwIfAborted();
  file.create({ intermediates: true, overwrite: true });
  await file.write(bytes);
}

/** Downloads through the tunnel when needed, otherwise lets the platform fetch the URL. */
export async function downloadFile(url: string, file: File, signal: AbortSignal): Promise<void> {
  if (isRelayUrl(url)) return downloadRelayFile(url, file, signal);
  const { File } = await import("expo-file-system");
  await File.downloadFileAsync(url, file, { signal });
}

const localCopies = new Map<string, Promise<string>>();

/**
 * A relay asset URL becomes a file in the cache that native views can open; any other URL
 * is returned as is. One signed URL is downloaded once.
 */
export function localAssetUri(url: string): Promise<string> {
  if (!isRelayUrl(url)) return Promise.resolve(url);
  const hash = url.indexOf("#");
  const resource = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  let copy = localCopies.get(resource);
  if (!copy) {
    copy = cacheRelayAsset(resource);
    localCopies.set(resource, copy);
    copy.catch(() => localCopies.delete(resource));
  }
  return copy.then((uri) => uri + fragment);
}

async function cacheRelayAsset(url: string): Promise<string> {
  const [Crypto, { File, Paths }] = await Promise.all([
    import("expo-crypto"),
    import("expo-file-system"),
  ]);
  const name = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, url);
  const extension = /\.[a-z0-9]{1,8}$/i.exec(new URL(url).pathname)?.[0] ?? "";
  const file = new File(Paths.cache, "relay-assets", `${name}${extension}`);
  await downloadRelayFile(url, file);
  return file.uri;
}

const relayAssetFileAtom = Atom.family((url: string) =>
  Atom.make(Effect.promise(() => localAssetUri(url))).pipe(Atom.withLabel("relay-asset-file")),
);
const NO_RELAY_ASSET_FILE = Atom.make(AsyncResult.initial<string>()).pipe(
  Atom.withLabel("relay-asset-file:none"),
);

/** The cached copy of a relay URL for native views; null for any other URL. */
export function useLocalAssetResult(url: string | null): AsyncResult.AsyncResult<string> | null {
  const relayUrl = url !== null && isRelayUrl(url) ? url : null;
  const result = useAtomValue(
    relayUrl === null ? NO_RELAY_ASSET_FILE : relayAssetFileAtom(relayUrl),
  );
  return relayUrl === null ? null : result;
}

/** The URL a native view can load: a cached copy for relay URLs, the input for others. */
export function useLocalAssetUri(url: string | null): string | null {
  const result = useLocalAssetResult(url);
  if (result === null) return url;
  return AsyncResult.isSuccess(result) ? result.value : null;
}
