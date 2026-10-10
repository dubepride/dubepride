"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ExceptionDrawer from "@/components/ExceptionDrawer";
import WidgetShell from "@/components/WidgetShell";
import { EXCEPTION_METRICS } from "@/lib/dashboard-mock";
import type { ExceptionRow, ExceptionType, ExceptionsResponse } from "@/lib/types";

/** Number colouring: neutral white info, amber deviation, red exception. */
const TONE = {
  neutral: "text-ink",
  warn: "text-warn",
  danger: "text-danger",
} as const;

/** First-render box totals — static mock, byte-identical on server + client. */
const SEED_COUNTS = Object.fromEntries(
  EXCEPTION_METRICS.map((m) => [m.type, m.count])
) as Record<ExceptionType, number>;

/**
 * Widget B — Exceptions (top right).
 *
 * Six bordered metric boxes with large, bold, centred numbers. Labels are
 * fixed by the spec: Arrived Early, Arrived Late, Left Early, Left Late,
 * No Show and Missing Punch. Warning colours (amber/red) flag the
 * negative exceptions — amber for late/early deviations, red for
 * No Show / Missing Punch.
 *
 * Phase 4: every box is a button that drills into the matching employees
 * in a right-hand slide-out drawer — no navigation away from the grid.
 *
 *  • first paint uses the static mock counts (hydration-safe);
 *  • a summary GET on mount then hydrates the six boxes to live values;
 *  • each click fetches GET /api/dashboard/exceptions?type=… — a sequence
 *    guard drops stale responses when boxes are clicked in quick
 *    succession — and the drawer lists rows with variance badges;
 *  • opening refreshes counts too, so a box number can never disagree
 *    with what its drawer shows;
 *  • drawer hygiene: Escape + backdrop + close button dismiss it,
 *    background scroll is locked while open, focus returns to the box,
 *    and route changes (View Timesheet / browser back) close it.
 */
export default function ExceptionsCard() {
  const pathname = usePathname();
  const [counts, setCounts] = useState<Record<ExceptionType, number>>(SEED_COUNTS);
  const [active, setActive] = useState<ExceptionType | null>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0); // stale-response guard for drawer fetches
  const triggerRef = useRef<HTMLElement | null>(null); // box that opened us

  // Hydrate the six box totals once mounted: the mock keeps the first
  // paint honest, this keeps it truthful afterwards. Skipped if a drawer
  // fetch already superseded us.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/dashboard/exceptions", { cache: "no-store" });
        if (!res.ok) return;
        const data: ExceptionsResponse = await res.json();
        if (alive && seqRef.current === 0) setCounts(data.counts);
      } catch {
        /* offline / signed out — the seeded counts stand */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async (type: ExceptionType) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setRows([]);
    try {
      const res = await fetch(`/api/dashboard/exceptions?type=${type}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`The bridge returned ${res.status} for this bucket.`);
      const data: ExceptionsResponse = await res.json();
      if (seq !== seqRef.current) return; // superseded by a newer click
      setRows(data.rows);
      setCounts(data.counts);
      setLoading(false);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setRows([]);
      setError(e instanceof Error ? e.message : "Unable to reach the bridge API.");
      setLoading(false);
    }
  }, []);

  const openFor = (type: ExceptionType, trigger: HTMLElement): void => {
    triggerRef.current = trigger;
    void load(type);
    if (active === null) {
      // First open: paint the freshly mounted panel off-screen, then
      // flip it on so the slide-in transition has a start state.
      setActive(type);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setOpen(true));
      });
    } else {
      setActive(type);
      setOpen(true);
    }
  };

  const close = useCallback(() => {
    setOpen(false);
    const trigger = triggerRef.current;
    if (trigger && trigger.isConnected) trigger.focus();
  }, []);

  // While open: lock background scroll and honour Escape (focus restore
  // rides along through close()).
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Close on route change — React's render-phase adjustment pattern (as
  // in AppChrome), so browser back/forward can't strand an open drawer
  // over another page with the scroll lock still held.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (open) setOpen(false);
  }

  return (
    <WidgetShell
      title="Exceptions"
      id="exceptions"
      meta={
        <span className="chip chip--muted">
          Today · auto-detected
        </span>
      }
      bodyClassName="p-4 sm:p-5"
      footer={
        <p className="text-[11px] text-muted">
          Classified from punch times against the 17:00–18:00 knock-off window ·
          Mon–Sat.
        </p>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {EXCEPTION_METRICS.map((m) => (
          <button
            key={m.type}
            type="button"
            aria-haspopup="dialog"
            title={`Open the ${m.label} drill-down`}
            onClick={(e) => openFor(m.type, e.currentTarget)}
            className="group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-panel-deep/70 to-panel-rich/30 px-3 py-5 text-center transition duration-200 hover:scale-105 hover:border-white/25 hover:from-panel-deep hover:to-panel-rich hover:shadow-[0_10px_30px_rgba(74,20,140,0.45)] active:scale-100"
          >
            <span
              className={`text-3xl leading-none font-bold tabular-nums ${TONE[m.tone]}`}
            >
              {counts[m.type]}
            </span>
            <span className="mt-2 text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">
              {m.label}
            </span>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-1.5 text-[8px] font-bold tracking-[0.2em] text-white/70 opacity-0 uppercase transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              View
            </span>
          </button>
        ))}
      </div>

      {active !== null ? (
        <ExceptionDrawer
          type={active}
          open={open}
          rows={rows}
          loading={loading}
          error={error}
          onClose={close}
          onRetry={() => void load(active)}
          onNavigate={close}
        />
      ) : null}
    </WidgetShell>
  );
}
