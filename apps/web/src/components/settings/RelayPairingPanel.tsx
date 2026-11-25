import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type RelayComputer,
  type RelayComputersLoad,
  type RelayPairingProgress,
  RELAY_PAIRING_IDLE,
  connectRelayPairing,
  isRelayPairingLink,
  relayComputersOfEnvironments,
  relayComputersView,
  startRelayComputerPairing,
} from "@t3tools/client-runtime/gustaf-relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import type { EnvironmentPresentation } from "~/state/environments";
import { desktopRelay } from "../../relay/desktopRelay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

/**
 * Pairs the desktop app with a computer through the Gustaf relay. The computers of the user's
 * account are the default: one click, then the computer's own user allows it after comparing the
 * safety code. A relay link copied from the other computer stays as the fallback.
 */
export function RelayPairingPanel({
  routeTarget,
  savedEnvironments,
  onPaired,
}: {
  readonly routeTarget: { readonly environmentId: EnvironmentId; readonly label: string } | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly onPaired: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [load, setLoad] = useState<RelayComputersLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<RelayPairingProgress>(RELAY_PAIRING_IDLE);
  const [showLink, setShowLink] = useState(false);
  const [link, setLink] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pairing = useRef<{ readonly cancel: () => void } | null>(null);
  const busy = status !== null || progress.phase === "connecting" || progress.phase === "waiting";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The account's computers live on the relay and are read over the network.
  useEffect(() => {
    if (!desktopRelay) return;
    const controller = new AbortController();
    void desktopRelay.computers(controller.signal).then((result) => {
      if (!controller.signal.aborted) setLoad({ status: "done", result });
    });
    return () => controller.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `attempt` only asks for another read.
  }, [attempt]);

  // Leaving the dialog while a computer waits for its user ends the request.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ends a request that lives on another computer.
  useEffect(() => () => pairing.current?.cancel(), []);

  const view = relayComputersView(
    load,
    relayComputersOfEnvironments(savedEnvironments.map((e) => e.entry)),
  );
  const linkOpen = showLink || view.kind !== "list";

  const connect = async (pairingUrl: string, environmentId: EnvironmentId | undefined) => {
    const result = await connectPairing({
      pairingUrl,
      ...(environmentId ? { expectedEnvironmentId: environmentId } : {}),
    });
    if (result._tag === "Success") return { ok: true, error: null };
    const failure = squashAtomCommandFailure(result);
    return {
      ok: false,
      error:
        !isAtomCommandInterrupted(result) && failure instanceof Error
          ? (thrownErrorMessage(failure, m) ?? failure.message)
          : gt("Pairing over the relay failed."),
    };
  };

  const pairWithComputer = (computer: RelayComputer) => {
    if (!desktopRelay || busy) return;
    setError(null);
    const started = startRelayComputerPairing({
      relay: desktopRelay,
      computer,
      routeFor: routeTarget?.environmentId,
      connect,
      onProgress: setProgress,
      resolve: m,
    });
    pairing.current = started;
    void started.done.then((result) => {
      if (pairing.current === started) pairing.current = null;
      if (result.status === "paired") onPaired();
    });
  };

  /** Resolves to the error to show, or null once paired. */
  const runLinkPairing = async (relay: NonNullable<typeof desktopRelay>) => {
    const pairingUrl = await relay.pair(link.trim(), (safetyCode) =>
      setStatus(
        gt(
          "Allow this computer on the other one to finish pairing. It shows the same safety code: {code}",
          { code: safetyCode },
        ),
      ),
    );
    const outcome = await connectRelayPairing(pairingUrl, routeTarget?.environmentId, connect);
    return outcome.ok ? null : outcome.error;
  };

  const pairWithLink = async () => {
    if (!desktopRelay || busy) return;
    if (!isRelayPairingLink(link)) {
      setError(
        gt(
          "This is not a Gustaf relay link. Copy it from Settings → Sharing & access on the other computer.",
        ),
      );
      return;
    }
    setError(null);
    setStatus(gt("Connecting to the computer through the Gustaf relay…"));
    const failure = await runLinkPairing(desktopRelay).then(
      (outcomeError) => ({ error: outcomeError }),
      (cause: unknown) => ({
        error: cause instanceof Error ? cause.message : gt("Pairing over the relay failed."),
      }),
    );
    setStatus(null);
    if (failure.error === null) onPaired();
    else setError(failure.error);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <span className="block text-xs font-medium text-foreground">
          <T>Your computers</T>
        </span>
        {view.kind === "loading" ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size="sm" tone="muted" />
            <T>Looking for the computers on your Gustaf account…</T>
          </p>
        ) : view.kind === "signedOut" ? (
          <p className="text-xs text-muted-foreground">
            <T>
              Sign in and register this computer under Settings → Account to see the computers of
              your Gustaf account here.
            </T>
          </p>
        ) : view.kind === "unavailable" ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              <T>Could not reach the Gustaf relay.</T>
            </p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setLoad({ status: "loading" });
                setAttempt((count) => count + 1);
              }}
            >
              <RefreshCwIcon className="size-3" />
              <T>Try again</T>
            </Button>
          </div>
        ) : view.kind === "empty" ? (
          <p className="text-xs text-muted-foreground">
            <T>
              No other computers on your account yet. Open Gustaf on a computer and sign in with the
              same account.
            </T>
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {view.computers.map((computer) => (
              <li
                key={computer.deviceId}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className={
                      computer.online
                        ? "size-2 shrink-0 rounded-full bg-success"
                        : "size-2 shrink-0 rounded-full bg-muted-foreground/40"
                    }
                  />
                  <span className="min-w-0 truncate text-sm">{computer.name}</span>
                  <Badge variant={computer.online ? "success" : "outline"} size="sm">
                    {computer.online ? gt("Online") : gt("Offline")}
                  </Badge>
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!computer.online || busy}
                  aria-label={gt("Connect to {name}", { name: computer.name })}
                  onClick={() => pairWithComputer(computer)}
                >
                  <T>Connect</T>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {progress.phase === "idle" ? null : (
          <div
            role="status"
            className="space-y-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm"
          >
            {progress.phase === "connecting" ? (
              <p className="text-muted-foreground">
                {gt("Connecting to {name} through the Gustaf relay…", {
                  name: progress.computer.name,
                })}
              </p>
            ) : progress.phase === "waiting" ? (
              <>
                <p className="text-muted-foreground">
                  {gt(
                    "Allow this computer on {name} to finish pairing. It shows the same safety code: {code}",
                    { name: progress.computer.name, code: progress.safetyCode },
                  )}
                </p>
                <p className="font-mono text-base font-semibold tracking-wider select-all">
                  {progress.safetyCode}
                </p>
              </>
            ) : (
              <p className="text-error-foreground">{progress.message}</p>
            )}
            {progress.phase === "connecting" || progress.phase === "waiting" ? (
              <Button size="xs" variant="outline" onClick={() => pairing.current?.cancel()}>
                <T>Cancel</T>
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {view.kind === "list" && !showLink ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setShowLink(true)}>
          <T>Paste a relay link instead</T>
        </Button>
      ) : null}

      {linkOpen ? (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              <T>Pairing link</T>
            </span>
            <Input
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) void pairWithLink();
              }}
              placeholder="gustaf://relay-pair?…"
              disabled={busy}
              spellCheck={false}
            />
            <span className="mt-1 block text-2xs text-muted-foreground">
              <T>
                On the other computer open Settings → Sharing & access, choose Connect a device and
                copy the link.
              </T>
            </span>
          </label>
          {status !== null ? <p className="text-xs text-muted-foreground">{status}</p> : null}
          {error !== null ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Button
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => void pairWithLink()}
          >
            <PlusIcon className="size-3.5" />
            {status !== null
              ? gt("Adding…")
              : routeTarget
                ? gt("Add route")
                : gt("Add environment")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
