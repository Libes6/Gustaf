import { BookOpen } from "lucide-react";
import type { KnowledgeCollection } from "../../agent/knowledgeCore";
import type { MenuEntry } from "../Menu";

export type KnowledgePick = {
  collections: KnowledgeCollection[];
  selected: string[];
  toggle: (id: string) => void;
  onManage?: () => void;
};

/** Entries of the composer's "+" menu: one checkable row per collection, or a way to set collections up when there are none. */
export function knowledgeEntries(
  k: KnowledgePick,
  t: (key: any, vars?: Record<string, string | number>) => string,
): MenuEntry[] {
  const icon = <BookOpen size={15} />;
  if (!k.collections.length)
    return k.onManage ? [{ sep: true }, { label: t("knowledgeMenuSetup"), icon, onClick: k.onManage }] : [];
  return [
    { sep: true },
    { heading: t("knowledgeMenu") },
    ...k.collections.map((c): MenuEntry => ({
      label: c.name,
      description: c.status.chunks > 0 ? undefined : t("knowledgeMenuNotIndexed"),
      icon,
      checked: k.selected.includes(c.id),
      onClick: () => k.toggle(c.id),
    })),
  ];
}
