// The card for the pinned element: what it is, where it is, whether a tap would reach it, and quick actions.

import { useState } from "react";
import { useT } from "../../i18n";
import { ancestors, describeNode, type UiMap, type UiNode } from "../../device/uiMap";
import { nodeTitle } from "./mapRows";

type Props = {
  map: UiMap;
  node: UiNode;
  tapDisabled: boolean;
  onTap: (node: UiNode) => void;
  onClose: () => void;
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function DeviceDetails({ map, node, tapDisabled, onTap, onClose }: Props) {
  const t = useT();
  const [copied, setCopied] = useState<"ref" | "label" | "failed" | null>(null);
  const copy = async (kind: "ref" | "label", text: string) => {
    setCopied((await copyText(text)) ? kind : "failed");
    setTimeout(() => setCopied(null), 1500);
  };
  const chain = ancestors(map, node)
    .reverse()
    .map((a) => `${a.role}${a.label ? ` “${a.label}”` : ""}`);
  const r = node.rect;
  const yes = (v: boolean) => (v ? t("deviceYes") : t("deviceNo"));
  const rows: [string, string | undefined][] = [
    [t("deviceDetailRole"), node.role],
    [t("deviceDetailLabel"), node.label],
    [t("deviceDetailId"), node.id],
    [t("deviceDetailValue"), node.value ?? node.placeholder],
    [t("deviceDetailRect"), `${Math.round(r.x)}, ${Math.round(r.y)} · ${Math.round(r.width)}×${Math.round(r.height)}`],
    [t("deviceDetailEnabled"), yes(node.enabled)],
    [t("deviceDetailHittable"), yes(node.hittable)],
    [t("deviceDetailCovered"), node.blocked ?? t("deviceNo")],
    [t("deviceDetailParents"), chain.length ? chain.join(" › ") : "—"],
  ];
  return (
    <section className="dev-details" aria-label={t("deviceDetailsTitle")}>
      <header>
        <strong>{nodeTitle(node) || node.role}</strong>
        <code className="dev-dim" title={describeNode(node)}>
          @{node.ref}
        </code>
        <button className="dev-btn dev-close" onClick={onClose} aria-label={t("deviceUnpin")}>
          ×
        </button>
      </header>
      <dl>
        {rows.map(([k, v]) =>
          v === undefined ? null : (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ),
        )}
      </dl>
      <div className="dev-actions">
        <button className="dev-btn" onClick={() => void copy("ref", `@${node.ref}`)}>
          {t("deviceCopyRef")}
        </button>
        <button className="dev-btn" disabled={!node.label} onClick={() => void copy("label", node.label ?? "")}>
          {t("deviceCopyLabel")}
        </button>
        <button className="dev-btn primary" disabled={tapDisabled} onClick={() => onTap(node)}>
          {t("deviceTapThis")}
        </button>
        <span className="dev-dim" role="status">
          {copied === "failed" ? t("deviceCopyFailed") : copied ? t("deviceCopied") : ""}
        </span>
      </div>
    </section>
  );
}
