import { CheckIcon, CircleDotIcon, CopyIcon, XIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { useSyncExternalStore } from "react";

import {
  formatSshAddLog,
  sshAddLogElapsedMs,
  type SshAddLogEntry,
  type SshAddLogStep,
} from "~/connection/sshAddLog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const STEP_LABELS: Record<SshAddLogStep, string> = {
  "resolve-host": msg("Resolving the SSH host"),
  connect: msg("Connecting over SSH"),
  password: msg("Waiting for the SSH password"),
  "runtime-check": msg("Checking Gustaf on the server"),
  "runtime-download": msg("Downloading Gustaf"),
  "runtime-verify": msg("Verifying the download"),
  "runtime-install": msg("Installing Gustaf"),
  "server-check": msg("Looking for a running server"),
  "server-reuse": msg("Using the running server"),
  "server-start": msg("Starting the server"),
  tunnel: msg("Opening the SSH tunnel"),
  pairing: msg("Creating a pairing token"),
  descriptor: msg("Reading the server description"),
  session: msg("Signing in to the server"),
};

const SHOW_FINISHED_ELAPSED_MS = 2_000;
const SHOW_RUNNING_ELAPSED_MS = 3_000;

const subscribeToSecondTick = (onTick: () => void) => {
  const timer = setInterval(onTick, 1_000);
  return () => clearInterval(timer);
};
const subscribeToNothing = () => () => {};

// A running step's elapsed time moves on its own, so the clock ticks only while one runs.
function useNow(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribeToSecondTick : subscribeToNothing,
    () => (active ? Math.floor(Date.now() / 1_000) * 1_000 : 0),
    () => 0,
  );
}

export function SshAddLog({ entries }: { readonly entries: ReadonlyArray<SshAddLogEntry> }) {
  const gt = useGT();
  const m = useMessages();
  const hasRunningStep = entries.some((entry) => entry.status === "running");
  const now = useNow(hasRunningStep);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: {
      target: "log",
      unavailableMessage: msg("Clipboard API is unavailable while copying the log."),
      failureMessage: msg("Failed to copy the log to the clipboard."),
    },
  });

  if (entries.length === 0) return null;

  const formatElapsed = (entry: SshAddLogEntry) => {
    const elapsed = sshAddLogElapsedMs(entry, now);
    const threshold =
      entry.status === "running" ? SHOW_RUNNING_ELAPSED_MS : SHOW_FINISHED_ELAPSED_MS;
    if (elapsed < threshold) return null;
    const totalSeconds = Math.floor(elapsed / 1_000);
    return totalSeconds < 60
      ? gt("{seconds}s", { seconds: totalSeconds })
      : gt("{minutes}m {seconds}s", {
          minutes: Math.floor(totalSeconds / 60),
          seconds: totalSeconds % 60,
        });
  };

  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{gt("Progress")}</span>
        <Button
          size="xs"
          variant="ghost"
          aria-label={gt("Copy log")}
          onClick={() => copyToClipboard(formatSshAddLog(entries), undefined)}
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {isCopied ? gt("Copied") : gt("Copy log")}
        </Button>
      </div>
      <ol className="space-y-1" aria-live="polite">
        {entries.map((entry) => {
          const elapsed = formatElapsed(entry);
          return (
            <li
              // A step can appear twice, as connect does after a password.
              key={`${entry.step}-${entry.startedAt}`}
              className={cn(
                "flex items-start gap-2 text-xs",
                entry.status === "failed" ? "text-destructive" : "text-foreground",
              )}
            >
              {entry.status === "done" ? (
                <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
              ) : entry.status === "failed" ? (
                <XIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <CircleDotIcon
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
              )}
              <span className="sr-only">
                {entry.status === "done"
                  ? gt("Done")
                  : entry.status === "failed"
                    ? gt("Failed")
                    : gt("In progress")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate">{m(STEP_LABELS[entry.step])}</span>
                  {entry.status !== "failed" && entry.detail !== undefined ? (
                    <span className="min-w-0 truncate text-muted-foreground">{entry.detail}</span>
                  ) : null}
                  {elapsed !== null ? (
                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                      {elapsed}
                    </span>
                  ) : null}
                </div>
                {entry.status === "failed" && entry.detail !== undefined ? (
                  <p className="mt-0.5 whitespace-pre-wrap break-words">{entry.detail}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
