import { KeyRound } from "lucide-react";
import { useState } from "react";
import { useT } from "../../i18n";
import type { SecretRequest } from "../../lib/useChatRun";

/**
 * The private card of `request_secret` (T10): the value goes straight to the run as a one-use reference and is never
 * written to the chat, the draft or the action log. The field is a password input with autofill and spellcheck off.
 */
export function SecretCard({ request }: { request: SecretRequest }) {
  const t = useT();
  const [value, setValue] = useState("");
  const give = () => value && request.resolve(value);
  return (
    <section className="approval secret-card" role="dialog" aria-label={t("secretTitle", { name: request.name })}>
      <div className="secret-head"><KeyRound size={15} aria-hidden="true" /> <strong>{t("secretTitle", { name: request.name })}</strong></div>
      {request.reason && <p className="secret-reason">{request.reason}</p>}
      <input
        className="input" type="password" autoComplete="off" spellCheck={false} autoFocus aria-label={t("secretValue")}
        placeholder={t("secretValue")} value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") give(); if (e.key === "Escape") request.resolve(null); }}
      />
      <p className="secret-note">{t("secretNote")}</p>
      <div className="btns">
        <button className="btn btn-ghost" onClick={() => request.resolve(null)}>{t("secretDecline")}</button>
        <button className="btn btn-primary" disabled={!value} onClick={give}>{t("secretGive")}</button>
      </div>
    </section>
  );
}
