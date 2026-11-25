import type { EnvironmentId, RelayHostStatus } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useFormattingLocale } from "../../i18n/I18nProvider";
import { shellAccount } from "../../shellAccount";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { relayHostEnvironment } from "../../state/relayHost";
import { useAtomCommand } from "../../state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const POLL_MS = 3_000;

const CONNECTION_LABELS: Record<RelayHostStatus["connection"], string> = {
  disabled: msg("Off", { $context: "relay host state" }),
  connecting: msg("Connecting"),
  online: msg("Online"),
  offline: msg("Offline"),
  unauthorized: msg("Not authorized"),
};

/** Reaching this computer from a phone or another computer on any network, through the Gustaf relay. */
export function RelayHostSettingsSection() {
  const environmentId = usePrimaryEnvironmentId();
  // The section hides itself when this client may not read the relay state.
  return environmentId ? <RelayHostSettings environmentId={environmentId} /> : null;
}

function RelayHostSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const formattingLocale = useFormattingLocale();
  const readStatus = useAtomCommand(relayHostEnvironment.status, { reportFailure: false });
  const createOffer = useAtomCommand(relayHostEnvironment.createOffer);
  const decide = useAtomCommand(relayHostEnvironment.decide);
  const revokeDevice = useAtomCommand(relayHostEnvironment.revokeDevice);
  const setTrust = useAtomCommand(relayHostEnvironment.setTrust);
  const [status, setStatus] = useState<RelayHostStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCodes, setShowCodes] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The relay state lives on the server; approvals arrive while the QR code is shown.
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void readStatus({ environmentId, input: null }).then((result) => {
        if (!cancelled && result._tag === "Success") setStatus(result.value);
      });
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- readStatus is rebuilt every render; polling restarts only for another environment.
  }, [environmentId]);

  const act = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void work().finally(() => setBusy(false));
  };

  const runStatusMutation = (
    work: () => Promise<{ readonly _tag: string; readonly value?: RelayHostStatus }>,
  ) =>
    act(async () => {
      const result = await work();
      if (result._tag === "Success" && result.value) {
        setStatus(result.value);
      }
    });

  const showOffer = () =>
    act(async () => {
      const result = await createOffer({ environmentId, input: null });
      if (result._tag === "Success") {
        setStatus((current) => (current ? { ...current, offer: result.value } : current));
      }
    });

  if (!status) return null;
  const online = status.connection === "online";
  // The desktop app signs in under Account; a `gustaf serve` computer signs in from its terminal.
  if (status.connection === "disabled" && shellAccount() === undefined) {
    return (
      <SettingsSection id="relay-section" title={gt("Any network (Gustaf relay)")}>
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              <T>Reach this computer from any network</T>
              <Badge variant="secondary">{m(CONNECTION_LABELS.disabled)}</Badge>
            </span>
          }
          description={gt(
            "Run `gustaf relay login` in a terminal on this computer to sign it in to your Gustaf account.",
          )}
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="relay-section" title={gt("Any network (Gustaf relay)")}>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <T>Reach this computer from any network</T>
            <Badge variant={online ? "success" : "secondary"}>
              {m(CONNECTION_LABELS[status.connection])}
            </Badge>
          </span>
        }
        description={
          status.connection === "disabled"
            ? gt("Register this computer in Account above to turn this on.")
            : (status.error ??
              gt(
                "Your phone or another computer with the Gustaf app connects through the Gustaf relay with end-to-end encryption. The relay sees only that two of your devices are talking, not what they say.",
              ))
        }
        control={
          online && !status.offer ? (
            <Button size="sm" disabled={busy} onClick={showOffer}>
              <T>Connect a device</T>
            </Button>
          ) : null
        }
      />
      {status.trustOtherDevices !== undefined && status.connection !== "disabled" ? (
        <SettingsRow
          title={gt("Trust my other devices")}
          description={gt(
            "A device you already allowed here can pair again from your account's computer list without asking. A new device always needs your approval. Turning this off ends the sessions it let in.",
          )}
          control={
            <Switch
              checked={status.trustOtherDevices}
              disabled={busy}
              aria-label={gt("Trust my other devices")}
              onCheckedChange={(enabled) =>
                runStatusMutation(() => setTrust({ environmentId, input: { enabled } }))
              }
            />
          }
        />
      ) : null}
      {status.offer ? (
        <SettingsRow
          title={gt("Scan with the Gustaf app")}
          description={gt(
            "Scan this code in Gustaf on your phone, or paste the link in the desktop app on another computer under Settings → Environments → Add environment → Gustaf relay. It works once, for five minutes.",
          )}
          control={
            <div className="rounded-lg bg-white p-1.5">
              <QRCodeSvg
                value={status.offer.link}
                size={160}
                level="M"
                marginSize={1}
                title={gt("Scan with the Gustaf app")}
              />
            </div>
          }
        />
      ) : null}
      {status.offer ? (
        <SettingsRow
          title={gt("Pairing link")}
          description={
            <code className="block break-all font-mono text-2xs select-all">
              {status.offer.link}
            </code>
          }
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => status.offer && copyToClipboard(status.offer.link, undefined)}
            >
              {isCopied ? <T>Copied</T> : <T>Copy link</T>}
            </Button>
          }
        />
      ) : null}
      {status.pending.map((pending) => (
        <SettingsRow
          key={pending.id}
          title={
            pending.peerLink
              ? gt("Allow “{name}” to link its agents here?", { name: pending.name })
              : pending.viaAccount
                ? gt("Allow “{name}” to connect from your account?", { name: pending.name })
                : gt("Allow “{name}”?", { name: pending.name })
          }
          description={
            pending.viaAccount
              ? gt(
                  "Safety code {code}: it must match the code shown on {name}. Only allow it if you just started this on that device.",
                  { code: pending.safetyCode, name: pending.name },
                )
              : pending.peerLink
                ? gt(
                    "{access}. Safety code {code}: it must match the code shown on {name}. Only allow it if you just started this link.",
                    {
                      access: m(accessConfig[pending.peerLink.access].label),
                      code: pending.safetyCode,
                      name: pending.name,
                    },
                  )
                : gt("Safety code {code}", { code: pending.safetyCode })
          }
          control={
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  runStatusMutation(() =>
                    decide({ environmentId, input: { id: pending.id, approve: false } }),
                  )
                }
              >
                <T>Reject</T>
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  runStatusMutation(() =>
                    decide({ environmentId, input: { id: pending.id, approve: true } }),
                  )
                }
              >
                {pending.peerLink ? <T>Allow link</T> : <T>Allow device</T>}
              </Button>
            </span>
          }
        />
      ))}
      {status.devices.map((device) => (
        <SettingsRow
          key={device.key}
          title={
            <span className="flex items-center gap-2">
              {device.name}
              {status.trustOtherDevices === true && device.trusted === true ? (
                <Badge variant="outline" size="sm">
                  <T>Trusted</T>
                </Badge>
              ) : null}
            </span>
          }
          description={
            showCodes
              ? gt("Safety code {code}", { code: device.safetyCode })
              : device.lastSeenAt === undefined
                ? gt("Allowed on {date}", {
                    date: new Date(device.approvedAt).toLocaleDateString(formattingLocale),
                  })
                : gt("Allowed on {date}. Last seen {lastSeen}.", {
                    date: new Date(device.approvedAt).toLocaleDateString(formattingLocale),
                    lastSeen: new Date(device.lastSeenAt).toLocaleString(formattingLocale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })
          }
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={() =>
                runStatusMutation(() => revokeDevice({ environmentId, input: { key: device.key } }))
              }
            >
              <T>Revoke</T>
            </Button>
          }
        />
      ))}
      {status.devices.length > 0 ? (
        <SettingsRow
          title={gt("Details")}
          description={gt(
            "Each allowed phone shows the same safety code. Matching codes mean nobody sits between the two devices.",
          )}
          control={
            <Button size="sm" variant="ghost" onClick={() => setShowCodes((value) => !value)}>
              {showCodes ? <T>Hide safety codes</T> : <T>Show safety codes</T>}
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
