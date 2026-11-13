import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationPlatform,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { FolderPlusIcon } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";

import { useOpenLocalWorkspace } from "../../hooks/useOpenLocalWorkspace";
import { randomUUID } from "../../lib/utils";
import { useT } from "../../useUiLanguage";
import { matchDroppedFolderPath, resolveDroppedFolderPath } from "../chat/folderDrop";
import { splitTransferredFiles } from "../chat/workspaceFileDrop";
import { setFileDragActive } from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";

const isActivationPlatform = Schema.is(DesktopAppActivationPlatform);

function isFileDrag(event: DragEvent) {
  return event.dataTransfer.types.includes("Files");
}

/**
 * Folders dropped from the OS file manager open as projects, like `t3 <dir>`.
 * Thread rows take file drops for themselves by calling preventDefault first;
 * this zone then stays hidden and only picks up folders from the drop.
 * Browsers expose no absolute paths, so only the desktop app can add them.
 */
export function SidebarFolderDrop(props: { children: ReactNode }) {
  const t = useT();
  const [isActive, setIsActive] = useState(false);
  const openLocalWorkspace = useOpenLocalWorkspace();
  const bridge = window.desktopBridge;
  const setActive = (active: boolean) => setFileDragActive(setIsActive, active);

  const addFolders = async (folders: File[]) => {
    if (bridge === undefined) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: t("sidebar.SidebarFolderDrop.needsDesktopApp"),
          description: t("sidebar.SidebarFolderDrop.needsDesktopAppDescription"),
        }),
      );
      return;
    }
    const platform = bridge.getClientPlatform();
    if (!openLocalWorkspace.ready || !isActivationPlatform(platform)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("sidebar.SidebarFolderDrop.notConnected"),
          description: t("sidebar.SidebarFolderDrop.notConnectedDescription"),
        }),
      );
      return;
    }
    // The Gustaf shell's web view hides a File's path; it reports what the drag carried instead.
    const shellPaths =
      window.gustafShell === undefined
        ? []
        : await window.gustafShell.droppedPaths().catch(() => []);
    // One at a time, so the last folder is the one left open.
    for (const folder of folders) {
      const workspaceRoot =
        resolveDroppedFolderPath(folder, bridge.getPathForFile) ??
        matchDroppedFolderPath(folder, shellPaths);
      const response =
        workspaceRoot === null
          ? null
          : await openLocalWorkspace.open({
              version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
              requestId: randomUUID(),
              type: "open-workspace",
              workspaceRoot,
              platform,
            });
      if (response?.ok) continue;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("sidebar.SidebarFolderDrop.couldNotAdd").replace("{name}", folder.name),
          description: response?.message ?? t("sidebar.SidebarFolderDrop.couldNotReadPath"),
        }),
      );
    }
  };

  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    if (event.defaultPrevented) {
      setActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setActive(true);
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!isFileDrag(event)) return;
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setActive(false);
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) return;
        const claimedByRow = event.defaultPrevented;
        event.preventDefault();
        setActive(false);
        const { files, folders } = splitTransferredFiles(event.dataTransfer);
        if (folders.length > 0) void addFolders(folders);
        if (files.length > 0 && !claimedByRow) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: t("sidebar.SidebarFolderDrop.onlyFolders"),
              description: t("sidebar.SidebarFolderDrop.onlyFoldersDescription"),
            }),
          );
        }
      }}
    >
      {props.children}
      {isActive ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-1.5 z-30 flex flex-col items-center justify-center gap-2 rounded-lg px-4 text-center bg-sidebar/90 text-sm text-sidebar-foreground ring-1 ring-inset ring-primary/70"
        >
          <FolderPlusIcon className="size-5 text-sidebar-muted-foreground" />
          {bridge === undefined
            ? t("sidebar.SidebarFolderDrop.needsDesktopApp")
            : t("sidebar.SidebarFolderDrop.dropToAdd")}
        </div>
      ) : null}
    </div>
  );
}
