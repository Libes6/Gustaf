import { useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { useT } from "../../i18n";
import { joinChatReferences, splitChatReferences } from "../../lib/chatContext";
import type { QueueState } from "../../lib/chatQueue";

/** Pending work stays sequential; editing never rewrites its frozen attachments. */
export function QueuePanel({
  queue,
  onChange,
}: {
  queue: QueueState;
  onChange: (fn: (q: QueueState) => QueueState) => unknown;
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const closeEditor = (id: string) => {
    setEditing(null);
    editButtons.current.get(id)?.focus();
  };
  if (!queue.items.length && !queue.interrupted) return null;
  const save = (id: string) => {
    const item = queue.items.find((item) => item.id === id);
    if (!item || (!draft.trim() && !item.images.length && !splitChatReferences(item.text).references.length)) return;
    onChange((q) => ({
      ...q,
      items: q.items.map((item) =>
        item.id === id ? { ...item, text: joinChatReferences(draft, splitChatReferences(item.text).references) } : item,
      ),
    }));
    closeEditor(id);
  };
  return (
    <section className="queue-panel" aria-label={t("queueTitle")}>
      <div className="queue-header">
        <span className="queue-count" role="status">
          {t("queueTitle")} · {queue.items.length}
        </span>
        <div className="queue-controls">
          <button className="chip" onClick={() => onChange((q) => ({ ...q, paused: !q.paused, interrupted: false }))}>
            {t(queue.paused ? "queueResume" : "queuePause")}
          </button>
          {!!queue.items.length && (
            <button
              className="chip"
              onClick={() => {
                setEditing(null);
                onChange((q) => ({ ...q, items: [] }));
              }}
            >
              {t("queueClear")}
            </button>
          )}
        </div>
      </div>
      {queue.interrupted && <p className="queue-recovery">{t("queueInterrupted")}</p>}
      <div className="queue-list">
        {queue.items.map((item, index) => {
          const pending = splitChatReferences(item.text);
          const preview =
            pending.body.trim().replace(/\s+/g, " ") ||
            pending.references.map((ref) => ref.title).join(", ") ||
            t("queueImages");
          return (
            <div className="queue-item" key={item.id}>
              <div className="queue-row">
                <span className="queue-index">{index + 1}</span>
                <span className="queue-preview" title={preview}>
                  {preview}
                </span>
                {(item.images.length > 0 || pending.references.length > 0) && (
                  <span className="queue-attachments" title={t("queueAttachments")}>
                    +{item.images.length + pending.references.length}
                  </span>
                )}
                <button
                  ref={(node) => {
                    if (node) editButtons.current.set(item.id, node);
                    else editButtons.current.delete(item.id);
                  }}
                  className="queue-icon"
                  aria-label={t("queueEdit")}
                  title={t("queueEdit")}
                  onClick={() => {
                    setEditing(item.id);
                    setDraft(pending.body);
                  }}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="queue-icon"
                  aria-label={t("queueRemove")}
                  title={t("queueRemove")}
                  onClick={() => onChange((q) => ({ ...q, items: q.items.filter((i) => i.id !== item.id) }))}
                >
                  <X size={14} />
                </button>
              </div>
              {editing === item.id && (
                <div className="queue-editor">
                  <textarea
                    autoFocus
                    aria-label={t("queueEdit")}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        closeEditor(item.id);
                      }
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        save(item.id);
                      }
                    }}
                  />
                  {pending.references.map((ref, i) => (
                    <details className="chat-reference" key={`${ref.sourceId}:${i}`}>
                      <summary>{ref.title}</summary>
                      <pre>{ref.snapshot}</pre>
                    </details>
                  ))}
                  <div className="queue-controls">
                    <button className="chip" onClick={() => closeEditor(item.id)}>
                      {t("cancel")}
                    </button>
                    <button
                      className="chip"
                      disabled={!draft.trim() && !item.images.length && !pending.references.length}
                      onClick={() => save(item.id)}
                    >
                      {t("save")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
