import { useEffect, useRef, type RefObject } from "react";
import { FOCUSABLE, trapTarget } from "./dialogFocus";

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

/**
 * Focus handling shared by modal dialogs: moves focus into the dialog when it opens (the `[data-autofocus]` / `autofocus`
 * element, else the first focusable one, else the dialog itself), keeps Tab and Shift+Tab inside it, calls `onEscape` on
 * Escape, and returns focus to the element that had it before the dialog opened. The container needs `role="dialog"`.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onEscape?: () => void, active = true) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const root = active ? ref.current : null;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
    if (!root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? items()[0];
      if (first) first.focus();
      else {
        if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
        root.focus();
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escape.current && !e.defaultPrevented) {
        e.stopPropagation();
        escape.current();
      } else if (e.key === "Tab") {
        const list = items();
        const target = trapTarget(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (target === null) return;
        e.preventDefault();
        (list[target] ?? root).focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (previous?.isConnected && (document.activeElement === document.body || root.contains(document.activeElement)))
        previous.focus?.();
    };
  }, [ref, active]);
}
