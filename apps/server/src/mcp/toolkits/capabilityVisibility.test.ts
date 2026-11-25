import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { McpSchema, type Tool, type Toolkit } from "effect/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import { DeviceToolkit } from "./device/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";

const scopeWith = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  thread = true,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: thread
    ? {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
      }
    : undefined,
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

// What /mcp does for each tool in tools/list: the predicate reads the request's scope.
const listed = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  scope: McpInvocationContext.McpInvocationScope,
) =>
  Effect.sync(() =>
    Object.values(toolkit.tools)
      .filter((tool) => {
        const enabledWhen = Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen);
        return enabledWhen === undefined || enabledWhen({ protocolVersion: "", capabilities: {} });
      })
      .map((tool) => tool.name),
  ).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));

const names = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  Object.keys(toolkit.tools);

it.effect("lists the browser tools only to a thread with the preview capability", () =>
  Effect.gen(function* () {
    for (const toolkit of [PreviewToolkit, PreviewControlsToolkit]) {
      expect(yield* listed(toolkit, scopeWith([]))).toEqual([]);
      expect(yield* listed(toolkit, scopeWith(["device", "orchestration"]))).toEqual([]);
      expect(yield* listed(toolkit, scopeWith(["preview"]))).toEqual(names(toolkit));
      // A client from outside a thread has no browser of its own, even with the capability.
      expect(yield* listed(toolkit, scopeWith(["preview"], false))).toEqual([]);
    }
  }),
);

it.effect("lists the device tools only to a thread with the device capability", () =>
  Effect.gen(function* () {
    expect(yield* listed(DeviceToolkit, scopeWith(["preview", "orchestration"]))).toEqual([]);
    expect(yield* listed(DeviceToolkit, scopeWith(["device"]))).toEqual(names(DeviceToolkit));
    expect(yield* listed(DeviceToolkit, scopeWith(["device"], false))).toEqual([]);
  }),
);

// html_render shows a page in the thread and html_preview checks it; both run on the server's
// own headless browser, so neither needs the agent browser or a device.
it.effect("keeps the HTML tools for every thread", () =>
  Effect.gen(function* () {
    expect(yield* listed(HtmlToolkit, scopeWith([]))).toEqual(names(HtmlToolkit));
    expect(yield* listed(HtmlToolkit, scopeWith([], false))).toEqual([]);
  }),
);

// The list and the call must agree: a tool is listed exactly where its handler would not refuse.
it.effect("refuses a call exactly where the tool is not listed", () =>
  Effect.gen(function* () {
    for (const capabilities of [[], ["preview"], ["device"], ["preview", "device"]] as const) {
      const scope = scopeWith(capabilities);
      const provide = Effect.provideService(McpInvocationContext.McpInvocationContext, scope);
      const browserCall = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
        provide,
        Effect.flip,
        Effect.option,
      );
      const deviceCall = yield* McpInvocationContext.requireThreadMcpCapability("device").pipe(
        provide,
        Effect.flip,
        Effect.option,
      );
      const browserListed = (yield* listed(PreviewToolkit, scope)).length > 0;
      const deviceListed = (yield* listed(DeviceToolkit, scope)).length > 0;
      expect(browserListed).toBe(capabilities.includes("preview" as never));
      expect(deviceListed).toBe(capabilities.includes("device" as never));
      expect(browserCall._tag === "Some").toBe(!browserListed);
      expect(deviceCall._tag === "Some").toBe(!deviceListed);
      if (browserCall._tag === "Some")
        expect(browserCall.value).toBeInstanceOf(PreviewAutomationUnavailableError);
      if (deviceCall._tag === "Some")
        expect(deviceCall.value).toBeInstanceOf(McpCapabilityUnavailableError);
    }
  }),
);
