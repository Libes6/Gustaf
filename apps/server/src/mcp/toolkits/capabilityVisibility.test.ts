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
import { McpSchema, type Tool } from "effect/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { SubscriptionsToolkit } from "./subscriptions/tools.ts";
import { ThemeToolkit } from "./theme/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";

const scopeWith = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  thread = true,
  subagent = false,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: thread
    ? {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        ...(subagent ? { subagent: true } : {}),
      }
    : undefined,
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

// What /mcp does for each tool in tools/list: the predicate reads the request's scope.
const listed = (
  toolkit: { readonly tools: Record<string, Tool.Any> },
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

const names = (toolkit: { readonly tools: Record<string, Tool.Any> }) => Object.keys(toolkit.tools);

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

// Each group is why a child does not need it: it hands its result to the parent, which owns
// everything around the task. The ones left (delegation, thread read/send/wait, PR, issue and
// worktree status/handoff) are what a child may use to do and report its work.
const HIDDEN_FROM_CHILDREN = {
  // `t3_thread_launch` stays: a child whose task says to open a follow-up thread does (the
  // tt-child-authorized-thread eval case).
  "starting several threads at once": ["create_threads"],
  scheduling: [
    "schedule_task",
    "list_scheduled_tasks",
    "delete_scheduled_task",
    "run_scheduled_task_now",
  ],
  projects: [
    "t3_project_list",
    "t3_project_read",
    "t3_project_create",
    "t3_project_update",
    "t3_project_delete",
    "t3_project_clone",
  ],
  "environment settings and linked machines": [
    "t3_environment_read",
    "t3_environment_preferences_update",
    "t3_environment_errors_read",
    "t3_environment_links",
    "t3_environment_link",
    "t3_environment_unlink",
  ],
  "subscriptions and theme": [
    "t3_subscriptions_list",
    "t3_subscriptions_upsert",
    "t3_subscriptions_delete",
    "t3_theme_read",
    "t3_theme_set",
  ],
  "managing other threads": [
    "t3_thread_list",
    "t3_thread_search",
    "t3_thread_update",
    "t3_thread_configure",
    "t3_thread_transfer",
    "t3_thread_organize",
    "t3_thread_interrupt",
    "t3_queue",
    "t3_pending_request",
    "t3_workflow_stop",
  ],
  "attachments for other threads": [
    "t3_attachment_prepare_upload",
    "t3_attachment_discard",
    "t3_thread_send_attachments",
  ],
  "worktree inventory": ["t3_worktree_list", "t3_worktree_inventory"],
};

const everyCapability = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
  "issues",
  "background-wait",
] as const;

it.effect(
  "hides setup and admin tools from a delegated child and keeps them for everyone else",
  () =>
    Effect.gen(function* () {
      const hidden = new Set(Object.values(HIDDEN_FROM_CHILDREN).flat());
      const toolkits = [
        OrchestratorToolkit,
        ThreadToolkit,
        ProjectToolkit,
        EnvironmentToolkit,
        SubscriptionsToolkit,
        ThemeToolkit,
        AttachmentToolkit,
        WorktreeToolkit,
      ];
      const thread = scopeWith(everyCapability);
      const child = scopeWith(everyCapability, true, true);
      const outside = scopeWith(everyCapability, false);
      const seen = new Set<string>();
      for (const toolkit of toolkits) {
        for (const name of yield* listed(toolkit, thread)) seen.add(name);
        const forChild = yield* listed(toolkit, child);
        expect(forChild).toEqual(
          (yield* listed(toolkit, thread)).filter((name) => !hidden.has(name)),
        );
        for (const name of names(toolkit).filter((tool) => hidden.has(tool))) {
          expect(forChild).not.toContain(name);
        }
      }
      // Nothing on the list is misspelled, and a thread that is not a child keeps all of it.
      for (const name of hidden) expect(seen).toContain(name);
      // A client outside a thread (the CLI) is not a delegated child, so it keeps what is not thread-only.
      const outsideTools = (yield* Effect.forEach(toolkits, (toolkit) =>
        listed(toolkit, outside),
      )).flat();
      expect(outsideTools).toContain("schedule_task");
      expect(outsideTools).toContain("t3_project_list");
      expect(outsideTools).toContain("t3_environment_links");
      expect(outsideTools).not.toContain("create_threads");
    }),
);
