import { Check, Code2, Copy, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";

/** Waits this long after the last change before rendering, so a diagram that is still streaming is not re-rendered per token. */
const SETTLE_MS = 350;
let counter = 0;

type MermaidApi = typeof import("mermaid").default;
let loading: Promise<MermaidApi> | null = null;
let configuredFor = "";

/** Loads Mermaid on first use (a separate chunk) and configures it for the current theme. */
async function mermaidFor(theme: "dark" | "light"): Promise<MermaidApi> {
  loading ??= import("mermaid").then((m) => m.default);
  const mermaid = await loading;
  if (configuredFor !== theme) {
    // "strict": no click handlers or HTML labels from the diagram text; the SVG is sanitised by Mermaid's DOMPurify.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "inherit",
    });
    configuredFor = theme;
  }
  return mermaid;
}

const currentTheme = (): "dark" | "light" => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/**
 * A ```mermaid code block drawn as a diagram. Shows the code until the text has settled and rendered; a diagram that
 * cannot be parsed stays as code with a short note. "Code" / "Diagram" switches between the two.
 */
export function MermaidBlock({ code }: { code: string }) {
  const t = useT();
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState(currentTheme);
  const host = useRef<HTMLDivElement>(null);

  // Follow light/dark switches (lib/theme.ts sets data-theme on <html>).
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(currentTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const mermaid = await mermaidFor(theme);
        const { svg } = await mermaid.render(`gustaf-mermaid-${++counter}`, code);
        if (live) (setSvg(svg), setFailed(false));
      } catch {
        // Mermaid leaves its error graphic in the body when rendering fails; it is not ours to show.
        document.querySelectorAll('body > [id^="dgustaf-mermaid-"]').forEach((n) => n.remove());
        if (live) setFailed(true);
      }
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, theme]);

  const diagram = !!svg && !failed && !showCode;
  return (
    <div className="codeblock mermaid-block">
      <div className="codeblock-head">
        <span>mermaid</span>
        {failed && <span className="mermaid-note">{t("mermaidInvalid")}</span>}
        <span className="grow" />
        {!!svg && !failed && (
          <button
            className="icon-btn"
            title={showCode ? t("mermaidShowDiagram") : t("mermaidShowCode")}
            aria-label={showCode ? t("mermaidShowDiagram") : t("mermaidShowCode")}
            aria-pressed={showCode}
            onClick={() => setShowCode(!showCode)}
          >
            {showCode ? <Workflow size={14} /> : <Code2 size={14} />}
          </button>
        )}
        <button
          className="icon-btn"
          title={t("copy")}
          aria-label={t("copy")}
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {diagram ? (
        <div
          ref={host}
          className="mermaid-diagram"
          role="img"
          aria-label={t("mermaidDiagram")}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
