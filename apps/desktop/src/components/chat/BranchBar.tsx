import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { loadChatBranch, loadBranchSource, listChatBranches, type Chat, type ChatBranch } from "../../lib/data";
import { useApp } from "../../state";

/** Source and siblings use persisted ids, never titles as identifiers. */
export function BranchBar({ chatId }: { chatId: number }) {
  const app = useApp();
  const t = useT();
  const [lineage, setLineage] = useState<ChatBranch | null>(null);
  const [source, setSource] = useState<Chat | null>(null);
  const [branches, setBranches] = useState<Chat[]>([]);
  useEffect(() => {
    let live = true;
    loadChatBranch(chatId)
      .then(async (link) => {
        const rows = await listChatBranches(link?.source_chat_id ?? chatId);
        const origin = link ? await loadBranchSource(link) : null;
        if (live) {
          setLineage(link);
          setBranches(rows);
          setSource(origin);
        }
      })
      .catch(() => {
        if (live) {
          setLineage(null);
          setBranches([]);
        }
      });
    return () => {
      live = false;
    };
  }, [chatId, app.chats]);
  if (!lineage && !branches.length) return null;
  return (
    <nav className="branch-bar" aria-label={t("branchNavigation")}>
      {lineage && (
        <button
          className="btn-ghost"
          disabled={!source}
          onClick={() => source && app.openChatAt(source.id, source.project_id, lineage.source_message_id)}
        >
          {t("branchSource")} {source?.title ?? lineage.source_title}
          {!source ? ` (${t("branchUnavailable")})` : ""}
        </button>
      )}
      {branches
        .filter((c) => c.id !== chatId)
        .map((c) => (
          <button className="btn-ghost" key={c.id} onClick={() => app.openChat(c.id, c.project_id)}>
            {c.title}
          </button>
        ))}
      <details>
        <summary>{t("branchTransfer")}</summary>
        <p>{t("branchTransferDetails")}</p>
      </details>
    </nav>
  );
}
