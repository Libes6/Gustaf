import { useAtomValue } from "@effect/atom-react";
import {
  computerUseEndReasonLabel,
  computerUseErrorMessage,
  computerUseHasStopShortcut,
  computerUseHolder,
  computerUseIsOn,
  computerUseProviderList,
  computerUsePermissionLabel,
  computerUseStep,
} from "@t3tools/client-runtime/state/computerUse";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ComputerUseStatus, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT, useLocale, useMessages, Var } from "gt-react";
import { MonitorIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironment } from "~/state/environments";
import {
  computerUseEnvironment,
  useComputerUsePermissionRecheck,
  useComputerUseStatus,
} from "~/state/computerUse";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

type Pending = "confirm-on-mac" | "starting";

/** The thread header's view of computer use on the Mac the thread's environment runs on. */
export function ComputerUseControl({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const status = useComputerUseStatus(environmentId);
  const canOperate = useAtomValue(computerUseEnvironment.allowThread.permissionAtom(environmentId));
  const stop = useAtomCommand(computerUseEnvironment.stop, { reportFailure: false });
  const [stopping, setStopping] = useState(false);
  if (status === null) return null;
  const ownedHere = computerUseHolder(status, environmentId, threadId) === "this-thread";

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant={ownedHere ? "destructive-outline" : "ghost-muted"}
              aria-label={gt("Control Mac")}
            />
          }
        >
          <MonitorIcon aria-hidden />
          {ownedHere ? <T>Controls the Mac</T> : null}
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="end" className="w-80">
          <PopoverTitle>
            <T>Control Mac</T>
          </PopoverTitle>
          <ComputerUsePanel
            environmentId={environmentId}
            threadId={threadId}
            status={status}
            canOperate={canOperate}
          />
        </PopoverPopup>
      </Popover>
      {status.owner !== undefined && canOperate ? (
        <Button
          size="xs"
          variant="destructive"
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            await stop({ environmentId, input: {} });
            setStopping(false);
          }}
        >
          <T>Stop</T>
        </Button>
      ) : null}
    </div>
  );
}

