/** What the app around the computer-use executor does: dialog, switch, indicator, shortcut. */
import type { ComputerUseOwner } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import { msg } from "gt-i18n";

import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { m } from "../i18n/messages.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

/** Shown to people; `EMERGENCY_ACCELERATOR` is what Electron registers. */
export const EMERGENCY_SHORTCUT = "⌃⌥⌘⎋";
// Not taken by macOS; Escape because it means "stop".
const EMERGENCY_ACCELERATOR = "Control+Alt+Command+Escape";

export class ComputerUseHostError extends Schema.TaggedError<ComputerUseHostError>()(
  "ComputerUseHostError",
  {
    reason: Schema.Literals(["shortcut-unavailable", "indicator-failed", "settings-write-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "shortcut-unavailable":
        return `${EMERGENCY_SHORTCUT} is taken by another app.`;
      case "indicator-failed":
        return "The menu-bar indicator could not be shown.";
      case "settings-write-failed":
        return "The setting could not be saved.";
    }
  }
}

export type ComputerUseLocalStop = "stopped-by-user" | "emergency-shortcut";

export class ComputerUseHost extends Context.Service<
  ComputerUseHost,
  {
    readonly readEnabled: Effect.Effect<boolean>;
    /** Native and local: a page or a remote client cannot answer it. */
    readonly confirmEnable: Effect.Effect<boolean>;
    readonly saveEnabled: (enabled: boolean) => Effect.Effect<void, ComputerUseHostError>;
    /**
     * Shows the indicator and registers the emergency shortcut; either failing refuses the
     * session. `stop` is how the person at the Mac ends it.
     */
    readonly sessionStarted: (
      owner: ComputerUseOwner,
      stop: (reason: ComputerUseLocalStop) => void,
    ) => Effect.Effect<void, ComputerUseHostError>;
    readonly sessionEnded: Effect.Effect<void>;
    /** Completes when the app starts quitting. */
    readonly quitRequested: Effect.Effect<void>;
  }
>()("@t3tools/desktop/computerUse/ComputerUseHost") {}

const make = Effect.gen(function* () {
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  let tray: Electron.Tray | undefined;

  const removeIndicator = Effect.sync(() => {
    Electron.globalShortcut.unregister(EMERGENCY_ACCELERATOR);
    tray?.destroy();
    tray = undefined;
  });

  const showIndicator = (owner: ComputerUseOwner, stop: (reason: ComputerUseLocalStop) => void) =>
    Effect.try({
      try: () => {
        const indicator = m(msg("Agent controls Mac"));
        // A text-only menu-bar item: macOS draws the title, so no icon asset is needed.
        const next = new Electron.Tray(Electron.nativeImage.createEmpty());
        tray = next;
        next.setTitle(indicator);
        next.setToolTip(indicator);
        next.setContextMenu(
          Electron.Menu.buildFromTemplate([
            {
              label: m(msg("Controlled by: {owner}"), { owner: owner.label }),
              enabled: false,
            },
            { type: "separator" },
            {
              label: m(msg("Stop control ({shortcut})"), { shortcut: EMERGENCY_SHORTCUT }),
              click: () => stop("stopped-by-user"),
            },
          ]),
        );
      },
      catch: (cause) => new ComputerUseHostError({ reason: "indicator-failed", cause }),
    });

  return ComputerUseHost.of({
    readEnabled: settings.get.pipe(Effect.map((current) => current.computerUseEnabled)),
    confirmEnable: Effect.gen(function* () {
      // Asked from another device, so the window may be in the background.
      yield* Effect.sync(() => Electron.app.focus({ steal: true }));
      const { response } = yield* dialog.showMessageBox({
        type: "warning",
        message: m(msg("Allow agents to control this Mac?")),
        detail: m(
          msg(
            "The agent in the thread you allow will see this Mac's screen and use its mouse and keyboard. You are asked once; later threads are allowed from the app. While an agent is in control, the menu bar says so. To stop: Stop in the thread, Stop control in the menu bar, or {shortcut}.",
          ),
          { shortcut: EMERGENCY_SHORTCUT },
        ),
        buttons: [
          m(msg("Allow", { $context: "button, lets agents control this Mac" })),
          m(msg("Don't Allow")),
        ],
        // Return and Escape both refuse: only a deliberate click allows.
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    }).pipe(
      Effect.orElseSucceed(() => false),
      Effect.withSpan("ComputerUseHost.confirmEnable"),
    ),
    saveEnabled: Effect.fn("ComputerUseHost.saveEnabled")(function* (enabled) {
      yield* settings
        .setComputerUseEnabled(enabled)
        .pipe(
          Effect.mapError(
            (cause) => new ComputerUseHostError({ reason: "settings-write-failed", cause }),
          ),
        );
    }),
    sessionStarted: Effect.fn("ComputerUseHost.sessionStarted")(function* (owner, stop) {
      const registered = yield* Effect.sync(() => {
        try {
          return Electron.globalShortcut.register(EMERGENCY_ACCELERATOR, () =>
            stop("emergency-shortcut"),
          );
        } catch {
          return false;
        }
      });
      if (!registered) return yield* new ComputerUseHostError({ reason: "shortcut-unavailable" });
      yield* showIndicator(owner, stop).pipe(Effect.tapError(() => removeIndicator));
    }),
    sessionEnded: removeIndicator,
    quitRequested: shutdown.awaitRequest,
  });
});

export const layerElectron = Layer.effect(ComputerUseHost, make);
