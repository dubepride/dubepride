import type { ReactNode } from "react";

interface MetricCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon: ReactNode;
  tone?: "ink" | "neon" | "danger" | "warn";
  loading?: boolean;
}

const TONE: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  ink: "text-ink",
  neon: "text-neon",
  danger: "text-danger",
  warn: "text-warn",
};

const GLOW: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  ink: "via-white/25",
  neon: "via-neon/60",
  danger: "via-danger/60",
  warn: "via-warn/60",
};

const ICON_BG: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  ink: "border-white/10 bg-white/[0.04] text-muted",
  neon: "border-neon/30 bg-neon/10 text-neon",
  danger: "border-danger/30 bg-danger/10 text-danger",
  warn: "border-warn/30 bg-warn/10 text-warn",
};

/** Top-level dashboard statistic tile. */
export default function MetricCard({
  label,
  value,
  sub,
  icon,
  tone = "ink",
  loading = false,
}: MetricCardProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-panel-deep/50 p-5 shadow-lg backdrop-blur-xl transition-all duration-200 hover:border-white/20 hover:bg-panel-deep/70">
      <div
        className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent ${GLOW[tone]} to-transparent`}
        aria-hidden="true"
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-bold tracking-[0.2em] text-muted uppercase">
          {label}
        </p>
        <span className={`grid h-8 w-8 place-items-center rounded-xl border ${ICON_BG[tone]}`}>
          {icon}
        </span>
      </div>
      <p
        className={`mt-2.5 text-3xl sm:text-4xl font-extrabold tabular-nums tracking-tight ${TONE[tone]}`}
        aria-label={typeof value === "string" ? value : undefined}
      >
        {loading ? "––" : value}
      </p>
      {sub ? <p className="mt-1 text-xs text-muted/80">{sub}</p> : null}
    </div>
  );
}
