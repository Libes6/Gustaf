import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ComputerUseAction,
  ComputerUseError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ComputerUseService from "../computerUse/ComputerUseService.ts";
import { takeComputerUseEndpoint } from "../computerUse/executorEndpoint.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-computer-test");
const invocation = {
  environmentId: EnvironmentId.make("environment-computer-test"),
  requestNamespace: "provider-session-computer-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-computer-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const actions: Array<ComputerUseAction> = [];
const geometry = {
  captureId: "c7",
  displayId: 2,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  scale: 1,
  width: 1280,
  height: 720,
};

const layerTest = McpHttpServer.layerComputerUseToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(
    Layer.mock(ComputerUseService.ComputerUseService)({
      screenshot: (caller) =>
        caller.threadId === threadId
          ? Effect.succeed({
              geometry,
              png: "iVBORw0KGgo=",
              displays: [
                { id: 1, name: "Built-in", main: true, bounds: geometry.bounds, scale: 2 },
                { id: 2, name: "Side", main: false, bounds: geometry.bounds, scale: 1 },
              ],
              context: { screen: "available" as const },
            })
          : Effect.fail(new ComputerUseError({ code: "not-allowed", message: "Not allowed." })),
      act: (_caller, action) =>
        action.type === "activate" && action.app === "Locked"
          ? Effect.fail(
              new ComputerUseError({
                code: "screen-locked",
                message: "The Mac's screen is locked. Ask the user to unlock it.",
              }),
            )
          : Effect.sync(() => void actions.push(action)),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-computer-test-" })),
  Layer.provide(NodeServices.layer),
);

const call = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("returns the screen as image content and turns tool calls into actions", () =>
  Effect.gen(function* () {
    actions.length = 0;
    // Hidden where the shell gave this server no executor, as on a VPS.
    expect((yield* Effect.flip(call("computer_screenshot", {})))._tag).toBe("InvalidParams");
    takeComputerUseEndpoint({
      GUSTAF_COMPUTER_USE_SOCKET: "/x.sock",
      GUSTAF_COMPUTER_USE_TOKEN: "t",
    });

    const shot = yield* call("computer_screenshot", {});
    expect(shot.isError).toBe(false);
    expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(shot.structuredContent).toMatchObject({
      captureId: "c7",
      displays: [
        { id: 1, main: true },
        { id: 2, main: false },
      ],
      screenshot: { mimeType: "image/png", width: 1280, height: 720 },
    });

    yield* call("computer_mouse", { action: "double_click", captureId: "c7", x: 5, y: 6 });
    yield* call("computer_mouse", { action: "right_click", captureId: "c7", x: 5, y: 6 });
    yield* call("computer_mouse", {
      action: "drag",
      captureId: "c7",
      x: 1,
      y: 2,
      toX: 3,
      toY: 4,
    });
    yield* call("computer_scroll", { captureId: "c7", x: 5, y: 6, direction: "down" });
    yield* call("computer_keyboard", { text: "Привет, world" });
    yield* call("computer_keyboard", { keys: ["command", "s"] });
    expect(actions).toEqual([
      { type: "click", at: { captureId: "c7", x: 5, y: 6 }, count: 2 },
      { type: "click", at: { captureId: "c7", x: 5, y: 6 }, button: "right" },
      {
        type: "drag",
        from: { captureId: "c7", x: 1, y: 2 },
        to: { captureId: "c7", x: 3, y: 4 },
      },
      { type: "scroll", at: { captureId: "c7", x: 5, y: 6 }, deltaX: 0, deltaY: -5 },
      { type: "type", text: "Привет, world" },
      { type: "key", keys: ["command", "s"] },
    ]);

    const both = yield* call("computer_keyboard", { text: "a", keys: ["return"] });
    expect(both.isError).toBe(true);
    const noTarget = yield* call("computer_mouse", { action: "drag", captureId: "c7", x: 1, y: 2 });
    expect(noTarget.isError).toBe(true);
    expect(actions).toHaveLength(6);

    // The service's reason reaches the agent, so it can tell the user what to do.
    const locked = yield* call("computer_open_app", { app: "Locked" });
    expect(locked.isError).toBe(true);
    expect(JSON.stringify(locked.content)).toContain("screen is locked");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
