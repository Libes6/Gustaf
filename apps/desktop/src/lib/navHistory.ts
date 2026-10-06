// Back / forward between chats (⌘[ / ⌘], T13). Pure: a bounded history of opened chats and a cursor (tests/navHistory.test.mjs).

export type NavEntry = { chatId: number; projectId: number | null };
export type Nav = { items: NavEntry[]; index: number };
export const NAV_LIMIT = 50;
export const emptyNav: Nav = { items: [], index: -1 };

/** A chat was opened by the user (not by back/forward): forward entries are dropped, repeats collapse. */
export function visit(nav: Nav, e: NavEntry): Nav {
  if (nav.items[nav.index]?.chatId === e.chatId) return nav;
  const items = [...nav.items.slice(0, nav.index + 1), e].slice(-NAV_LIMIT);
  return { items, index: items.length - 1 };
}

/** Moves the cursor; `exists` skips chats that were deleted or archived. Returns null when there is nowhere to go. */
export function move(nav: Nav, step: -1 | 1, exists: (chatId: number) => boolean): { nav: Nav; entry: NavEntry } | null {
  for (let i = nav.index + step; i >= 0 && i < nav.items.length; i += step) {
    if (exists(nav.items[i].chatId)) return { nav: { ...nav, index: i }, entry: nav.items[i] };
  }
  return null;
}
