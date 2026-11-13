import {
  generateNoiseKeyPair,
  noiseKeyPairFromSecret,
  relaySafetyCode,
} from "@t3tools/shared/relayNoise";
import {
  type RelayPairingOffer,
  fromBase64Url,
  parseRelayPairingLink,
  toBase64Url,
} from "@t3tools/shared/relayTunnel";
import {
  RelayTunnelClient,
  RelayTunnelClientError,
  relayVirtualBaseUrl,
} from "@t3tools/shared/relayTunnelClient";
import * as SecureStore from "expo-secure-store";

import { loadPhoneDevice } from "../account/accountStorage";
import { relayTunnels } from "./relayPool";

// The phone's Noise key never leaves the keychain; computers know it as this phone.
const PHONE_KEY_STORAGE = "gustaf.relay.phone-key";
const HOSTS_STORAGE = "gustaf.relay.hosts";

interface RelayHostRecord {
  readonly relayUrl: string;
  readonly hostKey: string;
  readonly hostName: string;
}

async function phoneNative() {
  const [{ getRandomBytes }, { phoneDisplayName }] = await Promise.all([
    import("expo-crypto"),
    import("../account/useAccount"),
  ]);
  return { name: phoneDisplayName(), randomBytes: (length: number) => getRandomBytes(length) };
}

async function phoneKeyPair() {
  const stored = await SecureStore.getItemAsync(PHONE_KEY_STORAGE);
  if (stored) return noiseKeyPairFromSecret(fromBase64Url(stored));
  const created = generateNoiseKeyPair((await phoneNative()).randomBytes);
  await SecureStore.setItemAsync(PHONE_KEY_STORAGE, toBase64Url(created.secretKey));
  return created;
}

async function loadHosts(): Promise<Record<string, RelayHostRecord>> {
  const raw = await SecureStore.getItemAsync(HOSTS_STORAGE);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, RelayHostRecord>;
  } catch {
    return {};
  }
}

async function saveHost(offer: RelayPairingOffer) {
  const hosts = await loadHosts();
  hosts[offer.hostDeviceId.toLowerCase()] = {
    relayUrl: offer.relayUrl,
    hostKey: offer.hostKey,
    hostName: offer.hostName,
  };
  await SecureStore.setItemAsync(HOSTS_STORAGE, JSON.stringify(hosts));
}

async function phoneCredential() {
  const device = await loadPhoneDevice();
  if (!device) {
    throw new RelayTunnelClientError(
      "unauthorized",
      "Sign in to your Gustaf account on this phone and register it under Settings → Account.",
    );
  }
  return device.token;
}

export async function relayClientOptions(hostDeviceId: string) {
  const [deviceToken, clientKeyPair, hosts, native] = await Promise.all([
    phoneCredential(),
    phoneKeyPair(),
    loadHosts(),
    phoneNative(),
  ]);
  const host = hosts[hostDeviceId];
  if (!host)
    throw new RelayTunnelClientError(
      "unauthorized",
      "This computer was not paired over the relay.",
    );
  return {
    relayUrl: host.relayUrl,
    deviceToken,
    hostDeviceId,
    hostKey: host.hostKey,
    clientKeyPair,
    ...native,
  };
}

export const isRelayPairingLink = (value: string) => parseRelayPairingLink(value) !== null;

/**
 * Scanned relay QR code → the computer's approval → an ordinary pairing link at the computer's
 * virtual relay origin, which the normal pairing flow redeems through the tunnel.
 */
export async function pairOverRelay(
  link: string,
  /** Called with the code the computer shows beside "Allow …?". */
  onPending: (safetyCode: string) => void,
): Promise<string> {
  const offer = parseRelayPairingLink(link);
  if (!offer) throw new Error("This QR code is not a Gustaf relay code.");
  const [deviceToken, clientKeyPair, native] = await Promise.all([
    phoneCredential(),
    phoneKeyPair(),
    phoneNative(),
  ]);
  const client = await RelayTunnelClient.connect({
    relayUrl: offer.relayUrl,
    deviceToken,
    hostDeviceId: offer.hostDeviceId,
    hostKey: offer.hostKey,
    clientKeyPair,
    ...native,
    pairingSecret: offer.secret,
    onPending: () =>
      onPending(relaySafetyCode(clientKeyPair.publicKey, fromBase64Url(offer.hostKey))),
  });
  const token = client.pairingToken;
  client.close();
  if (!token)
    throw new Error("The computer did not send a pairing code. Show a new QR code and scan again.");
  await saveHost(offer);
  relayTunnels.forget(offer.hostDeviceId.toLowerCase());
  return `${relayVirtualBaseUrl(offer.hostDeviceId)}/pair#token=${encodeURIComponent(token)}`;
}

/** The code this phone and a relay-paired computer both show; null when it was not paired here. */
export async function relaySafetyCodeFor(hostDeviceId: string): Promise<string | null> {
  const [hosts, keyPair] = await Promise.all([loadHosts(), phoneKeyPair()]);
  const host = hosts[hostDeviceId];
  return host ? relaySafetyCode(keyPair.publicKey, fromBase64Url(host.hostKey)) : null;
}
