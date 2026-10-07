import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2, LogIn, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { cursorProfiles, type CursorIdentity } from "../lib/api";
import { deleteProvider, saveProvider } from "../providers";
import { addToPool, profileName } from "../providers/cursorAccounts";
import { updatePool } from "../providers/cursorPoolStore";
import { loginUrl, startCursorLogin } from "../providers/cursorLogin";
import type { ProviderConfig } from "../providers/types";
import { useApp } from "../state";
import { CursorPool } from "./CursorPool";

const POLL_MS = 2500;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Flow = { output: string; waiting: boolean; error?: string };

/** Cursor accounts that log in through the CLI, each in its own isolated profile (CURSOR_CONFIG_DIR). */
export function CursorAccounts() {
  const t = useT();
  const app = useApp();
  const accounts = app.providers.filter((p) => p.cli === "cursor-agent" && p.cliProfile);
  const [who, setWho] = useState<Record<string, CursorIdentity | "error">>({});
  const [flow, setFlow] = useState<Flow | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);

  const names = accounts.map((a) => a.cliProfile).join(",");
  useEffect(() => {
    let live = true;
    for (const a of accounts) {
      cursorProfiles.status(a.cliProfile!).then(
        (s) => live && setWho((w) => ({ ...w, [a.id]: s })),
        () => live && setWho((w) => ({ ...w, [a.id]: "error" })),
      );
    }
    return () => {
      live = false;
    };
  }, [names]);

  /** Creates (or reuses) the profile, runs the login and polls `status` until the account is signed in. */
  async function login(existing?: ProviderConfig) {
    if (flow) return;
    const name = existing?.cliProfile ?? profileName(Date.now());
    let stop = false;
    let process: Awaited<ReturnType<typeof startCursorLogin>> | undefined;
    cancel.current = () => {
      stop = true;
    };
    setFlow({ output: "", waiting: true });
    try {
      const dir = await cursorProfiles.create(name);
      let exited = false;
      process = await startCursorLogin(dir, (chunk) =>
        setFlow((f) => f && { ...f, output: (f.output + chunk).slice(-2000) }),
      );
      process.done.then(() => {
        exited = true;
      });
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      let identity: CursorIdentity | undefined;
      while (!stop && Date.now() < deadline) {
        await sleep(POLL_MS);
        const finished = exited;
        const s = await cursorProfiles.status(name).catch(() => undefined);
        if (s?.loggedIn) {
          identity = s;
          break;
        }
        // The CLI already ended before this check and the account is still signed out: give up.
        if (finished) break;
      }
      if (!identity) {
        if (!existing) await cursorProfiles.remove(name).catch(() => {});
        setFlow(stop ? null : { output: "", waiting: false, error: t("cursorLoginFailed") });
        return;
      }
      const id = existing?.id ?? `cli-${name}`;
      if (!existing) {
        await saveProvider(
          {
            id,
            kind: "cli",
            cli: "cursor-agent",
            cliProfile: name,
            name: identity.email ?? `Cursor ${accounts.length + 1}`,
            baseUrl: "",
          },
          null,
        );
        await updatePool((pool) => addToPool(pool, id));
      }
      setWho((w) => ({ ...w, [id]: identity! }));
      await app.refreshModels({ only: [id] });
      setFlow(null);
    } catch (e: any) {
      if (!existing) await cursorProfiles.remove(name).catch(() => {});
      setFlow({ output: "", waiting: false, error: String(e?.message ?? e) });
    } finally {
      await process?.kill();
      cancel.current = null;
    }
  }

  const remove = async (a: ProviderConfig) => {
    await deleteProvider(a.id);
    await app.refreshModels({ refresh: "startup" });
  };

  const link = flow ? loginUrl(flow.output) : undefined;
  return (
    <>
      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("cursorAccounts")}</div>
            <div className="d">{t("cursorAccountsHint")}</div>
          </div>
          <button className="btn-soft" disabled={!!flow} onClick={() => login()}>
            <Plus size={13} /> {t("addCursorAccount")}
          </button>
        </div>
        {accounts.map((a) => {
          const s = who[a.id];
          return (
            <div className="card-row" key={a.id}>
              <div className="grow">
                <div className="t">{a.name}</div>
                <div className="d">
                  {s === "error"
                    ? t("cursorAccountStatusError")
                    : !s
                      ? "…"
                      : s.loggedIn
                        ? (s.email ?? t("cursorAccountLoggedIn"))
                        : t("cursorAccountLoggedOut")}
                </div>
              </div>
              <button className="btn-soft" disabled={!!flow} onClick={() => login(a)}>
                <LogIn size={13} /> {t("cursorReLogin")}
              </button>
              <button className="icon-btn" disabled={!!flow} title={t("cursorRemoveAccount")} onClick={() => remove(a)}>
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        {flow && (
          <div className="card-row" style={{ display: "block" }}>
            {flow.error ? (
              <div className="err" style={{ whiteSpace: "pre-wrap" }}>
                {flow.error}
              </div>
            ) : (
              <div className="d">
                <Loader2 size={13} className="spin" /> {t("cursorLoginWaiting")}
              </div>
            )}
            {flow.output && (
              <pre className="mono d" style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>
                {flow.output}
              </pre>
            )}
            {link && (
              <button className="btn-soft" onClick={() => openUrl(link)}>
                <ExternalLink size={13} /> {t("cursorLoginOpenLink")}
              </button>
            )}
            <button className="btn-ghost small" onClick={() => (flow.waiting ? cancel.current?.() : setFlow(null))}>
              {t(flow.waiting ? "cancel" : "dismiss")}
            </button>
          </div>
        )}
      </div>
      <CursorPool />
    </>
  );
}
