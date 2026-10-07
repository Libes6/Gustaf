import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import { buildPairingUri, countdown, formatCode, groupFingerprint, qrMatrix, qrPath } from "../lib/mobilePairing";
import { SettingRow } from "./SettingRow";
import { mobileServer, type MobileDevice, type MobileStatus } from "../lib/mobileServer";

const POLL_MS = 2000;
const list = (v: MobileDevice[] | undefined | null): MobileDevice[] => (Array.isArray(v) ? v : []);

function Qr({ text, label }: { text: string; label: string }) {
  const matrix = qrMatrix(text);
  const n = matrix.length;
  // A white square with a 4-module quiet zone, so the code scans in dark mode too. Drawn locally; nothing is fetched.
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`-4 -4 ${n + 8} ${n + 8}`}
      width={220}
      height={220}
      shapeRendering="crispEdges"
      style={{ background: "#fff", borderRadius: 8 }}
    >
      <path d={qrPath(matrix)} fill="#000" />
    </svg>
  );
}

/** Settings > Mobile: master switch, status, pairing QR with countdown, paired devices. Self-contained (talks to mobile_server.rs only). */
export function MobileSettings() {
  const t = useT();
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [port, setPort] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const s = await mobileServer.status();
      setStatus(s ?? null);
      setDevices(list(await mobileServer.devices()));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const pairing = status?.pairing ?? null;
  useEffect(() => {
    if (!pairing) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pairing?.code]);

  const run = async (action: () => Promise<MobileStatus | void>) => {
    setBusy(true);
    setError("");
    try {
      const s = await action();
      if (s) setStatus(s);
      setDevices(list(await mobileServer.devices()));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const running = !!status?.running;
  const portNumber = port.trim() === "" ? undefined : Number(port);
  const portInvalid =
    portNumber !== undefined && (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535);
  const expired = !!pairing && pairing.expiresAt <= now;
  const showQr = running && pairing && !expired && status.host && status.port && status.fingerprint;
  const uri = showQr
    ? buildPairingUri({
        host: status.host!,
        port: status.port!,
        code: pairing.code,
        fingerprint: status.fingerprint!,
        protocol: status.protocol,
      })
    : "";

  return (
    <>
      <h1>{t("mobileTitle")}</h1>
      <p className="lead">{t("mobileLead")}</p>
      <div className="card">
        <SettingRow
          id="mobileSwitch"
          title={t("mobileSwitch")}
          description={
            running ? t("mobileListening", { host: status?.host ?? "", port: status?.port ?? 0 }) : t("mobileOff")
          }
          toggle={{
            on: running,
            disabled: busy || !status || portInvalid,
            onChange: () => void run(() => (running ? mobileServer.stop() : mobileServer.start(portNumber))),
          }}
        />
        <div className="card-row">
          <div className="grow d" role="note">
            {t("mobileWarning")}
          </div>
        </div>
        <SettingRow
          id="mobilePort"
          title={<label htmlFor="mobile-port">{t("mobilePort")}</label>}
          description={t("mobilePortHint")}
        >
          <input
            id="mobile-port"
            className="input"
            style={{ width: 110 }}
            inputMode="numeric"
            placeholder={status?.savedPort ? String(status.savedPort) : t("mobilePortAuto")}
            value={running ? String(status?.port ?? "") : port}
            disabled={running || busy}
            aria-invalid={portInvalid}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))}
          />
        </SettingRow>
        {running && status?.fingerprint && (
          <SettingRow
            id="mobileFingerprint"
            title={t("mobileFingerprint")}
            description={
              <span style={{ fontFamily: "var(--mono, monospace)", wordBreak: "break-all" }}>
                {groupFingerprint(status.fingerprint)}
              </span>
            }
          />
        )}
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {status?.error && !running && (
        <div className="error-box" role="alert">
          {status.error}
        </div>
      )}

      {running && (
        <>
          <h4 aria-level={2}>{t("mobilePairTitle")}</h4>
          <p className="h4-sub">{t("mobilePairSub")}</p>
          <div className="card">
            {showQr ? (
              <div className="card-row" style={{ alignItems: "flex-start", gap: 16 }}>
                <Qr text={uri} label={t("mobileQrAlt")} />
                <div className="grow">
                  <div className="d">{t("mobileCodeLabel")}</div>
                  <div
                    className="t"
                    style={{ fontFamily: "var(--mono, monospace)", fontSize: 22, letterSpacing: 2 }}
                    data-testid="pair-code"
                  >
                    {formatCode(pairing.code)}
                  </div>
                  <div className="d" role="timer" aria-live="off">
                    {t("mobileCodeExpires", { time: countdown(pairing.expiresAt, now) })}
                  </div>
                  <div className="d" style={{ marginTop: 8 }}>
                    {t("mobileScanHint")}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button
                      className="btn-soft"
                      disabled={busy}
                      onClick={() => void run(() => mobileServer.pairingStart())}
                    >
                      {t("mobileNewCode")}
                    </button>
                    <button
                      className="btn-soft"
                      disabled={busy}
                      onClick={() => void run(() => mobileServer.pairingCancel())}
                    >
                      {t("mobileHideQr")}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <SettingRow
                id="mobileShowQr"
                title={t("mobileShowQr")}
                description={expired ? t("mobileCodeExpired") : t("mobileNoCode")}
              >
                <button
                  className="btn-soft"
                  disabled={busy}
                  onClick={() => void run(() => mobileServer.pairingStart())}
                >
                  {t("mobileShowQr")}
                </button>
              </SettingRow>
            )}
          </div>
        </>
      )}

      <h4 aria-level={2}>{t("mobileDevices")}</h4>
      <div className="card">
        {!devices.length && <div className="card-row d">{t("mobileNoDevices")}</div>}
        {devices.map((d) => (
          <SettingRow
            key={d.id}
            title={d.name}
            description={
              <>
                {t("mobileDevicePaired", { date: t.date(d.createdAt) })} ·{" "}
                {d.lastSeenAt ? t("mobileDeviceSeen", { date: t.date(d.lastSeenAt) }) : t("mobileDeviceNeverSeen")}
              </>
            }
          >
            <button
              className="btn-soft"
              disabled={busy}
              aria-label={t("mobileRevokeLabel", { name: d.name })}
              onClick={() =>
                void run(async () => {
                  await mobileServer.revoke(d.id);
                })
              }
            >
              {t("mobileRevoke")}
            </button>
          </SettingRow>
        ))}
      </div>
    </>
  );
}
