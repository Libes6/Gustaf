import { Check, Copy, WrapText } from "lucide-react";
import { isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import { parseArtifacts } from "../canvas/artifacts";
import { CanvasCard } from "./CanvasWorkspace";
import { MermaidBlock } from "./MermaidBlock";
import { HtmlPageCard } from "./HtmlPageCard";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useT } from "../i18n";

function textOfNode(n: ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOfNode).join("");
  if (isValidElement<{ children?: ReactNode }>(n)) return textOfNode(n.props.children);
  return "";
}

function CodeBlock({ lang, children }: { lang: string; children: ReactNode }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  return (
    <div className={`codeblock${wrap ? " wrap" : ""}`}>
      <div className="codeblock-head">
        <span>{lang || t("plainText")}</span>
        <span className="grow" />
        <button className="icon-btn" title={t("wrap")} onClick={() => setWrap(!wrap)}>
          <WrapText size={14} />
        </button>
        <button
          className="icon-btn"
          title={t("copy")}
          onClick={() => {
            navigator.clipboard.writeText(textOfNode(children));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

// Stable component identities preserve code-block controls while text streams in.
const components: Components = {
  pre: ({ children }) => {
    const code: ReactNode = Array.isArray(children) ? children[0] : children;
    const className = isValidElement<{ className?: string }>(code) ? code.props.className : undefined;
    const lang = /language-(\S+)/.exec(className ?? "")?.[1] ?? "";
    if (lang === "mermaid") return <MermaidBlock code={textOfNode(children).replace(/\n$/, "")} />;
    return <CodeBlock lang={lang}>{children}</CodeBlock>;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const segments = useMemo(() => parseArtifacts(text), [text]);
  return (
    <div className="md">
      {segments.map((segment, i) =>
        segment.type === "canvas" ? (
          <CanvasCard key={i} artifact={segment.artifact} />
        ) : segment.type === "page" ? (
          <HtmlPageCard key={i} page={segment.page} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
            components={components}
          >
            {segment.text}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
});
