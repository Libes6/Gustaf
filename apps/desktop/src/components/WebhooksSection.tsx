import { Copy, RotateCw, Webhook } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useT } from "../i18n";
import type { ScheduledPrompt } from "../lib/scheduledPrompts";
import { getDeliveries, getWebhookConfig, rotateSecret, setHook, setWebhookPort, subscribeWebhooks, webhookServer, webhooksVersion } from "../lib/webhooks";
import { webhookUrl } from "../lib/webhooksCore";

/**
 * Webhook triggers of the schedules (T12): per schedule a URL and secret (Copy / Rotate) and the last deliveries. The
 * server listens on 127.0.0.1 only; reaching it from GitHub needs a tunnel the user runs. The signature is GitHub's
 * `X-Hub-Signature-256`, so the secret goes into the webhook's "Secret" field there.
 */
export function WebhooksSection({ list }: { list: ScheduledPrompt[] }) {
  const t = useT();
  useSyncExternalStore(subscribeWebhooks, webhooksVersion);
  const cfg = getWebhookConfig();
  const server = webhookServer();
  const [copied, setCopied] = useState("");
  const [port, setPort] = useState(String(cfg.port));
  const copy = (key: string, text: string) => { void navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1200); };
  if (!list.length) return null;
  const portOk = /^\d+$/.test(port) && +port >= 1024 && +port <= 65535;
  return (
    <>
      <h4 aria-level={2} className="webhook-heading"><Webhook size={15} aria-hidden="true" /> {t("webhooksTitle")}</h4>
      <p className="h4-sub">{t("webhooksLead")}</p>
      <div className="card">
        <div className="card-row">
          <div className="grow"><div className="t">{t("webhooksPort")}</div><div className="d">{server.port ? t("webhooksListening", { port: server.port }) : server.error ? server.error : t("webhooksIdle")}</div></div>
          <input className="input sched-num" aria-label={t("webhooksPort")} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} onBlur={() => portOk && +port !== cfg.port && setWebhookPort(+port)} />
        </div>
        {list.map((s) => {
          const h = cfg.hooks[s.id];
          const on = !!h?.enabled;
          const deliveries = getDeliveries(s.id);
          return (
            <div className="card-row webhook-row" key={s.id}>
              <div className="grow">
                <div className="t">{s.title}</div>
                {on && h && (
                  <div className="webhook-fields">
                    <code className="webhook-url">{webhookUrl(cfg.port, s.id)}</code>
                    <button className="btn-soft" onClick={() => copy(`u${s.id}`, webhookUrl(cfg.port, s.id))}><Copy size={12} aria-hidden="true" /> {copied === `u${s.id}` ? t("copied") : t("webhooksCopyUrl")}</button>
                    <button className="btn-soft" onClick={() => copy(`s${s.id}`, h.secret)}><Copy size={12} aria-hidden="true" /> {copied === `s${s.id}` ? t("copied") : t("webhooksCopySecret")}</button>
                    <button className="btn-soft" onClick={() => rotateSecret(s.id)}><RotateCw size={12} aria-hidden="true" /> {t("webhooksRotate")}</button>
                  </div>
                )}
                {on && !s.enabled && <div className="d">{t("webhooksScheduleOff")}</div>}
                {on && deliveries.length > 0 && (
                  <ul className="webhook-deliveries" aria-label={t("webhooksDeliveries")}>
                    {deliveries.slice(0, 5).map((d, i) => (
                      <li key={`${d.at}-${i}`} className={`d webhook-${d.outcome}`}>{t.date(d.at)} · {d.event || "—"} · {t(`webhookOutcome_${d.outcome}`)}</li>
                    ))}
                  </ul>
                )}
              </div>
              <Toggle on={on} label={t("webhooksEnable", { title: s.title })} onChange={(v) => setHook(s.id, v)} />
            </div>
          );
        })}
      </div>
    </>
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

