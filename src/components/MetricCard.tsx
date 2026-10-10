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
    <div className="glass relative overflow-hidden p-5">
      <div
        className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent ${GLOW[tone]} to-transparent`}
        aria-hidden="true"
      />
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-semibold tracking-[0.2em] text-muted uppercase">
          {label}
        </p>
        <span className={tone === "neon" ? "text-neon/80" : "text-muted/70"}>
          {icon}
        </span>
      </div>
      <p
        className={`mt-3 text-4xl font-bold tabular-nums ${TONE[tone]}`}
        aria-label={typeof value === "string" ? value : undefined}
      >
        {loading ? "––" : value}
      </p>
      {sub ? <p className="mt-1 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}
