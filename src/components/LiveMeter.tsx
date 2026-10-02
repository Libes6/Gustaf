import { useEffect, useReducer } from "react";
import { useT } from "../i18n";

export type LiveStats = { start: number; chars: number; input: number };

/** Live estimate of tokens spent by the running request; replaced by provider usage once the reply is stored. */
export function LiveMeter({ stats }: { stats: LiveStats }) {
  const t = useT();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.now() - stats.start) / 1000));
  return (
    <span className="live-meter" title={t("liveMeterHint")}>
      {t("liveMeter", { input: t.num(stats.input), output: t.num(Math.ceil(stats.chars / 3)), seconds })}
    </span>
  );
}
