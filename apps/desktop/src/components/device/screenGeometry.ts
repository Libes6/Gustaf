// Pure helpers for the live view: pointer position -> device point (through the letterboxing), and what a mouse
// gesture means (tap, long press or swipe). No React, no DOM.

import { fitScreen, viewToDevice, type Rect, type Size } from "../../device/uiMap";
import type { Point } from "../../device/types";

export const TAP_SLOP_PX = 6;
export const LONG_PRESS_MS = 450;

/** A point of the box the screen is drawn in to a device point; null in the letterbox bars. */
export function boxToDevice(device: Size, box: Size, p: Point): Point | null {
  return viewToDevice(device, fitScreen(device, box), p);
}

/** Like boxToDevice but a point outside the screen snaps to its nearest edge (used for the end of a drag). */
export function boxToDeviceClamped(device: Size, box: Size, p: Point): Point | null {
  const shown = fitScreen(device, box);
  if (shown.width <= 0) return null;
  const x = Math.min(shown.x + shown.width - 1e-6, Math.max(shown.x, p.x));
  const y = Math.min(shown.y + shown.height - 1e-6, Math.max(shown.y, p.y));
  return viewToDevice(device, shown, { x, y });
}

export type Gesture =
  | { kind: "tap"; at: Point }
  | { kind: "longPress"; at: Point; ms: number }
  | { kind: "swipe"; from: Point; to: Point; ms: number };

/**
 * Mouse down + up to a gesture. `viewDown`/`viewUp` are in box pixels (the slop is in pixels, so it feels the same on
 * every zoom); `from`/`to` are the matching device points.
 */
export function classifyGesture(
  g: { viewDown: Point; viewUp: Point; from: Point; to: Point; durationMs: number },
  o: { slop?: number; longPressMs?: number } = {},
): Gesture {
  const moved = Math.hypot(g.viewUp.x - g.viewDown.x, g.viewUp.y - g.viewDown.y);
  const ms = Math.max(1, Math.round(g.durationMs));
  if (moved > (o.slop ?? TAP_SLOP_PX)) return { kind: "swipe", from: g.from, to: g.to, ms };
  if (g.durationMs >= (o.longPressMs ?? LONG_PRESS_MS)) return { kind: "longPress", at: g.from, ms };
  return { kind: "tap", at: g.from };
}

/** The rectangle of a label chip: above the outline when there is room, else inside its top edge; kept in the box. */
export function chipPosition(outline: Rect, box: Size, chip: Size): Point {
  const above = outline.y - chip.height - 2;
  const y = above >= 0 ? above : Math.min(outline.y + 2, Math.max(0, box.height - chip.height));
  const x = Math.max(0, Math.min(outline.x, box.width - chip.width));
  return { x, y };
}
