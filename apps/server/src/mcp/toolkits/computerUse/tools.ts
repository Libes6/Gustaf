import { ComputerUseError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import { takeComputerUseEndpoint } from "../../../computerUse/executorEndpoint.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ComputerUseService.ComputerUseService,
];

const ComputerToolFailure = Schema.Union([ComputerUseError, OrchestratorMcpFailure]);

/** Only where the shell gave this server its executor, and never to a delegated child. */
const computerToolsVisible = (): boolean =>
  McpInvocationContext.hiddenFromSubagents() && takeComputerUseEndpoint() !== undefined;

const Pixel = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const CaptureId = Schema.String.annotate({ description: "From computer_screenshot." });

const computerTool = <T extends Tool.Any>(tool: T, title: string, readonly: boolean): T =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, readonly)
    .annotate(Tool.Destructive, !readonly)
    .annotate(Tool.Idempotent, readonly)
    .annotate(Tool.OpenWorld, true)
    .annotate(McpSchema.EnabledWhen, computerToolsVisible) as T;

export const ComputerScreenshotTool = computerTool(
  Tool.make("computer_screenshot", {
    description:
      "See the user's Mac screen. Works only in a thread where the user turned on Control Mac; if refused, ask them to and stop. Other computer_* tools take pixels of this image with its `captureId`; take a new one after the screen changes. `displays` lists monitors for `displayId`.",
    parameters: Schema.Struct({
      displayId: Schema.optional(
        Schema.Int.annotate({ description: "A monitor from `displays`. Default: main." }),
      ),
    }),
    success: Schema.Struct({
      captureId: Schema.String,
      displayId: Schema.Int,
      displays: Schema.Array(
        Schema.Struct({ id: Schema.Int, name: Schema.String, main: Schema.Boolean }),
      ),
      screen: Schema.String,
      app: Schema.optional(Schema.String),
      windowTitle: Schema.optional(Schema.String),
      screenshot: Schema.Struct({
        mimeType: Schema.Literal("image/png"),
        data: Schema.String,
        width: Schema.Int,
        height: Schema.Int,
      }),
    }),
    failure: ComputerToolFailure,
    dependencies,
  }),
  "Screenshot Mac",
  true,
);

const Done = Schema.Struct({ done: Schema.Boolean });

const ComputerMouseTool = computerTool(
  Tool.make("computer_mouse", {
    description:
      "Click, double-click, right-click, move to, or drag on the Mac at (x, y) of screenshot `captureId`. Drag ends at (toX, toY). Check the result with computer_screenshot.",
    parameters: Schema.Struct({
      action: Schema.Literals(["click", "double_click", "right_click", "move", "drag"]),
      captureId: CaptureId,
      x: Pixel,
      y: Pixel,
      toX: Schema.optional(Pixel),
      toY: Schema.optional(Pixel),
    }),
    success: Done,
    failure: ComputerToolFailure,
    dependencies,
  }),
  "Use Mac mouse",
  false,
);

const ComputerScrollTool = computerTool(
  Tool.make("computer_scroll", {
    description: "Scroll on the Mac at (x, y) of screenshot `captureId`.",
    parameters: Schema.Struct({
      captureId: CaptureId,
      x: Pixel,
      y: Pixel,
      direction: Schema.Literals(["up", "down", "left", "right"]),
      lines: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
          description: "Default 5.",
        }),
      ),
    }),
    success: Done,
    failure: ComputerToolFailure,
    dependencies,
  }),
  "Scroll Mac",
  false,
);

const ComputerKeyboardTool = computerTool(
  Tool.make("computer_keyboard", {
    description:
      'Type `text` into the focused field on the Mac (any language), or press `keys` together, such as ["command", "s"] or ["return"]. Pass exactly one.',
    parameters: Schema.Struct({
      text: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000))),
      keys: Schema.optional(
        Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
      ),
      repeat: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
          description: "Presses of `keys`. Default 1.",
        }),
      ),
    }),
    success: Done,
    failure: ComputerToolFailure,
    dependencies,
  }),
  "Type on Mac",
  false,
);

const ComputerOpenAppTool = computerTool(
  Tool.make("computer_open_app", {
    description: "Open or bring to front a Mac app by name or bundle id, such as TextEdit.",
    parameters: Schema.Struct({ app: Schema.String.check(Schema.isMinLength(1)) }),
    success: Done,
    failure: ComputerToolFailure,
    dependencies,
  }),
  "Open Mac app",
  false,
);

const ComputerWaitTool = computerTool(
  Tool.make("computer_wait", {
    description: `Wait up to ${ComputerUseService.MAX_WAIT_SECONDS} seconds for the Mac's screen to settle, such as while an app opens.`,
    parameters: Schema.Struct({
      seconds: Schema.Number.check(
        Schema.isBetween({ minimum: 0, maximum: ComputerUseService.MAX_WAIT_SECONDS }),
      ),
    }),
    success: Done,
    failure: ComputerToolFailure,
    dependencies,
  }),
  "Wait",
  true,
);

const ComputerStopTool = computerTool(
  Tool.make("computer_stop", {
    description:
      "Give control of the Mac back to the user when you are done. The user must turn Control Mac on again before you can use it.",
    // An empty struct serializes as `anyOf [object, array]`, which some providers reject.
    parameters: Schema.Struct({
      unfinished: Schema.optional(
        Schema.Boolean.annotate({ description: "True if you stop before the task is done." }),
      ),
    }),
    success: Done,
    failure: ComputerToolFailure,
    dependencies,
  }),
  "Stop controlling Mac",
  false,
);

export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerMouseTool,
  ComputerScrollTool,
  ComputerKeyboardTool,
  ComputerOpenAppTool,
  ComputerWaitTool,
  ComputerStopTool,
);

export const ComputerUseToolkit = Toolkit.make(
  ComputerScreenshotTool,
  ComputerMouseTool,
  ComputerScrollTool,
  ComputerKeyboardTool,
  ComputerOpenAppTool,
  ComputerWaitTool,
  ComputerStopTool,
);
