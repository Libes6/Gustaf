// @effect-diagnostics nodeBuiltinImport:off -- Test randomness for keys and ephemerals.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";

import vectors from "./fixtures/noise-xx-vectors.json" with { type: "json" };
import {
  NoiseError,
  NoiseHandshake,
  generateNoiseKeyPair,
  noiseKeyPairFromSecret,
  relaySafetyCode,
  type NoiseSession,
} from "./relayNoise.ts";

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const random = (length: number) => new Uint8Array(NodeCrypto.randomBytes(length));

function pair(prologue = new Uint8Array(0)) {
  const initiatorKeys = generateNoiseKeyPair(random);
  const responderKeys = generateNoiseKeyPair(random);
  const initiator = new NoiseHandshake({
    initiator: true,
    staticKeyPair: initiatorKeys,
    prologue,
    randomBytes: random,
  });
  const responder = new NoiseHandshake({
    initiator: false,
    staticKeyPair: responderKeys,
    prologue,
    randomBytes: random,
  });
  return { initiator, responder, initiatorKeys, responderKeys };
}

function complete({ initiator, responder }: ReturnType<typeof pair>) {
  responder.readMessage(initiator.writeMessage());
  initiator.readMessage(responder.writeMessage());
  responder.readMessage(initiator.writeMessage());
  return [initiator.session(), responder.session()] as const;
}

describe("Noise XX", () => {
  it.each(vectors)("matches the $source test vector", (vector) => {
    const initiator = new NoiseHandshake({
      initiator: true,
      staticKeyPair: noiseKeyPairFromSecret(hex(vector.init_static)),
      ephemeralKeyPair: noiseKeyPairFromSecret(hex(vector.init_ephemeral)),
      prologue: hex(vector.init_prologue),
      randomBytes: random,
    });
    const responder = new NoiseHandshake({
      initiator: false,
      staticKeyPair: noiseKeyPairFromSecret(hex(vector.resp_static)),
      ephemeralKeyPair: noiseKeyPairFromSecret(hex(vector.resp_ephemeral)),
      prologue: hex(vector.resp_prologue),
      randomBytes: random,
    });
    const sessions: Array<NoiseSession> = [];
    vector.messages.forEach((message, index) => {
      const initiatorSends = index % 2 === 0;
      if (index < 3) {
        const [writer, reader] = initiatorSends ? [initiator, responder] : [responder, initiator];
        const ciphertext = writer.writeMessage(hex(message.payload));
        expect(toHex(ciphertext)).toBe(message.ciphertext);
        expect(toHex(reader.readMessage(ciphertext))).toBe(message.payload);
        if (index === 2) sessions.push(initiator.session(), responder.session());
        return;
      }
      const [initiatorSession, responderSession] = sessions as [NoiseSession, NoiseSession];
      const [writer, reader] = initiatorSends
        ? [initiatorSession, responderSession]
        : [responderSession, initiatorSession];
      const ciphertext = writer.send.encrypt(hex(message.payload));
      expect(toHex(ciphertext)).toBe(message.ciphertext);
      expect(toHex(reader.receive.decrypt(ciphertext))).toBe(message.payload);
    });
    if ("handshake_hash" in vector && vector.handshake_hash) {
      expect(toHex(sessions[0]!.handshakeHash)).toBe(vector.handshake_hash);
    }
  });

  it("authenticates both static keys and refuses tampering, replay and reordering", () => {
    const handshakes = pair();
    const [initiator, responder] = complete(handshakes);
    expect(toHex(responder.remoteStaticKey)).toBe(toHex(handshakes.initiatorKeys.publicKey));
    expect(toHex(initiator.remoteStaticKey)).toBe(toHex(handshakes.responderKeys.publicKey));
    expect(toHex(initiator.handshakeHash)).toBe(toHex(responder.handshakeHash));

    const first = initiator.send.encrypt(new TextEncoder().encode("one"));
    const second = initiator.send.encrypt(new TextEncoder().encode("two"));
    // Out of order: the receiver still expects nonce 0.
    expect(() => responder.receive.decrypt(second)).toThrow(NoiseError);
    expect(new TextDecoder().decode(responder.receive.decrypt(first))).toBe("one");
    // A replayed message no longer authenticates.
    expect(() => responder.receive.decrypt(first)).toThrow(NoiseError);
    expect(new TextDecoder().decode(responder.receive.decrypt(second))).toBe("two");

    const tampered = initiator.send.encrypt(new TextEncoder().encode("three"));
    tampered[0]! ^= 1;
    expect(() => responder.receive.decrypt(tampered)).toThrow(NoiseError);
  });

  it("fails when the two sides were given different prologues", () => {
    const initiator = new NoiseHandshake({
      initiator: true,
      staticKeyPair: generateNoiseKeyPair(random),
      prologue: new TextEncoder().encode("host-a"),
      randomBytes: random,
    });
    const responder = new NoiseHandshake({
      initiator: false,
      staticKeyPair: generateNoiseKeyPair(random),
      prologue: new TextEncoder().encode("host-b"),
      randomBytes: random,
    });
    responder.readMessage(initiator.writeMessage());
    expect(() => initiator.readMessage(responder.writeMessage())).toThrow(NoiseError);
    expect(() => initiator.writeMessage()).toThrow(NoiseError);
  });

  it("gives both people the same safety code", () => {
    const a = generateNoiseKeyPair(random).publicKey;
    const b = generateNoiseKeyPair(random).publicKey;
    expect(relaySafetyCode(a, b)).toBe(relaySafetyCode(b, a));
    expect(relaySafetyCode(a, b)).toMatch(/^\d{3} \d{3} \d{3} \d{3}$/);
  });
});
