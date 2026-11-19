import * as Cause from "effect/Cause";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  childThreadInputs: [] as EnvironmentThreadShell[],
  switchRef: (async () => undefined) as (input: unknown) => Promise<unknown>,
}));

vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => (input: unknown) => state.switchRef(input)) as never,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => (input: unknown) => state.switchRef(input)) as never,
}));

vi.mock(import("../../hooks/useThreadActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadActions: (() => ({})) as never,
  useAcknowledgeThreadWoke: (() => () => undefined) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useChildThreadInputs: (() => state.childThreadInputs) as never,
}));

import { render } from "../../../test/render";
import { useThreadLifecycle } from "./useThreadLifecycle";

const environmentId = EnvironmentId.make("environment:test");

function setup() {
  state.childThreadInputs = [];
  state.switchRef = async () => undefined;
}

function threadInput(threadId: string, branch: string) {
  const ref = scopeThreadRef(environmentId, ThreadId.make(threadId));
  const thread = { id: ref.threadId, environmentId, branch, worktreePath: null };
  return {
    routeThreadKey: scopedThreadKey(ref),
    activeThread: thread as never,
    activeThreadId: ref.threadId,
    activeThreadRef: ref,
    threadDetailRef: ref,
    activeThreadKey: scopedThreadKey(ref),
    localCheckoutBranchMismatch: { threadBranch: branch, currentBranch: "main" },
  };
}

type ThreadInput = ReturnType<typeof threadInput>;

it.each([
  { remote: false, approval: false, link: "Open question" },
  { remote: true, approval: false, link: "Open question" },
  { remote: true, approval: false, link: "Child" },
  { remote: true, approval: true, link: "Open approval" },
])("opens the child in its environment ($remote, $link)", async ({ remote, approval, link }) => {
  setup();
  const parent = threadInput("parent", "main");
  const childEnvironmentId = remote ? EnvironmentId.make("remote") : environmentId;
  state.childThreadInputs = [
    {
      id: ThreadId.make("child"),
      environmentId: childEnvironmentId,
      title: "Child",
      hasPendingApprovals: approval,
      lineage: { sideChat: false },
    } as EnvironmentThreadShell,
  ];
  await using screen = await render(
    <LifecycleHarness
      thread={parent}
      currentRouteThreadKeyRef={{ current: parent.routeThreadKey }}
      focusComposer={() => undefined}
    />,
    { router: "/environment:test/parent" },
  );
  await screen.getByRole("button", { name: link, exact: true }).click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(
      `/${encodeURIComponent(childEnvironmentId)}/child`,
    ),
  );
});

function LifecycleHarness(props: {
  readonly thread: ThreadInput;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly focusComposer: () => void;
}) {
  const lifecycle = useThreadLifecycle({
    ...props.thread,
    environmentId,
    currentRouteThreadKeyRef: props.currentRouteThreadKeyRef,
    canOperateThread: true,
    clientSettingsHydrated: true,
    activeThreadShell: null,
    limitRecoveryHoldsSnooze: false,
    activeLatestRun: null as never,
    serverConfig: null,
    runtimeMode: "full-access" as never,
    isWorking: false,
    pendingBackgroundTasks: [{ taskId: "background-command", kind: "command" }] as never,
    turnItems: [],
    activePendingApproval: null as never,
    activePendingUserInput: null as never,
    nowMinute: "",
    composerRef: { current: { focusAtEnd: props.focusComposer } } as never,
    sendInFlightRef: { current: false },
    setOptimisticUserMessages: () => undefined,
    setThreadError: () => undefined,
    clearUsageLimitsFor: () => undefined,
    beginLocalDispatch: () => undefined,
    resetLocalDispatch: () => undefined,
    scrollToEnd: () => undefined,
    persistThreadSettingsForNextTurn: async () => ({ _tag: "Success", value: undefined }) as never,
  });
  return (
    <>
      {lifecycle.childInputNow?.description}
      {lifecycle.childInputNow?.actions}
      {lifecycle.workNow?.actions}
    </>
  );
}

it.each(["Success", "Failure"] as const)(
  "keeps background stop requests per thread after %s",
  async (outcome) => {
    setup();
    const completions: Array<(result: unknown) => void> = [];
    state.switchRef = vi.fn(() => new Promise((resolve) => completions.push(resolve)));
    const threadA = threadInput("thread:a", "feature-a");
    const threadB = threadInput("thread:b", "feature-b");
    const currentRouteThreadKeyRef = { current: threadA.routeThreadKey };
    const harness = (thread: ThreadInput) => (
      <LifecycleHarness
        thread={thread}
        currentRouteThreadKeyRef={currentRouteThreadKeyRef}
        focusComposer={() => undefined}
      />
    );
    await using screen = await render(harness(threadA));
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    await screen.rerender(harness(threadB));
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await screen.rerender(harness(threadA));
    await expect.element(page.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    completions[0]!(
      outcome === "Success"
        ? { _tag: "Success", value: undefined }
        : { _tag: "Failure", cause: Cause.fail(new Error("stop failed")) },
    );
    if (outcome === "Success") {
      await expect.element(page.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    } else {
      await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    }
    await screen.rerender(harness(threadB));
    await expect.element(page.getByRole("button", { name: "Stopping..." })).toBeDisabled();
    expect(state.switchRef).toHaveBeenCalledTimes(2);
    completions[1]!({ _tag: "Success", value: undefined });
  },
);
