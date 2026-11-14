import { useAtomValue } from "@effect/atom-react";
import { computerUseErrorCode, computerUseStep } from "@t3tools/client-runtime/state/computerUse";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ComputerUsePermission,
  ComputerUseStatus,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { MonitorIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { computerUseEnvironment, useComputerUseStatus } from "~/state/computerUse";
import { useAtomCommand } from "~/state/use-atom-command";
import type { MessageKey } from "~/i18n";
import { useT } from "~/useUiLanguage";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

const ERROR_KEYS: Record<string, MessageKey> = {
  busy: "computerUse.error.busy",
  declined: "computerUse.error.declined",
  "permission-required": "computerUse.error.permission-required",
  disabled: "computerUse.error.disabled",
  "emergency-stop-unavailable": "computerUse.error.emergency-stop-unavailable",
  unsupported: "computerUse.error.unsupported",
};

const PERMISSION_LABELS: Record<ComputerUsePermission, MessageKey> = {
  "screen-recording": "computerUse.screenRecording",
  accessibility: "computerUse.accessibility",
};

/** The thread header's view of computer use on the Mac this environment runs on. */
export function ComputerUseControl({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const t = useT();
  const status = useComputerUseStatus(environmentId);
  const canOperate = useAtomValue(computerUseEnvironment.allowThread.permissionAtom(environmentId));
  const stop = useAtomCommand(computerUseEnvironment.stop, { reportFailure: false });
  const [stopping, setStopping] = useState(false);
  if (status === null) return null;
  const owner = status.owner;
  const ownedHere = owner?.environmentId === environmentId && owner.threadId === threadId;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant={ownedHere ? "destructive-outline" : "ghost-muted"}
              aria-label={t("computerUse.button")}
            />
          }
        >
          <MonitorIcon aria-hidden />
          {ownedHere ? t("computerUse.activeHere") : null}
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="end" className="w-80">
          <PopoverTitle>{t("computerUse.title")}</PopoverTitle>
          <ComputerUsePanel
            environmentId={environmentId}
            threadId={threadId}
            status={status}
            canOperate={canOperate}
          />
        </PopoverPopup>
      </Popover>
      {owner !== undefined && canOperate ? (
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
          {t("computerUse.stop")}
        </Button>
      ) : null}
    </div>
  );
}

/** While the grant step shows: macOS sends no event when a permission is switched on. */
const PERMISSION_RECHECK_MS = 2_000;

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
  const t = useT();
  const options = { reportFailure: false };
  const setEnabled = useAtomCommand(computerUseEnvironment.setEnabled, options);
  const openSettings = useAtomCommand(computerUseEnvironment.openPermissionSettings, options);
  const refresh = useAtomCommand(computerUseEnvironment.refresh, options);
  const allowThread = useAtomCommand(computerUseEnvironment.allowThread, options);
  const [pending, setPending] = useState<MessageKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const step = computerUseStep(status, environmentId, threadId);
  const granting = step.kind === "grant";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the Mac while the grant step shows, because macOS reports no permission changes
  useEffect(() => {
    if (!granting) return;
    const timer = setInterval(
      () => void refresh({ environmentId, input: {} }),
      PERMISSION_RECHECK_MS,
    );
    return () => clearInterval(timer);
  }, [granting, environmentId, refresh]);

  const fail = (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return false;
    const code = computerUseErrorCode(squashAtomCommandFailure(result));
    setError(t((code && ERROR_KEYS[code]) || "computerUse.error.failed"));
    return true;
  };

  const run = async (
    label: MessageKey | null,
    task: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setPending(label);
    setError(null);
    fail(await task());
    setPending(null);
  };

  /** One click: turning the feature on first when it is off, then allowing this thread. */
  const allow = async (confirmOnMac: boolean) => {
    setError(null);
    if (confirmOnMac) {
      setPending("computerUse.confirmOnMac");
      const enabled = await setEnabled({ environmentId, input: { enabled: true } });
      // Missing permissions become the next step instead; the status subscription shows it.
      if (fail(enabled) || enabled._tag !== "Success" || enabled.value.availability !== "ready") {
        setPending(null);
        return;
      }
    }
    setPending("computerUse.starting");
    fail(await allowThread({ environmentId, input: { threadId } }));
    setPending(null);
  };

  const muted = (content: string) => <p className="text-muted-foreground text-sm">{content}</p>;
  const stopHint = (
    <p className="text-muted-foreground text-xs">
      {t("computerUse.howToStop").replace("{shortcut}", status.emergencyShortcut)}
    </p>
  );
  const lastEnd =
    status.owner === undefined && status.lastEndReason !== undefined ? (
      <p className="text-muted-foreground text-xs">
        {t("computerUse.lastEnd").replace(
          "{reason}",
          t(`computerUse.end.${status.lastEndReason}` as MessageKey),
        )}
      </p>
    ) : null;

  const body = (() => {
    switch (step.kind) {
      case "unsupported":
        return muted(t("computerUse.unsupported"));
      case "allow":
        return (
          <>
            {muted(t("computerUse.whatItDoes"))}
            {stopHint}
            {step.confirmOnMac ? muted(t("computerUse.firstTime")) : null}
            <Button
              size="sm"
              disabled={!canOperate || pending !== null}
              onClick={() => void allow(step.confirmOnMac)}
            >
              {t("computerUse.allow")}
            </Button>
          </>
        );
      case "grant":
        return (
          <>
            {muted(
              step.missing.length === 1
                ? t("computerUse.grantOne").replace(
                    "{permission}",
                    t(PERMISSION_LABELS[step.missing[0]!]),
                  )
                : t("computerUse.grantBoth"),
            )}
            {step.missing.map((permission) => (
              <div key={permission} className="flex items-center justify-between gap-2">
                <span className="text-sm">{t(PERMISSION_LABELS[permission])}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canOperate}
                  onClick={() =>
                    void run(null, () => openSettings({ environmentId, input: { permission } }))
                  }
                >
                  {t("computerUse.openSettings")}
                </Button>
              </div>
            ))}
            <p className="text-muted-foreground text-xs">{t("computerUse.grantAutoCheck")}</p>
            <p className="text-muted-foreground text-xs">{t("computerUse.grantOldEntry")}</p>
          </>
        );
      case "check-failed":
        return (
          <>
            {muted(t("computerUse.checkFailed"))}
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() => void run(null, () => refresh({ environmentId, input: {} }))}
            >
              {t("computerUse.checkAgain")}
            </Button>
          </>
        );
      case "active":
        return (
          <>
            <p className="text-sm">
              {step.here
                ? t("computerUse.ownedHere")
                : t("computerUse.ownedElsewhere").replace("{owner}", step.label)}
            </p>
            {stopHint}
          </>
        );
    }
  })();

  return (
    <div className="flex flex-col gap-2">
      {body}
      {lastEnd}
      {pending !== null ? <p className="text-muted-foreground text-xs">{t(pending)}</p> : null}
      {error !== null ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
      {status.availability !== "unsupported" && status.availability !== "disabled" ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!canOperate || pending !== null}
          onClick={() =>
            void run(null, () => setEnabled({ environmentId, input: { enabled: false } }))
          }
        >
          {t("computerUse.disable")}
        </Button>
      ) : null}
    </div>
  );
}