function ComputerUsePanel({
  environmentId,
  threadId,
  status,
  canOperate,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly status: ComputerUseStatus;
  readonly canOperate: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const language = useLocale();
  const environmentLabel = useEnvironment(environmentId)?.label ?? "";
  const options = { reportFailure: false };
  const setEnabled = useAtomCommand(computerUseEnvironment.setEnabled, options);
  const openSettings = useAtomCommand(computerUseEnvironment.openPermissionSettings, options);
  const refresh = useAtomCommand(computerUseEnvironment.refresh, options);
  const allowThread = useAtomCommand(computerUseEnvironment.allowThread, options);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = computerUseStep(status, environmentId, threadId);
  useComputerUsePermissionRecheck(environmentId, step.kind === "grant");

  /** Shows what a refusal means and says whether the call failed; interrupted calls say nothing. */
  const failed = (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return false;
    setError(computerUseErrorMessage(squashAtomCommandFailure(result), messages));
    return true;
  };

  const run = async (task: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    setError(null);
    failed(await task());
    setBusy(false);
  };

  /** One click: turning the feature on first when it is off, then allowing this thread. */
  const allow = async (confirmOnMac: boolean) => {
    setError(null);
    if (confirmOnMac) {
      setPending("confirm-on-mac");
      const enabled = await setEnabled({ environmentId, input: { enabled: true } });
      // Missing permissions become the next step instead; the status subscription shows it.
      if (failed(enabled) || enabled._tag !== "Success" || enabled.value.availability !== "ready") {
        setPending(null);
        return;
      }
    }
    setPending("starting");
    failed(await allowThread({ environmentId, input: { threadId } }));
    setPending(null);
  };

  const body = (() => {
    switch (step.kind) {
      case "unsupported":
        return (
          <p className="text-muted-foreground text-sm">
            <T>
              Not available here. An agent can control a Mac only through the Gustaf desktop app on
              that Mac, in the environment that app runs.
            </T>
          </p>
        );
      case "allow":
        return (
          <>
            <p className="text-muted-foreground text-sm">
              <T>
                This thread's agent will see the screen of the Mac that runs{" "}
                <Var>{environmentLabel}</Var> and use its mouse and keyboard until control stops.
                Works with <Var>{computerUseProviderList(language, messages)}</Var>.
              </T>
            </p>
            <StopHint status={status} />
            {step.confirmOnMac ? (
              <p className="text-muted-foreground text-sm">
                <T>
                  The first time, Gustaf asks the person at the Mac to confirm in a dialog there.
                </T>
              </p>
            ) : null}
            <Button
              size="sm"
              disabled={!canOperate || pending !== null}
              onClick={() => void allow(step.confirmOnMac)}
            >
              <T>Allow this thread</T>
            </Button>
          </>
        );
      case "grant":
        return (
          <>
            <p className="text-muted-foreground text-sm">
              {step.missing.length === 1
                ? gt("Gustaf on the Mac still needs the {permission} permission.", {
                    permission: computerUsePermissionLabel(step.missing[0]!, messages),
                  })
                : gt("Gustaf on the Mac still needs two permissions.")}
            </p>
            {step.missing.map((permission) => (
              <div key={permission} className="flex items-center justify-between gap-2">
                <span className="text-sm">{computerUsePermissionLabel(permission, messages)}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canOperate}
                  onClick={() =>
                    void run(() => openSettings({ environmentId, input: { permission } }))
                  }
                >
                  <T>Open settings</T>
                </Button>
              </div>
            ))}
            <p className="text-muted-foreground text-xs">
              <T>
                Switch Gustaf on in the list that opens on the Mac. This panel notices on its own;
                then click Allow this thread.
              </T>
            </p>
            <p className="text-muted-foreground text-xs">
              <T>
                If macOS asks for a permission again, or Gustaf already looks switched on, remove
                the Gustaf entries with −, then click Open settings again.
              </T>
            </p>
          </>
        );
      case "check-failed":
        return (
          <>
            <p className="text-muted-foreground text-sm">
              <T>
                Gustaf could not ask macOS about its permissions. Check again; if it keeps failing,
                reopen Gustaf on the Mac.
              </T>
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => refresh({ environmentId, input: {} }))}
            >
              <T>Check again</T>
            </Button>
          </>
        );
      case "active":
        return (
          <>
            <p className="text-sm">
              {step.here
                ? gt("This thread's agent controls the Mac.")
                : gt("The Mac is controlled by “{owner}”.", { owner: step.label })}
            </p>
            <StopHint status={status} />
          </>
        );
    }
  })();

  return (
    <div className="flex flex-col gap-2">
      {body}
      {status.owner === undefined && status.lastEndReason !== undefined ? (
        <p className="text-muted-foreground text-xs">
          {computerUseEndReasonLabel(status.lastEndReason, messages)}
        </p>
      ) : null}
      {pending !== null ? (
        <p className="text-muted-foreground text-xs">
          {pending === "confirm-on-mac"
            ? gt("Waiting for the person at the Mac to confirm…")
            : gt("Starting control…")}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
      {computerUseIsOn(status) ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canOperate || busy || pending !== null}
          onClick={() => void run(() => setEnabled({ environmentId, input: { enabled: false } }))}
        >
          <T>Turn off on the Mac</T>
        </Button>
      ) : null}
    </div>
  );
}

function StopHint({ status }: { readonly status: ComputerUseStatus }) {
  const gt = useGT();
  if (!computerUseHasStopShortcut(status)) return null;
  return (
    <p className="text-muted-foreground text-xs">
      {gt(
        "To stop: Stop in the thread header, Stop control in the Mac's menu bar, or {shortcut} on the Mac.",
        { shortcut: status.emergencyShortcut },
      )}
    </p>
  );
}
