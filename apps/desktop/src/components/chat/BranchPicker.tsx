import { useState } from "react";
import { useApp } from "../../state";
import { useT } from "../../i18n";

export type BranchSelection = { providerId: string; model: string };
/** Creating the copy and choosing its next model are explicit, separate from running it. */
export function BranchPicker({
  busy,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (selection: BranchSelection) => Promise<void>;
}) {
  const app = useApp();
  const t = useT();
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  return (
    <section className="branch-picker" aria-label={t("branchChooseModel")}>
      <label>
        {t("branchChooseModel")}{" "}
        <select value={selected} disabled={creating} onChange={(e) => setSelected(e.target.value)}>
          <option value="">{t("branchChooseModel")}</option>
          {app.models
            .filter((m) => app.providers.some((p) => p.id === m.providerId))
            .map((m) => (
              <option key={`${m.providerId}:${m.id}`} value={JSON.stringify({ providerId: m.providerId, model: m.id })}>
                {app.providers.find((p) => p.id === m.providerId)?.name} · {m.name}
              </option>
            ))}
        </select>
      </label>
      <p>{t("branchTransferDetails")}</p>
      <button className="btn-ghost" disabled={creating} onClick={onCancel}>
        {t("cancel")}
      </button>
      <button
        className="btn-ghost"
        disabled={!selected || busy || creating}
        onClick={async () => {
          setCreating(true);
          try {
            await onCreate(JSON.parse(selected));
          } finally {
            setCreating(false);
          }
        }}
      >
        {t("branchSuffix")}
      </button>
    </section>
  );
}
