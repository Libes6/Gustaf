import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Folder, FolderPlus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useT } from "../i18n";
import { createProject } from "../lib/data";
import { useDialogFocus } from "../lib/useDialogFocus";

export function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);

  const pick = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") {
      setPath(dir);
      if (!name) setName(dir.split("/").pop() ?? "");
    }
  };

  const create = async () => {
    const id = await createProject(name.trim() || path?.split("/").pop() || t("newProject"), path, path ? `local:${path}` : null);
    onCreated(id);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-label={t("createProject")} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>
          <span className="grow">{t("createProject")}</span>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onClose}>
            <X size={16} />
          </button>
        </h2>
        <div className="input-group">
          <span className="icon">
            <Folder size={16} />
          </span>
          <input autoFocus aria-label={t("projectName")} placeholder={t("projectName")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
        </div>
        <div className="sub">{t("sourceFolders")}</div>
        <div className="folder-box">
          {path ? (
            <span className="picked">{path}</span>
          ) : (
            <span>
              {t("addFolderOn")} <b style={{ color: "var(--text)", fontWeight: 500 }}>{t("thisComputer")}</b> <ChevronDown size={13} />
            </span>
          )}
          <button className="btn-soft" onClick={pick}>
            <FolderPlus size={14} /> {path ? t("change") : t("add")}
          </button>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" onClick={create}>
            {t("createProject")}
          </button>
        </div>
      </div>
    </div>
  );
}
