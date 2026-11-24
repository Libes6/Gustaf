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
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-computer-test");
const codex = ProviderInstanceId.make("codex");
const cursor = ProviderInstanceId.make("cursor");
const invocation = (
  options: {
    readonly computerUse?: boolean;
    readonly subagent?: boolean;
    readonly outside?: boolean;
    readonly providerInstanceId?: ProviderInstanceId;
  } = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-computer-test"),
  requestNamespace: "provider-session-computer-test",
  thread:
    options.outside === true
      ? undefined
      : {
          threadId,
          providerSessionId: "provider-session-computer-test",
          providerInstanceId: options.providerInstanceId ?? codex,
          ...(options.subagent === true ? { subagent: true } : {}),
        },
  client:
    options.outside === true
      ? { sessionId: "outside", label: "CLI", access: "full-access" }
      : undefined,
  capabilities: new Set(),
  issuedAt: 1,
  computerUse: options.computerUse ?? true,
});
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

const geometry = {
  captureId: "c7",
  displayId: 2,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  scale: 1,
  width: 1280,
  height: 720,
};
const imagesUnseen = new ComputerUseError({
  code: "provider-unsupported",
  message: "Computer use is not supported for this provider (cursor).",
});

const makeLayer = (actions: Array<ComputerUseAction>) =>
  McpHttpServer.layerComputerUseToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(
      Layer.mock(ComputerUseService.ComputerUseService)({
        available: true,
        screenshot: (caller) =>
          caller.providerInstanceId === cursor
            ? Effect.fail(imagesUnseen)
            : Effect.succeed({
                geometry,
                png: "iVBORw0KGgo=",
                displays: [
                  { id: 1, name: "Built-in", main: true, bounds: geometry.bounds, scale: 2 },
                  { id: 2, name: "Side", main: false, bounds: geometry.bounds, scale: 1 },
                ],
                context: { screen: "available" as const },
              }),
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

const call = (
  name: string,
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = invocation(),
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("returns the screen as image content and turns tool calls into actions", () => {
  const actions: Array<ComputerUseAction> = [];
  return Effect.gen(function* () {
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
    const offImage = yield* Effect.flip(
      call("computer_mouse", { action: "click", captureId: "c7", x: -1, y: 2 }),
    );
    expect(offImage).toMatchObject({
      _tag: "InvalidParams",
      message: expect.stringContaining("greater than or equal to 0"),
    });
    expect(actions).toHaveLength(6);

    // The service's reason reaches the agent, so it can tell the user what to do.
    const locked = yield* call("computer_open_app", { app: "Locked" });
    expect(locked.isError).toBe(true);
    expect(JSON.stringify(locked.content)).toContain("screen is locked");
    const blind = yield* call(
      "computer_screenshot",
      {},
      invocation({ providerInstanceId: cursor }),
    );
    expect(blind.isError).toBe(true);
    expect(JSON.stringify(blind.content)).toContain("not supported for this provider");
  }).pipe(Effect.scoped, Effect.provide(makeLayer(actions)));
});

it.effect.each([
  { case: "an environment without the desktop's executor", scope: { computerUse: false } },
  { case: "a delegated child", scope: { subagent: true } },
  { case: "a client outside any thread", scope: { outside: true } },
])("hides the Mac from $case", ({ scope }) => {
  const actions: Array<ComputerUseAction> = [];
  return Effect.gen(function* () {
    for (const name of ["computer_screenshot", "computer_mouse", "computer_stop"]) {
      const refused = yield* Effect.flip(
        call(name, { action: "click", captureId: "c7", x: 1, y: 1 }, invocation(scope)),
      );
      expect(refused).toMatchObject({
        _tag: "InvalidParams",
        message: expect.stringContaining("not found"),
      });
    }
    expect(actions).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(makeLayer(actions)));
});
