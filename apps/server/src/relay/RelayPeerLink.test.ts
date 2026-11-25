import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { OrchestratorMcpFailure, PeerLinkError } from "@t3tools/contracts";
import { generateNoiseKeyPair } from "@t3tools/shared/relayNoise";
import { relayVirtualBaseUrl } from "@t3tools/shared/relayTunnelClient";
import { Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, servePeer } from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as RelayHost from "./RelayHost.ts";
import { HOST_TOKEN, PHONE_TOKEN, random, startRelay } from "./RelayHost.testkit.ts";
import { type RelayAdmission, RelayHostEngine } from "./RelayHostEngine.ts";

const Probe = Schema.Struct({ reached: Schema.String });
const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Answers from the environment it runs in.",
    success: Probe,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
);
const probeHandlers = McpToolAccess.toLayer(ProbeToolkit, {
  probe: McpToolAccess.reads(() => Effect.succeed({ reached: "box" })),
});

const mac = descriptorOf("environment-mac", "Mac");
const box = descriptorOf("environment-box", "Box");
/** The fake relay calls the computer "laptop" and the account's other machine "pixel". */
const BOX_DEVICE = "laptop";

/** Box: a served environment whose own relay host answers the tunnel for it. */
const serveBox = Effect.gen(function* () {
  const peer = yield* servePeer(
    box,
    McpHttpServer.toolkitRegistration(ProbeToolkit, probeHandlers),
  );
  const hostContext = yield* RelayHost.layerWith({ localOrigin: peer.url }).pipe(
    Layer.provide(Layer.succeedContext(peer.context)),
    Layer.build,
  );
  return { peer, host: Context.get(hostContext, RelayHost.RelayHost) };
});

/** Mac: the environment that links, signed in to the relay as the account's other computer. */
const makeMac = (relayUrl: string | null) =>
  Effect.gen(function* () {
    const context = yield* layerLinkingEnvironment(mac).pipe(Layer.build);
    if (relayUrl !== null) {
      yield* RelayHost.writeCloudCredential(
        Context.get(context, ServerSecretStore.ServerSecretStore),
        {
          relayUrl,
          deviceId: "pixel",
          token: PHONE_TOKEN,
        },
      );
    }
    return {
      links: Context.get(context, PeerLinks.PeerLinks),
      peer: Context.get(context, PeerMcpClient.PeerMcpClient),
    };
  });

const callProbe = (a: Effect.Success<ReturnType<typeof makeMac>>) =>
  a.peer.call({
    environmentId: box.environmentId,
    tool: "probe",
    arguments: {},
    limits: { runtimeMode: "full-access", interactionMode: "default" },
    success: Probe,
  });

/** Starts linking and waits until Box shows the request, with the code Mac shows for it. */
const startLinking = (
  a: Effect.Success<ReturnType<typeof makeMac>>,
  b: Effect.Success<typeof serveBox>,
  access: "auto" | "approval-required" = "auto",
) =>
  Effect.gen(function* () {
    const code = Promise.withResolvers<string>();
    const fiber = yield* Effect.forkChild(
      a.links.linkRelay({ deviceId: BOX_DEVICE, access }, { onSafetyCode: code.resolve }),
    );
    const macCode = yield* Effect.promise(() => code.promise);
    const [pending] = (yield* b.host.status()).pending;
    return { fiber, macCode, pending: pending! };
  });

