// Pure parts of the dialog focus handling (no DOM imports, so node tests can cover them). The hook is in useDialogFocus.ts.

/** Elements a dialog's Tab order may contain. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tab trap: which item to focus instead of the browser default, or null when the default is fine.
 * `current` is the index of the focused item (-1 when focus is outside the list or on the dialog itself).
 */
export function trapTarget(count: number, current: number, shift: boolean): number | null {
  if (count <= 0) return -1; // nothing focusable: keep focus on the dialog
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}

/** Index to move to for ArrowDown/ArrowUp/Home/End in a roving list (menus); wraps around. Null for other keys. */
export function rovingTarget(key: string, count: number, current: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
