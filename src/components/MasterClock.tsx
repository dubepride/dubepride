"use client";

import { useEffect, useState } from "react";
import { formatClockTime, formatLongDate } from "@/lib/format";

/**
 * The Master Clock — centred at the top of the dashboard.
 *
 * Renders a neutral "--:--:--" placeholder on the server, then starts
 * ticking client-side (one interval, seconds resolution) which keeps the
 * first paint hydration-safe.
 */
export default function MasterClock() {
  // Timezone is display-only (hidden until the first client tick) and is
  // identical for the server's first paint, so a lazy initialiser is safe.
  const [tz] = useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local"
  );
  const [now, setNow] = useState<Date | null>(null);

  // Ticking is a subscription to a timer (an external system): the very
  // first tick is deferred so the effect body itself stays side-effect
  // free for the react-hooks/set-state-in-effect rule.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) setNow(new Date());
    };
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  const time = now ? formatClockTime(now) : "--:--:--";
  const [hhmm, ss] = now ? [time.slice(0, 5), time.slice(6)] : ["--:--", "--"];

  return (
    <section className="glass relative overflow-hidden px-6 py-8 text-center sm:py-10">
      <div className="accent-line" aria-hidden="true" />

      <div className="flex items-center justify-center gap-2 text-[10px] font-bold tracking-[0.38em] text-muted uppercase">
        <span className="status-dot status-dot--on" />
        Master Clock · Live
      </div>

      {/* The glow is the visual anchor of the whole dashboard. */}
      <div className="mt-5 flex items-start justify-center font-mono font-bold tracking-tight tabular-nums select-none">
        <span className="neon-text text-[clamp(3.25rem,11vw,7rem)] leading-none">
          {hhmm}
        </span>
        <span className="blink neon-text mx-1 text-[clamp(2.5rem,8vw,5.5rem)] leading-none">
          :
        </span>
        <span className="neon-text text-[clamp(2.25rem,7vw,4.5rem)] leading-[1.35] opacity-80">
          {ss}
        </span>
      </div>

      <p className="mt-5 text-xs font-medium tracking-[0.28em] text-muted uppercase sm:text-sm">
        {now ? formatLongDate(now) : "Synchronising…"}
        {now && tz ? <span className="hidden sm:inline"> · {tz}</span> : null}
      </p>

      <p className="mt-2 font-mono text-[11px] tracking-[0.18em] text-muted/70">
        BRIDGE NODE-01 · SOURCE OF TRUTH FOR ALL PUNCH EVENTS
      </p>
    </section>
  );
}
