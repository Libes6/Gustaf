// The Device tab: set up the toolchain, pick or start a simulator/emulator, then watch and drive it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { DeviceDriver, DeviceInfo, PressKey } from "../../device/types";
import type { UiNode } from "../../device/uiMap";
import { rematchNode } from "./mapRows";
import { DeviceDetails } from "./DeviceDetails";
import { DeviceMap } from "./DeviceMap";
import { DeviceScreen, type ScreenMode } from "./DeviceScreen";
import { useDeviceDriver } from "./driverContext";
import type { Gesture } from "./screenGeometry";
import { useDevice, type UseDeviceOptions } from "./useDevice";
import "./DevicePanel.css";

export type DevicePanelProps = {
  /** Overrides the driver from `DeviceDriverContext` / `getDeviceDriver()` (tests). */
  driver?: DeviceDriver | null;
  /** The tab is selected. Polling pauses while false. */
  visible?: boolean;
  /** An agent is driving this device: the user's taps are off until they press Stop. */
  agentActive?: boolean;
  agentLabel?: string;
  onStopAgent?: () => void;
  intervals?: UseDeviceOptions["intervals"];
};

export function DevicePanel(props: DevicePanelProps) {
  const contextDriver = useDeviceDriver();
  const driver = props.driver === undefined ? contextDriver : props.driver;
  const t = useT();
  if (!driver) {
    return (
      <section className="dev-panel" aria-label={t("deviceTab")}>
        <div className="dev-state" role="status">
          <h3>{t("deviceNoDriverTitle")}</h3>
          <p className="dev-dim">{t("deviceNoDriverBody")}</p>
        </div>
      </section>
    );
  }
  return <DeviceWorkspace {...props} driver={driver} />;
}

