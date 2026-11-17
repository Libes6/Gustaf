export function createWallpaperWatchdog(onStall: () => void) {
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    active = false;
    clearTimeout(timer);
  };
  const frame = () => {
    if (!active) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      stop();
      onStall();
    }, 1000);
  };
  return {
    start: () => {
      if (active) return;
      active = true;
      frame();
    },
    frame,
    stop,
  };
}