it.live(
  "links another machine of the account through the relay once its user allows it, and keeps it across relay restarts",
  () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const b = yield* serveBox;
      yield* b.host.setCredential({ relayUrl: relay.url, deviceId: BOX_DEVICE, token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      const a = yield* makeMac(relay.url);

      // Discovery needs no address and no code: the account lists the other computers.
      expect(yield* a.links.relayMachines).toEqual({
        machines: [{ deviceId: "laptop", name: "Box", online: true }],
      });

      const { fiber, macCode, pending } = yield* startLinking(a, b);
      // Both screens show the same code, which is what rules out a relay in the middle.
      expect(pending.safetyCode).toBe(macCode);
      expect(pending.peerLink).toEqual({ access: "auto" });
      expect(yield* a.links.relayAttempts).toEqual([
        { deviceId: "laptop", name: "Box", safetyCode: macCode },
      ]);
      // Until Box's user allows it, nothing has reached Box and nothing is linked.
      expect(yield* a.links.list).toEqual([]);
      expect(yield* Ref.get(b.peer.bearers)).toEqual([]);
      expect(yield* b.peer.linkedSessions).toEqual([]);

      yield* b.host.decide({ id: pending.id, approve: true });
      const link = yield* Fiber.join(fiber);
      expect(link).toMatchObject({
        environmentId: box.environmentId,
        label: "Box",
        access: "auto",
        urls: [relayVirtualBaseUrl(BOX_DEVICE)],
      });
      expect(yield* a.links.relayAttempts).toEqual([]);
      // The link shows in Box's Connections like any other, where it can be revoked.
      expect((yield* b.peer.linkedSessions).map((session) => session.client.label)).toEqual([
        "T3 Code · Mac",
      ]);
      expect((yield* a.links.relayMachines).machines[0]?.linkedEnvironmentId).toBe(
        box.environmentId,
      );
      expect((yield* a.links.list).map((entry) => entry.status)).toEqual(["reachable"]);
      expect(yield* callProbe(a)).toEqual({ reached: "box" });

      // The relay restarts: Box's host reconnects by itself, and Mac's next call opens a new
      // tunnel with the key it already holds, with no second approval.
      relay.dropEveryone();
      yield* Effect.promise(() => relay.nextHost());
      expect(yield* callProbe(a)).toEqual({ reached: "box" });
      expect((yield* b.host.status()).pending).toEqual([]);

      // Box stops being a relay host: the link reads as offline, in words, and recovers with it.
      yield* b.host.clearCredential();
      const offline = yield* callProbe(a).pipe(Effect.flip);
      expect(offline.message).toContain("Box is not connected to the Gustaf relay");
      yield* b.host.setCredential({ relayUrl: relay.url, deviceId: BOX_DEVICE, token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      expect(yield* callProbe(a)).toEqual({ reached: "box" });

      // Over a relay limit a new tunnel is refused, the call says so, and the link comes back.
      relay.dropEveryone();
      relay.refuseChannels("limit");
      yield* Effect.promise(() => relay.nextHost());
      const limited = yield* a.links.resolve(box.environmentId).pipe(Effect.flip);
      expect(limited.message).toContain("relay limit");
      relay.refuseChannels(null);
      expect(yield* callProbe(a)).toEqual({ reached: "box" });

      // Forgetting ends the session on Box through the tunnel and drops the key kept for it.
      expect(yield* a.links.unlink(box.environmentId)).toEqual({ removed: true, endedThere: true });
      expect(yield* b.peer.linkedSessions).toEqual([]);
      expect((yield* a.links.relayMachines).machines[0]?.linkedEnvironmentId).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("does not link when Box's user declines, and nothing reaches Box", () =>
  Effect.gen(function* () {
    const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
    const b = yield* serveBox;
    yield* b.host.setCredential({ relayUrl: relay.url, deviceId: BOX_DEVICE, token: HOST_TOKEN });
    yield* Effect.promise(() => relay.nextHost());
    const a = yield* makeMac(relay.url);

    const { fiber, pending } = yield* startLinking(a, b, "approval-required");
    yield* b.host.decide({ id: pending.id, approve: false });
    const refused = yield* Fiber.join(fiber).pipe(Effect.flip);
    expect(refused).toBeInstanceOf(PeerLinkError);
    expect(refused.reason).toBe("relay_denied");
    expect(refused.message).toContain("Box did not allow the link");
    expect(yield* a.links.list).toEqual([]);
    expect(yield* a.links.relayAttempts).toEqual([]);
    expect(yield* Ref.get(b.peer.bearers)).toEqual([]);
    expect((yield* b.host.status()).devices).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live(
  "says why a machine cannot be linked: signed out, offline, another account, older Gustaf",
  () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));

      const signedOut = yield* makeMac(null);
      expect(yield* signedOut.links.relayMachines).toEqual({ machines: [], problem: "signed_out" });
      const needsLogin = yield* signedOut.links
        .linkRelay({ deviceId: BOX_DEVICE, access: "auto" })
        .pipe(Effect.flip);
      expect(needsLogin.reason).toBe("relay_signed_out");

      const a = yield* makeMac(relay.url);
      // Box is on the account but holds no relay connection.
      expect(yield* a.links.relayMachines).toEqual({
        machines: [{ deviceId: "laptop", name: "Box", online: false }],
      });
      const offline = yield* a.links
        .linkRelay({ deviceId: BOX_DEVICE, access: "auto" })
        .pipe(Effect.flip);
      expect(offline.reason).toBe("unreachable");
      expect(offline.message).toContain("Box is not connected to the Gustaf relay");

      // A computer the account does not list is another account's, or gone.
      const stranger = yield* a.links
        .linkRelay({ deviceId: "someone-elses", access: "auto" })
        .pipe(Effect.flip);
      expect(stranger.message).toContain("not on this Gustaf account's computers");

      // A Gustaf from before relay links does not know this computer's key and turns it away.
      const hostKeyPair = generateNoiseKeyPair(random);
      const old = new RelayHostEngine({
        relayUrl: relay.url,
        deviceToken: HOST_TOKEN,
        hostKeyPair,
        randomBytes: random,
        localOrigin: "http://127.0.0.1:1",
        admit: async (): Promise<RelayAdmission> => ({ kind: "reject", reason: "unknown_device" }),
        onState: () => {},
        log: () => {},
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => old.stop()));
      old.start();
      yield* Effect.promise(() => relay.nextHost());
      const tooOld = yield* a.links
        .linkRelay({ deviceId: BOX_DEVICE, access: "auto" })
        .pipe(Effect.flip);
      expect(tooOld.reason).toBe("incompatible");
      expect(tooOld.message).toContain("before relay links");
    }).pipe(Effect.scoped),
);