function DeviceWorkspace({
  driver,
  visible = true,
  agentActive = false,
  agentLabel,
  onStopAgent,
  intervals,
}: DevicePanelProps & { driver: DeviceDriver }) {
  const t = useT();
  const dev = useDevice(driver, { visible, intervals });
  const [mode, setMode] = useState<ScreenMode>("interact");
  const [mapOpen, setMapOpen] = useState(true);
  const [pin, setPin] = useState<{ device: string; node: UiNode } | null>(null);
  const [hover, setHover] = useState<UiNode | null>(null);
  const [hint, setHint] = useState("");
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { map, selectedId } = dev;

  // A pinned element survives a map refresh when it can be recognised in the new map; it never leaks to another device.
  const pinned = useMemo(() => {
    if (!pin || !map || pin.device !== selectedId) return null;
    return map.nodes[pin.node.index] === pin.node ? pin.node : rematchNode(map, pin.node);
  }, [pin, map, selectedId]);
  const highlight = hover && map?.nodes[hover.index] === hover ? hover : null;
  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const showHint = useCallback((text: string) => {
    setHint(text);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(""), 4000);
  }, []);
  const blocked = useCallback(() => showHint(t("deviceAgentBlocked")), [showHint, t]);

  const busy = dev.queue.length ? dev.queue[0] + (dev.queue.length > 1 ? ` (+${dev.queue.length - 1})` : "") : null;
  const locked = agentActive;

  const onGesture = (g: Gesture) => {
    dev.noteActivity();
    if (g.kind === "tap") void dev.run(t("deviceActTap"), (d, id) => d.tap(id, g.at));
    else if (g.kind === "longPress") void dev.run(t("deviceActLongPress"), (d, id) => d.longPress(id, g.at, g.ms));
    else void dev.run(t("deviceActSwipe"), (d, id) => d.swipe(id, g.from, g.to, g.ms));
  };
  const tapNode = (node: UiNode) => {
    if (locked) return blocked();
    void dev.run(t("deviceActTap"), (d, id) => d.tap(id, { ref: node.ref }));
  };
  const press = (key: PressKey, label: string) => {
    if (locked) return blocked();
    void dev.run(label, (d, id) => d.press(id, key));
  };
  const selectNode = (node: UiNode | null) => setPin(node && selectedId ? { device: selectedId, node } : null);

  return (
    <section className="dev-panel" aria-label={t("deviceTab")}>
      {agentActive && (
        <div className="dev-agent" role="status">
          <span>
            {agentLabel ? t("deviceAgentControllingNamed", { name: agentLabel }) : t("deviceAgentControlling")}
          </span>
          <button className="dev-btn" onClick={onStopAgent} disabled={!onStopAgent}>
            {t("deviceAgentStop")}
          </button>
        </div>
      )}
      {hint && (
        <div className="dev-note" role="status">
          {hint}
        </div>
      )}
      {dev.toolchain && (
        <HelperBanner toolchain={dev.toolchain} install={dev.install} onInstall={() => void dev.installHelper()} />
      )}
      {dev.error && (
        <div className="dev-error" role="alert">
          <span>
            {dev.error.message}
            {dev.error.code === "helper-missing" && ` ${t("deviceErrHelperMissing")}`}
            {dev.error.code === "stale-ref" && ` ${t("deviceErrStale")}`}
          </span>
          <button className="dev-btn" onClick={dev.clearError} aria-label={t("deviceDismiss")}>
            ×
          </button>
        </div>
      )}
      {!dev.toolchain || !dev.devices ? (
        <div className="dev-state dev-dim" role="status">
          {t("deviceLoading")}
        </div>
      ) : !dev.toolchain.ios.available && !dev.toolchain.android.available ? (
        <Setup toolchain={dev.toolchain} onRetry={() => void dev.refresh()} loading={dev.loading} />
      ) : dev.selected && dev.booted ? (
        <div className="dev-live">
          <div className="dev-toolbar">
            <button className="dev-btn" onClick={() => dev.select(null)}>
              ← {t("deviceDevices")}
            </button>
            <span className="dev-name" title={dev.selected.os}>
              {dev.selected.name}
              {dev.selected.os && <span className="dev-dim"> {dev.selected.os}</span>}
            </span>
            <div className="dev-seg" role="group" aria-label={t("deviceMode")}>
              <button aria-pressed={mode === "interact"} onClick={() => setMode("interact")}>
                {t("deviceModeInteract")}
              </button>
              <button aria-pressed={mode === "inspect"} onClick={() => setMode("inspect")}>
                {t("deviceModeInspect")}
              </button>
            </div>
            <div className="dev-keys" role="group" aria-label={t("deviceButtons")}>
              <button className="dev-btn" disabled={locked} onClick={() => press("home", t("deviceKeyHome"))}>
                {t("deviceKeyHome")}
              </button>
              {dev.selected.platform === "android" && (
                <button className="dev-btn" disabled={locked} onClick={() => press("back", t("deviceKeyBack"))}>
                  {t("deviceKeyBack")}
                </button>
              )}
              <button
                className="dev-btn"
                disabled={locked}
                onClick={() => press("app-switcher", t("deviceKeySwitcher"))}
              >
                {t("deviceKeySwitcher")}
              </button>
            </div>
            <button
              className="dev-btn"
              aria-expanded={mapOpen}
              aria-controls="dev-map-pane"
              onClick={() => setMapOpen((o) => !o)}
            >
              {mapOpen ? t("deviceHideMap") : t("deviceShowMap")}
            </button>
            <button
              className="dev-btn danger"
              disabled={!!dev.powering[dev.selected.id]}
              onClick={() => void dev.shutdown(dev.selected!.id)}
            >
              {t("devicePowerOff")}
            </button>
          </div>
          <div className="dev-main">
            <div className="dev-stage">
              <DeviceScreen
                frame={dev.frame}
                map={map}
                mode={mode}
                locked={locked}
                busy={busy}
                highlight={highlight}
                pinned={pinned}
                onGesture={onGesture}
                onText={(text) => {
                  dev.noteActivity();
                  void dev.run(t("deviceActType"), (d, id) => d.type(id, text));
                }}
                onEnter={() => void dev.run(t("deviceActType"), (d, id) => d.press(id, "enter"))}
                onPin={selectNode}
                onActivity={dev.noteActivity}
                onBlocked={blocked}
              />
              <p className="dev-dim dev-hint">
                {mode === "interact" ? t("deviceHintInteract") : t("deviceHintInspect")}
              </p>
              {pinned && map && (
                <DeviceDetails
                  map={map}
                  node={pinned}
                  tapDisabled={locked}
                  onTap={tapNode}
                  onClose={() => setPin(null)}
                />
              )}
            </div>
            {mapOpen && (
              <div id="dev-map-pane" className="dev-side">
                <DeviceMap
                  map={map}
                  loading={dev.mapLoading}
                  selected={pinned}
                  tapDisabled={locked}
                  onHover={setHover}
                  onSelect={selectNode}
                  onTap={tapNode}
                  onRefresh={() => void dev.refreshMap()}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <DeviceList
          devices={dev.devices}
          toolchain={dev.toolchain}
          powering={dev.powering}
          loading={dev.loading}
          onRefresh={() => void dev.refresh()}
          onOpen={(id) => dev.select(id)}
          onBoot={(id) => void dev.boot(id)}
          onShutdown={(id) => void dev.shutdown(id)}
        />
      )}
    </section>
  );
}

function HelperBanner({
  toolchain,
  install,
  onInstall,
}: {
  toolchain: NonNullable<ReturnType<typeof useDevice>["toolchain"]>;
  install: ReturnType<typeof useDevice>["install"];
  onInstall: () => void;
}) {
  const t = useT();
  const { installed, version, pinned } = toolchain.helper;
  const outdated = installed && !!version && version !== pinned;
  if (installed && !outdated && !install.lines.length && !install.error) return null;
  return (
    <div className="dev-helper">
      {(!installed || outdated) && (
        <>
          <p>{installed ? t("deviceHelperOutdated", { version: version ?? "?", pinned }) : t("deviceHelperMissing")}</p>
          <button className="dev-btn primary" disabled={install.running} onClick={onInstall}>
            {install.running
              ? t("deviceHelperInstalling")
              : installed
                ? t("deviceHelperUpdate", { pinned })
                : t("deviceHelperInstall", { pinned })}
          </button>
          <p className="dev-dim">{t("deviceHelperNote")}</p>
        </>
      )}
      {install.lines.length > 0 && (
        <pre className="dev-log" aria-label={t("deviceHelperLog")} aria-live="polite">
          {install.lines.join("\n")}
        </pre>
      )}
      {install.error && (
        <div className="dev-error" role="alert">
          {install.error}
        </div>
      )}
    </div>
  );
}

function Setup({
  toolchain,
  onRetry,
  loading,
}: {
  toolchain: NonNullable<ReturnType<typeof useDevice>["toolchain"]>;
  onRetry: () => void;
  loading: boolean;
}) {
  const t = useT();
  return (
    <div className="dev-state">
      <h3>{t("deviceSetupTitle")}</h3>
      <ul className="dev-reasons">
        <li>
          <strong>iOS</strong> — {toolchain.ios.reason ?? t("deviceUnavailable")}
        </li>
        <li>
          <strong>Android</strong> — {toolchain.android.reason ?? t("deviceUnavailable")}
        </li>
      </ul>
      <button className="dev-btn" onClick={onRetry} disabled={loading}>
        {t("deviceCheckAgain")}
      </button>
    </div>
  );
}

function DeviceList({
  devices,
  toolchain,
  powering,
  loading,
  onRefresh,
  onOpen,
  onBoot,
  onShutdown,
}: {
  devices: DeviceInfo[];
  toolchain: NonNullable<ReturnType<typeof useDevice>["toolchain"]>;
  powering: Record<string, "boot" | "shutdown">;
  loading: boolean;
  onRefresh: () => void;
  onOpen: (id: string) => void;
  onBoot: (id: string) => void;
  onShutdown: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="dev-list">
      <div className="dev-toolbar">
        <strong>{t("deviceDevices")}</strong>
        <button className="dev-btn" onClick={onRefresh} disabled={loading}>
          {t("deviceRefresh")}
        </button>
      </div>
      {(["ios", "android"] as const).map(
        (p) =>
          !toolchain[p].available && (
            <div key={p} className="dev-note">
              {p === "ios" ? "iOS" : "Android"}: {toolchain[p].reason ?? t("deviceUnavailable")}
            </div>
          ),
      )}
      {devices.length === 0 && <p className="dev-dim dev-pad">{t("deviceNoDevices")}</p>}
      <ul role="list">
        {devices.map((d) => {
          const p = powering[d.id];
          const starting = d.state === "booting" || p === "boot";
          return (
            <li key={d.id} className="dev-device">
              <div className="dev-device-info">
                <span className="dev-name">{d.name}</span>
                <span className="dev-dim">
                  {d.platform === "ios" ? "iOS" : "Android"}
                  {d.os ? ` · ${d.os}` : ""} ·{" "}
                  {starting
                    ? t("deviceStateStarting")
                    : d.state === "booted"
                      ? t("deviceStateOn")
                      : t("deviceStateOff")}
                </span>
              </div>
              <div className="dev-device-actions">
                {d.state === "booted" ? (
                  <>
                    <button
                      className="dev-btn primary"
                      onClick={() => onOpen(d.id)}
                      aria-label={t("deviceOpenNamed", { name: d.name })}
                    >
                      {t("deviceOpen")}
                    </button>
                    <button
                      className="dev-btn"
                      disabled={p === "shutdown"}
                      onClick={() => onShutdown(d.id)}
                      aria-label={t("devicePowerOffNamed", { name: d.name })}
                    >
                      {p === "shutdown" ? t("devicePoweringOff") : t("devicePowerOff")}
                    </button>
                  </>
                ) : (
                  <button
                    className="dev-btn primary"
                    disabled={starting}
                    onClick={() => onBoot(d.id)}
                    aria-label={t("deviceStartNamed", { name: d.name })}
                  >
                    {starting ? t("deviceStateStarting") : t("deviceStart")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
