import { useSyncExternalStore } from "react";

// Native tabs sit above the whole page, so they hide while any of these is open. Tooltips and
// toasts are left out: hiding the page for each would flicker, and they are short-lived.
const COVERING_POPUPS = [
  "alert-dialog-popup",
  "autocomplete-popup",
  "combobox-popup",
  "command-dialog-popup",
  "dialog-popup",
  "menu-popup",
  "popover-popup",
  "preview-card-popup",
  "select-popup",
  "sheet-popup",
]
  .map((slot) => `[data-slot="${slot}"][data-open]`)
  .join(",");
const PORTAL = "[data-base-ui-portal]";

let covered = false;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function update(): void {
  const next = document.querySelector(COVERING_POPUPS) !== null;
  if (next === covered) return;
  covered = next;
  for (const listener of listeners) listener();
}

function observePortal(node: Node): void {
  if (!(node instanceof Element) || !node.matches(PORTAL)) return;
  observer?.observe(node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-open"],
  });
}

// Popups mount into portal elements on the body, so only those subtrees are watched, never the
// app root, which a streaming chat mutates on every frame.
function start(): void {
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target === document.body) record.addedNodes.forEach(observePortal);
    }
    update();
  });
  observer.observe(document.body, { childList: true });
  document.body.childNodes.forEach(observePortal);
  update();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    observer?.disconnect();
    observer = null;
    covered = false;
  };
}

export function usePageCoversNativeBrowser(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => covered,
    () => false,
  );
}
