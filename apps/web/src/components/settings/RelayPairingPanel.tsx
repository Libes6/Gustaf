import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { connectRelayPairing, isRelayPairingLink } from "@t3tools/client-runtime/gustaf-relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { desktopRelay } from "../../relay/desktopRelay";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Pairs the desktop app with a computer through the Gustaf relay: the other computer's link,
 * its approval, then an ordinary pairing at the computer's virtual relay address.
 */
export function RelayPairingPanel({
  routeTarget,
  onPaired,
}: {
  readonly routeTarget: { readonly environmentId: EnvironmentId; readonly label: string } | null;
  readonly onPaired: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [link, setLink] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = status !== null;

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

  /** Resolves to the error to show, or null once paired. */
  const runPairing = async (relay: NonNullable<typeof desktopRelay>) => {
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

  const pair = async () => {
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
    const failure = await runPairing(desktopRelay).then(
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
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void pair();
          }}
          placeholder="gustaf://relay-pair?…"
          disabled={busy}
          spellCheck={false}
        />
        <span className="mt-1 block text-2xs text-muted-foreground">
          <T>
            On the other computer open Settings → Sharing & access, choose Connect a device and copy
            the link.
          </T>
        </span>
      </label>
      {status !== null ? <p className="text-xs text-muted-foreground">{status}</p> : null}
      {error !== null ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button variant="outline" className="w-full" disabled={busy} onClick={() => void pair()}>
        <PlusIcon className="size-3.5" />
        {busy ? gt("Adding…") : routeTarget ? gt("Add route") : gt("Add environment")}
      </Button>
    </div>
  );
}
