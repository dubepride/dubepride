"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatClockTime, formatLongDate } from "@/lib/format";

/**
 * Command Center Master Clock & Sweeping Chronometer.
 *
 * Ticks client-side with an animated circular 60-second chronometer ring,
 * second needle sweep, digital time readout, and quick launch shortcuts.
 */
export default function MasterClock() {
  const [tz] = useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local"
  );
  const [now, setNow] = useState<Date | null>(null);

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
  const secNum = now ? now.getSeconds() : 0;
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const progress = (secNum / 60) * circumference;
  const offset = circumference - progress;
  const secondAngle = (secNum / 60) * 360;

  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-panel-deep/50 p-6 sm:p-7 shadow-2xl backdrop-blur-2xl">
      {/* Subtle top neon accent line */}
      <div className="accent-line" aria-hidden="true" />

      {/* Ambient background glow */}
      <div
        className="pointer-events-none absolute -top-20 -left-20 h-64 w-64 rounded-full bg-neon/10 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-20 -right-20 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl"
        aria-hidden="true"
      />

      <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        {/* Left: Sweeping SVG Chronometer + Digital Time Display */}
        <div className="flex items-center gap-5 sm:gap-6">
          {/* Sweeping SVG Chronometer Dial */}
          <div className="relative h-20 w-20 flex-none grid place-items-center">
            <svg className="h-20 w-20" viewBox="0 0 100 100">
              {/* Background track ring */}
              <circle
                cx="50"
                cy="50"
                r={radius}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth="2.5"
                fill="none"
              />
              {/* 12 dial ticks */}
              {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => {
                const isMajor = deg % 90 === 0;
                const r1 = isMajor ? 32 : 34;
                const r2 = 37;
                const rad = (deg - 90) * (Math.PI / 180);
                const x1 = 50 + r1 * Math.cos(rad);
                const y1 = 50 + r1 * Math.sin(rad);
                const x2 = 50 + r2 * Math.cos(rad);
                const y2 = 50 + r2 * Math.sin(rad);
                return (
                  <line
                    key={deg}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={isMajor ? "#00e676" : "rgba(255,255,255,0.2)"}
                    strokeWidth={isMajor ? "1.5" : "1"}
                    strokeLinecap="round"
                  />
                );
              })}
              {/* Sweeping Seconds Arc */}
              <circle
                cx="50"
                cy="50"
                r={radius}
                stroke="#00e676"
                strokeWidth="2.5"
                fill="none"
                strokeDasharray={circumference}
                strokeDashoffset={now ? offset : circumference}
                strokeLinecap="round"
                className="origin-center -rotate-90 transition-all duration-700 ease-out"
              />
              {/* Sweeping Second Hand Needle */}
              <line
                x1="50"
                y1="50"
                x2="50"
                y2="18"
                stroke="#00e676"
                strokeWidth="1.5"
                strokeLinecap="round"
                style={{
                  transform: `rotate(${secondAngle}deg)`,
                  transformOrigin: "50px 50px",
                  transition: "transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              />
              {/* Center Hub */}
              <circle cx="50" cy="50" r="3.5" fill="#00e676" />
              <circle cx="50" cy="50" r="1.5" fill="#0a0a0c" />
            </svg>
          </div>

          {/* Large Digital Clock Readout */}
          <div>
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight text-ink tabular-nums">
                {hhmm}
                <span className="text-neon">:{ss}</span>
              </span>
              <span className="rounded-lg border border-neon/30 bg-neon/10 px-2 py-0.5 text-xs font-bold text-neon uppercase tracking-wider">
                SAST
              </span>
            </div>

            <p className="mt-1 text-xs sm:text-sm font-medium tracking-wide text-muted">
              {now ? formatLongDate(now) : "Synchronising…"}
              {now && tz ? <span className="hidden sm:inline"> · {tz}</span> : null}
            </p>
          </div>
        </div>

        {/* Right: Quick Launch & Precision Telemetry */}
        <div className="flex flex-wrap items-center gap-3 lg:flex-col lg:items-end">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            NTP Master Synced · Precision Clock
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/tablet"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-bold text-ink transition hover:border-neon/40 hover:bg-neon/10 hover:text-neon"
            >
              <span>📱</span>
              <span>Tablet Kiosk</span>
            </Link>

            <Link
              href="/field-tracker"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-bold text-ink transition hover:border-emerald-400/40 hover:bg-emerald-400/10 hover:text-emerald-400"
            >
              <span>📍</span>
              <span>Field Tracker</span>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
