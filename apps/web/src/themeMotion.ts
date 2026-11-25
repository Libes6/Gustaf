// Theme CSS is user-supplied and can animate forever: a theme that moves registered custom
// properties inside large gradients restyles and repaints the whole window every frame. The
// theme's animations therefore run only while someone can be watching them and using the app.

const MOTION_STATE_PROPERTY = "--theme-motion-state";
const IDLE_PAUSE_MS = 30_000;

export function themeMotionPaused(input: {
  readonly visible: boolean;
  readonly focused: boolean;
  readonly idleMs: number;
}): boolean {
  return !input.visible || !input.focused || input.idleMs >= IDLE_PAUSE_MS;
}

type RuleWithChildren = CSSRule & { readonly cssRules: CSSRuleList };

const hasChildRules = (rule: CSSRule): rule is RuleWithChildren =>
  "cssRules" in rule && !(rule instanceof CSSKeyframesRule);

/**
 * Lets the guard pause a theme's animations without touching the app's own: every theme rule that
 * starts an animation reads its play state from one custom property, falling back to the theme's own.
 */
export function makeThemeAnimationsPausable(parent: Pick<CSSStyleSheet, "cssRules">): void {
  for (const rule of parent.cssRules) {
    if (hasChildRules(rule)) makeThemeAnimationsPausable(rule);
    if (!(rule instanceof CSSStyleRule)) continue;
    const { style } = rule;
    const animation =
      style.getPropertyValue("animation") || style.getPropertyValue("animation-name");
    if (animation === "" || animation === "none") continue;
    const own = style.getPropertyValue("animation-play-state") || "running";
    style.setProperty("animation-play-state", `var(${MOTION_STATE_PROPERTY}, ${own})`, "important");
  }
}

/** Keeps `--theme-motion-state` on the root in step with focus, visibility, and recent input. */
export function watchThemeMotion(): () => void {
  const root = document.documentElement;
  let lastInputAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const update = () => {
    const idleMs = performance.now() - lastInputAt;
    const paused = themeMotionPaused({
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
      idleMs,
    });
    if (paused) root.style.setProperty(MOTION_STATE_PROPERTY, "paused");
    else root.style.removeProperty(MOTION_STATE_PROPERTY);
    clearTimeout(timer);
    if (!paused) timer = setTimeout(update, IDLE_PAUSE_MS - idleMs);
  };
  const onInput = () => {
    const wasIdle = root.style.getPropertyValue(MOTION_STATE_PROPERTY) !== "";
    lastInputAt = performance.now();
    if (wasIdle) update();
  };

  const inputEvents = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
  for (const name of inputEvents) {
    window.addEventListener(name, onInput, { capture: true, passive: true });
  }
  window.addEventListener("focus", onInput);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  update();

  return () => {
    clearTimeout(timer);
    for (const name of inputEvents) window.removeEventListener(name, onInput, { capture: true });
    window.removeEventListener("focus", onInput);
    window.removeEventListener("blur", update);
    document.removeEventListener("visibilitychange", update);
    root.style.removeProperty(MOTION_STATE_PROPERTY);
  };
}
