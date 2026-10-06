import { Check, Copy, FileCode2, Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n";
import type { HtmlPage } from "../canvas/artifacts";

/**
 * A static page the agent wrote (```html-page, T11). The frame is fully sandboxed (`sandbox=""`: no scripts, forms,
 * popups or same-origin access) and inherits the app's CSP, so it cannot load anything from the network.
 */
export function HtmlPageCard({ page }: { page: HtmlPage }) {
  const t = useT();
  const [tall, setTall] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock html-page">
      <div className="codeblock-head">
        <span className="html-page-title">{page.title}</span>
        <span className="grow" />
        {page.complete && (
          <>
            <button className="icon-btn" title={showCode ? t("htmlPageShowPage") : t("htmlPageShowCode")} aria-label={showCode ? t("htmlPageShowPage") : t("htmlPageShowCode")} aria-pressed={showCode} onClick={() => setShowCode(!showCode)}><FileCode2 size={14} /></button>
            <button className="icon-btn" title={tall ? t("htmlPageSmaller") : t("htmlPageLarger")} aria-label={tall ? t("htmlPageSmaller") : t("htmlPageLarger")} onClick={() => setTall(!tall)}>{tall ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
          </>
        )}
        <button className="icon-btn" title={t("copy")} aria-label={t("copy")} onClick={() => { navigator.clipboard.writeText(page.html); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {!page.complete ? (
        <div className="html-page-pending" role="status">{t("htmlPageWriting")}</div>
      ) : showCode ? (
        <pre><code>{page.html}</code></pre>
      ) : (
        <iframe title={page.title} sandbox="" referrerPolicy="no-referrer" srcDoc={page.html} className={`html-page-frame${tall ? " tall" : ""}`} />
      )}
    </div>
  );
}
