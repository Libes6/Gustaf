import { type ComputerUseAction, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  ComputerScreenshotToolkit,
  ComputerStandardToolkit,
  type ComputerUseToolkit,
} from "./tools.ts";

const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.thread === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only an agent in a Gustaf thread can control the Mac.",
          }),
        )
      : Effect.succeed({
          threadId: scope.thread.threadId,
          providerInstanceId: scope.thread.providerInstanceId,
        }),
  ),
);

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Positive line deltas scroll up and left, as a CGEvent scroll wheel does. */
const SCROLL = {
  up: [0, 1],
  down: [0, -1],
  left: [1, 0],
  right: [-1, 0],
} as const;

const act = Effect.fn("ComputerUseToolkit.act")(function* (action: ComputerUseAction) {
  const service = yield* ComputerUseService.ComputerUseService;
  yield* service.act(yield* caller, action);
  return { done: true };
});

const handlers = {
  computer_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ComputerUseService.ComputerUseService;
      const shot = yield* service.screenshot(yield* caller, { displayId: input?.displayId });
      return {
        captureId: shot.geometry.captureId,
        displayId: shot.geometry.displayId,
        displays: shot.displays.map(({ id, name, main }) => ({ id, name, main })),
        screen: shot.context.screen,
        ...(shot.context.app === undefined ? {} : { app: shot.context.app.name }),
        ...(shot.context.windowTitle === undefined
          ? {}
          : { windowTitle: shot.context.windowTitle }),
        screenshot: {
          mimeType: "image/png" as const,
          data: shot.png,
          width: shot.geometry.width,
          height: shot.geometry.height,
        },
      };
    }),
  ),
  computer_mouse: McpToolAccess.actsAsCaller((input) =>
    Effect.suspend(() => {
      const at = { captureId: input.captureId, x: input.x, y: input.y };
      switch (input.action) {
        case "click":
          return act({ type: "click", at });
        case "double_click":
          return act({ type: "click", at, count: 2 });
        case "right_click":
          return act({ type: "click", at, button: "right" });
        case "move":
          return act({ type: "move", at });
        case "drag":
          return input.toX === undefined || input.toY === undefined
            ? Effect.fail(invalid("A drag needs toX and toY."))
            : act({
                type: "drag",
                from: at,
                to: { captureId: input.captureId, x: input.toX, y: input.toY },
              });
      }
    }),
  ),
  computer_scroll: McpToolAccess.actsAsCaller((input) => {
    const lines = input.lines ?? 5;
    const [x, y] = SCROLL[input.direction];
    return act({
      type: "scroll",
      at: { captureId: input.captureId, x: input.x, y: input.y },
      deltaX: x * lines,
      deltaY: y * lines,
    });
  }),
  computer_keyboard: McpToolAccess.actsAsCaller((input) =>
    input.text !== undefined && input.keys === undefined
      ? act({ type: "type", text: input.text })
      : input.keys !== undefined && input.text === undefined
        ? act({ type: "key", keys: input.keys, ...(input.repeat ? { repeat: input.repeat } : {}) })
        : Effect.fail(invalid("Pass exactly one of text or keys.")),
  ),
  computer_open_app: McpToolAccess.actsAsCaller((input) =>
    act({ type: "activate", app: input.app }),
  ),
  computer_wait: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* ComputerUseService.ComputerUseService;
      yield* service.wait(yield* caller, input.seconds);
      return { done: true };
    }),
  ),
  computer_stop: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const service = yield* ComputerUseService.ComputerUseService;
      yield* service.release(yield* caller);
      return { done: true };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerUseToolkit.tools>;

const { computer_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(ComputerStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot,
});
