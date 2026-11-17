import type { ScopedThreadRef } from "@t3tools/contracts";

import { whenPreviewTabKnown } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

/** A page's popup opens as a tab in the right panel, wherever the page that opened it is. */
export function showPreviewPopup(threadRef: ScopedThreadRef, popupTabId: string): void {
  whenPreviewTabKnown(threadRef, popupTabId, () => {
    useRightPanelStore.getState().openBrowser(threadRef, popupTabId);
  });
}
