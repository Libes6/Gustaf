import { generateNoiseKeyPair, noiseKeyPairFromSecret } from "@t3tools/shared/relayNoise";
import {
  type RelayPairingOffer,
  fromBase64Url,
  parseRelayPairingLink,
  toBase64Url,
} from "@t3tools/shared/relayTunnel";
import {
  RelayTunnelClient,
  RelayTunnelClientError,
  RelayTunnelPool,
  relayVirtualBaseUrl,
} from "@t3tools/shared/relayTunnelClient";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import { loadPhoneDevice } from "../account/accountStorage";
import { phoneDisplayName } from "../account/useAccount";

// The phone's Noise key never leaves the keychain; computers know it as this phone.
const PHONE_KEY_STORAGE = "gustaf.relay.phone-key";
const HOSTS_STORAGE = "gustaf.relay.hosts";

interface RelayHostRecord {
  readonly relayUrl: string;
  readonly hostKey: string;
  readonly hostName: string;
}

const randomBytes = (length: number) => ExpoCrypto.getRandomBytes(length);

async function phoneKeyPair() {
  const stored = await SecureStore.getItemAsync(PHONE_KEY_STORAGE);
  if (stored) return noiseKeyPairFromSecret(fromBase64Url(stored));
  const created = generateNoiseKeyPair(randomBytes);
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

/** Every request and socket to a `*.relay.gustaf.invalid` environment goes through here. */
export const relayTunnels = new RelayTunnelPool(async (hostDeviceId) => {
  const [deviceToken, clientKeyPair, hosts] = await Promise.all([
    phoneCredential(),
    phoneKeyPair(),
    loadHosts(),
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
    name: phoneDisplayName(),
    randomBytes,
  };
});

export const isRelayPairingLink = (value: string) => parseRelayPairingLink(value) !== null;

/**
 * Scanned relay QR code → the computer's approval → an ordinary pairing link at the computer's
 * virtual relay origin, which the normal pairing flow redeems through the tunnel.
 */
export async function pairOverRelay(link: string, onPending: () => void): Promise<string> {
  const offer = parseRelayPairingLink(link);
  if (!offer) throw new Error("This QR code is not a Gustaf relay code.");
  const [deviceToken, clientKeyPair] = await Promise.all([phoneCredential(), phoneKeyPair()]);
  const client = await RelayTunnelClient.connect({
    relayUrl: offer.relayUrl,
    deviceToken,
    hostDeviceId: offer.hostDeviceId,
    hostKey: offer.hostKey,
    clientKeyPair,
    name: phoneDisplayName(),
    pairingSecret: offer.secret,
    randomBytes,
    onPending,
  });
  const token = client.pairingToken;
  client.close();
  if (!token)
    throw new Error("The computer did not send a pairing code. Show a new QR code and scan again.");
  await saveHost(offer);
  relayTunnels.forget(offer.hostDeviceId.toLowerCase());
  return `${relayVirtualBaseUrl(offer.hostDeviceId)}/pair#token=${encodeURIComponent(token)}`;
}
