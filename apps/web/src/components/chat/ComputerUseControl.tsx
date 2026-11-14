import { useAtomValue } from "@effect/atom-react";
import { computerUseErrorCode } from "@t3tools/client-runtime/state/computerUse";
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
import { useState } from "react";

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

const PERMISSIONS: ReadonlyArray<{
  readonly permission: ComputerUsePermission;
  readonly field: "screenRecording" | "accessibility";
  readonly label: MessageKey;
}> = [
  {
    permission: "screen-recording",
    field: "screenRecording",
    label: "computerUse.screenRecording",
  },
  { permission: "accessibility", field: "accessibility", label: "computerUse.accessibility" },
];

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

  const run = async (
    label: MessageKey | null,
    task: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setPending(label);
    setError(null);
    const result = await task();
    setPending(null);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const code = computerUseErrorCode(squashAtomCommandFailure(result));
    setError(t((code && ERROR_KEYS[code]) || "computerUse.error.failed"));
  };

  const owner = status.owner;
  const text = (key: MessageKey) => <p className="text-muted-foreground text-sm">{t(key)}</p>;
  const lastEnd =
    owner === undefined && status.lastEndReason !== undefined ? (
      <p className="text-muted-foreground text-xs">
        {t("computerUse.lastEnd").replace(
          "{reason}",
          t(`computerUse.end.${status.lastEndReason}` as MessageKey),
        )}
      </p>
    ) : null;

  const body = (() => {
    switch (status.availability) {
      case "unsupported":
        return text("computerUse.unsupported");
      case "disabled":
        return (
          <>
            {text("computerUse.disabled")}
            <Button
              size="sm"
              disabled={!canOperate || pending !== null}
              onClick={() =>
                void run("computerUse.confirmOnMac", () =>
                  setEnabled({ environmentId, input: { enabled: true } }),
                )
              }
            >
              {t("computerUse.enable")}
            </Button>
          </>
        );
      case "permissions-required":
        return (
          <>
            {text("computerUse.permissionsNeeded")}
            {PERMISSIONS.filter(({ field }) => status.permissions?.[field] !== true).map(
              ({ permission, label }) => (
                <div key={permission} className="flex items-center justify-between gap-2">
                  <span className="text-sm">{t(label)}</span>
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
              ),
            )}
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
      case "ready":
        return (
          <>
            {text("computerUse.ready")}
            <Button
              size="sm"
              disabled={!canOperate || pending !== null}
              onClick={() =>
                void run(null, () => allowThread({ environmentId, input: { threadId } }))
              }
            >
              {t("computerUse.allow")}
            </Button>
          </>
        );
      case "active":
        return (
          <>
            <p className="text-sm">
              {owner?.environmentId === environmentId && owner.threadId === threadId
                ? t("computerUse.ownedHere")
                : t("computerUse.ownedElsewhere").replace("{owner}", owner?.label ?? "")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("computerUse.emergency").replace("{shortcut}", status.emergencyShortcut)}
            </p>
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
