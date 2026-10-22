/**
 * ============================================================================
 *  ui.tsx — the shared vocabulary of the console's screens
 * ============================================================================
 *
 *  Panels, tiles, badges and tables. Every screen composes from these so
 *  the console looks like one product rather than a dozen pages.
 * ============================================================================
 */

"use client";

import type { ReactNode } from "react";
import type { HealthState, Severity } from "@/lib/types";
import { humanise } from "./format";

/* ------------------------------------------------------------------ */
/* Page scaffolding                                                    */
/* ------------------------------------------------------------------ */

export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">{title}</h1>
          {badge}
        </div>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  tone,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Extra classes for the element that wraps the panel body.
   *
   * A panel that must host a full-bleed canvas (the live map) needs the
   * body to fill the panel exactly — otherwise the body collapses to the
   * height of its content and the canvas never gets a definite height.
   */
  bodyClassName?: string;
  tone?: "default" | "danger" | "warn" | "ok";
}) {
  const toneClass =
    tone === "danger"
      ? "border-red-500/40"
      : tone === "warn"
        ? "border-amber-400/40"
        : tone === "ok"
          ? "border-emerald-500/30"
          : "";

  return (
    <section className={`glass ${toneClass} ${className ?? ""}`.trim()}>
      <span className="accent-line" />
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 pb-2 sm:px-5">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-sm font-bold tracking-[0.14em] text-white uppercase">{title}</h2>
            ) : null}
            {subtitle ? <p className="mt-1 text-xs text-muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div
        className={
          (bodyClassName ?? "px-4 pt-1 pb-4 sm:px-5 sm:pb-5").trim()
        }
      >
        {children}
      </div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "danger" | "muted";
}) {
  const valueClass =
    tone === "ok"
      ? "text-neon"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "danger"
          ? "text-red-400"
          : tone === "muted"
            ? "text-muted"
            : "text-white";

  return (
    <div className="glass glass-inset px-4 py-3">
      <div className="text-[0.6rem] font-bold tracking-[0.18em] text-muted uppercase">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${valueClass}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[0.7rem] text-muted">{hint}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

const STATE_CHIP: Record<HealthState, string> = {
  ONLINE: "chip--neon",
  OFFLINE: "chip--danger",
  LINK_DOWN: "chip--danger",
  // Link is up but the internet beyond it is not: purple, never red. A red
  // badge here would claim the device itself had failed.
  NO_INTERNET: "chip--purple",
  DEGRADED: "chip--warn",
  STALE: "chip--warn",
  NO_TRAFFIC: "chip--warn",
  UNKNOWN: "chip--muted",
  UNMONITORED: "chip--muted",
};

/** The state chip. Every one of the nine states gets its own colour. */
export function StateBadge({ state, title }: { state: string; title?: string }) {
  const key = (state in STATE_CHIP ? state : "UNKNOWN") as HealthState;
  return (
    <span className={`chip ${STATE_CHIP[key]}`} title={title}>
      <span
        className={`status-dot ${
          key === "ONLINE"
            ? "status-dot--on"
            : key === "OFFLINE" || key === "LINK_DOWN"
              ? "status-dot--off"
              : key === "NO_INTERNET"
                ? "status-dot--purple"
                : key === "DEGRADED" || key === "STALE" || key === "NO_TRAFFIC"
                  ? "status-dot--warn"
                  : "status-dot--idle"
        }`}
      />
      {humanise(state)}
    </span>
  );
}

const SEVERITY_CHIP: Record<Severity, string> = {
  critical: "chip--danger",
  major: "chip--warn",
  minor: "chip--purple",
  info: "chip--muted",
};

export function SeverityBadge({ severity }: { severity: string }) {
  const key = (severity in SEVERITY_CHIP ? severity : "info") as Severity;
  return <span className={`chip ${SEVERITY_CHIP[key]}`}>{humanise(key)}</span>;
}

export function Chip({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: "neon" | "warn" | "danger" | "muted" | "purple";
  title?: string;
}) {
  return (
    <span className={`chip chip--${tone}`} title={title}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted">
      <span className="spinner spinner--light" />
      {label}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      <div className="flex items-start justify-between gap-3">
        <span>{message}</span>
        {onRetry ? (
          <button type="button" className="btn btn--ghost btn--sm shrink-0" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  title?: string;
  children: ReactNode;
}) {
  const cls =
    tone === "danger"
      ? "border-red-500/40 bg-red-500/10 text-red-200"
      : tone === "warn"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
        : tone === "ok"
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-white/10 bg-white/5 text-muted";
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>
      {title ? <div className="mb-1 font-semibold">{title}</div> : null}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <div className="text-sm font-semibold text-white">{title}</div>
      {description ? <p className="max-w-md text-xs leading-relaxed text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layout helpers                                                      */
/* ------------------------------------------------------------------ */

export function Grid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`grid gap-3 ${className ?? ""}`.trim()}>{children}</div>;
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-white/8 bg-black/25 px-3 py-2">
      {children}
    </div>
  );
}

export function Labeled({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function KeyValue({
  items,
  columns = 2,
}: {
  items: { label: string; value: ReactNode }[];
  columns?: 1 | 2 | 3;
}) {
  const cols =
    columns === 1
      ? "sm:grid-cols-1"
      : columns === 3
        ? "sm:grid-cols-3"
        : "sm:grid-cols-2";
  return (
    <dl className={`grid grid-cols-1 gap-x-6 gap-y-2 ${cols}`}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 border-b border-white/5 pb-1.5">
          <dt className="text-[0.6rem] font-bold tracking-[0.16em] text-muted uppercase">
            {item.label}
          </dt>
          <dd className="mt-0.5 truncate text-sm text-white" title={String(item.value ?? "")}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A monospaced block of evidence (incident evidence, notes, raw output). */
export function Evidence({ children }: { children: string | null | undefined }) {
  if (!children || !children.trim()) {
    return <p className="text-xs text-muted">No evidence was recorded for this record.</p>;
  }
  return (
    <pre className="scroll-thin max-h-64 overflow-auto rounded-xl border border-white/10 bg-black/50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted">
      {children}
    </pre>
  );
}
