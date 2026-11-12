import type { EnvironmentId, RelayHostStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { shellAccount } from "../../shellAccount";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { relayHostEnvironment } from "../../state/relayHost";
import { useAtomCommand } from "../../state/use-atom-command";
import { useT } from "../../useUiLanguage";
import type { MessageKey } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const POLL_MS = 3_000;

const CONNECTION_LABELS: Record<RelayHostStatus["connection"], MessageKey> = {
  disabled: "settingsD.relay.disabled",
  connecting: "settingsD.relay.connecting",
  online: "settingsD.relay.online",
  offline: "settingsD.relay.offline",
  unauthorized: "settingsD.relay.unauthorized",
};

/** Reaching this computer from a phone on another network, through the Gustaf relay. */
export function RelayHostSettingsSection() {
  const environmentId = usePrimaryEnvironmentId();
  // The device credential comes from the shell's account; other clients cannot turn the relay on.
  return shellAccount() && environmentId ? (
    <RelayHostSettings environmentId={environmentId} />
  ) : null;
}

function RelayHostSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useT();
  const readStatus = useAtomCommand(relayHostEnvironment.status, { reportFailure: false });
  const createOffer = useAtomCommand(relayHostEnvironment.createOffer);
  const decide = useAtomCommand(relayHostEnvironment.decide);
  const revokeDevice = useAtomCommand(relayHostEnvironment.revokeDevice);
  const [status, setStatus] = useState<RelayHostStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCodes, setShowCodes] = useState(false);

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

  const act = async (work: () => Promise<{ _tag: string; value?: unknown }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await work();
      if (
        result._tag === "Success" &&
        result.value &&
        typeof result.value === "object" &&
        "connection" in result.value
      ) {
        setStatus(result.value as RelayHostStatus);
      }
    } finally {
      setBusy(false);
    }
  };

  const showOffer = () =>
    act(async () => {
      const result = await createOffer({ environmentId, input: null });
      if (result._tag === "Success") {
        setStatus((current) => (current ? { ...current, offer: result.value } : current));
      }
      return result;
    });

  if (!status) return null;
  const online = status.connection === "online";

  return (
    <SettingsSection id="relay-section" title={t("settingsD.relay.title")}>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {t("settingsD.relay.anyNetwork")}
            <Badge variant={online ? "success" : "secondary"}>
              {t(CONNECTION_LABELS[status.connection])}
            </Badge>
          </span>
        }
        description={
          status.connection === "disabled"
            ? t("settingsD.relay.disabledDescription")
            : (status.error ?? t("settingsD.relay.description"))
        }
        control={
          online && !status.offer ? (
            <Button size="sm" disabled={busy} onClick={() => void showOffer()}>
              {t("settingsD.relay.connectPhone")}
            </Button>
          ) : null
        }
      />
      {status.offer ? (
        <SettingsRow
          title={t("settingsD.relay.scanTitle")}
          description={t("settingsD.relay.scanDescription")}
          control={
            <div className="rounded-lg bg-white p-1.5">
              <QRCodeSvg
                value={status.offer.link}
                size={160}
                level="M"
                marginSize={1}
                title={t("settingsD.relay.scanTitle")}
              />
            </div>
          }
        />
      ) : null}
      {status.pending.map((pending) => (
        <SettingsRow
          key={pending.id}
          title={t("settingsD.relay.allowTitle").replace("{name}", pending.name)}
          description={t("settingsD.relay.safetyCode").replace("{code}", pending.safetyCode)}
          control={
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    decide({ environmentId, input: { id: pending.id, approve: false } }),
                  )
                }
              >
                {t("settingsD.relay.reject")}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    decide({ environmentId, input: { id: pending.id, approve: true } }),
                  )
                }
              >
                {t("settingsD.relay.allow")}
              </Button>
            </span>
          }
        />
      ))}
      {status.devices.map((device) => (
        <SettingsRow
          key={device.key}
          title={device.name}
          description={
            showCodes
              ? t("settingsD.relay.safetyCode").replace("{code}", device.safetyCode)
              : t("settingsD.relay.allowedAt").replace(
                  "{date}",
                  new Date(device.approvedAt).toLocaleDateString(),
                )
          }
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={() =>
                void act(() => revokeDevice({ environmentId, input: { key: device.key } }))
              }
            >
              {t("settingsD.account.revoke")}
            </Button>
          }
        />
      ))}
      {status.devices.length > 0 ? (
        <SettingsRow
          title={t("settingsD.relay.detailsTitle")}
          description={t("settingsD.relay.detailsDescription")}
          control={
            <Button size="sm" variant="ghost" onClick={() => setShowCodes((value) => !value)}>
              {showCodes ? t("settingsD.relay.hideCodes") : t("settingsD.relay.showCodes")}
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
