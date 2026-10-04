import { useCallback, useEffect, useRef, useState } from "react";
import { knowledge, loadChatKnowledge, onKnowledgeChange, saveChatKnowledge, toggleId, type KnowledgeCollection } from "../agent/knowledge";

/**
 * Knowledge collections selected for one chat (settings key `chatKnowledge`, like the chat mode) and the list of collections
 * to pick from. A chat that is not created yet keeps its choice in memory and stores it when it gets its id on the first send.
 */
export function useChatKnowledge(chatId: number | null) {
  const [selected, setSelected] = useState<string[]>([]);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const ref = useRef(selected);
  const prevId = useRef(chatId);
  useEffect(() => {
    const before = prevId.current;
    prevId.current = chatId;
    if (chatId === null) {
      if (before !== null) { ref.current = []; setSelected([]); }
      return;
    }
    if (before === null) {
      if (ref.current.length) void saveChatKnowledge(chatId, ref.current);
      return;
    }
    let cancelled = false;
    ref.current = [];
    setSelected([]);
    loadChatKnowledge(chatId).then((ids) => { if (!cancelled) { ref.current = ids; setSelected(ids); } });
    return () => { cancelled = true; };
  }, [chatId]);
  useEffect(() => {
    let alive = true;
    const load = () => knowledge.list().then((list) => { if (alive) setCollections(Array.isArray(list) ? list : []); }, () => {});
    void load();
    const off = onKnowledgeChange(() => void load());
    return () => { alive = false; off(); };
  }, []);
  const toggle = useCallback((id: string) => {
    ref.current = toggleId(ref.current, id);
    setSelected(ref.current);
    if (prevId.current !== null) void saveChatKnowledge(prevId.current, ref.current);
  }, []);
  return { collections, selected: selected.filter((id) => collections.some((c) => c.id === id)), toggle };
}
export type ChatKnowledge = ReturnType<typeof useChatKnowledge>;
