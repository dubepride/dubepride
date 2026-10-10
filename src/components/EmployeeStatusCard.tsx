"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import Avatar from "@/components/Avatar";
import WidgetShell from "@/components/WidgetShell";
import { IconCheck, IconFilter, IconSearch, IconUsers } from "@/components/icons";
import { EMPLOYEE_STATUS, type EmployeeWorkStatus } from "@/lib/dashboard-mock";
import type { EmployeeSearchResponse, EmployeeSearchResult } from "@/lib/types";

/** Status pill per work state — neon = engaged, amber = transient, gray = absent. */
const STATUS_CHIP: Record<EmployeeWorkStatus, string> = {
  WORKING: "chip chip--neon",
  "ON BREAK": "chip chip--warn",
  "NOT IN": "chip chip--muted",
};

type StatusFilter = "ALL" | EmployeeWorkStatus;

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "WORKING", label: "Working" },
  { value: "ON BREAK", label: "On break" },
  { value: "NOT IN", label: "Not in" },
];

/**
 * Widget A — Employee Status (top-left).
 *
 * Search bar ("Search for ID or Name") with a status filter icon:
 *   - typing filters the visible roster client-side (name / ERP ID) AND
 *     type-aheads against /api/employees/search — picking a result opens
 *     that employee's weekly timesheet at /employees/[id];
 *   - rows are seeded from mock data so the card is populated on the very
 *     first render, and each row deep-links to the real timesheet;
 *   - the footer summarises working vs. roster totals with green/gray
 *     icon counts.
 */
export default function EmployeeStatusCard() {
  const router = useRouter();

  /* --- search (mirrors the EmployeeSearch debounce contract) --------- */
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EmployeeSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);

  /* --- status filter menu ------------------------------------------- */
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [menuOpen, setMenuOpen] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounced search (250 ms) with stale-response protection. The
  // "too short / cleared" path is handled in onChange (event handler);
  // this effect only schedules the fetch, never sets state synchronously.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/employees/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as EmployeeSearchResponse;
        setResults(data.results);
        setActive(0);
        setOpen(true);
      } catch {
        setResults([]);
        setOpen(true);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  // Close the type-ahead dropdown / filter menu when clicking away.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setQuery(value);
    // Clearing/resetting happens here (event handlers may set state freely);
    // the debounce effect only ever schedules a fetch.
    if (value.trim().length < 2) {
      setResults([]);
      setOpen(false);
      setSearching(false);
    } else {
      setSearching(true);
    }
  }

  function pick(emp: EmployeeSearchResult) {
    setOpen(false);
    setQuery("");
    setResults([]);
    router.push(`/employees/${emp.id}`);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // Visible roster: status filter first, then the search text.
  const text = query.trim().toLowerCase();
  const rows = EMPLOYEE_STATUS.filter(
    (r) =>
      (filter === "ALL" || r.status === filter) &&
      (text.length === 0 ||
        r.name.toLowerCase().includes(text) ||
        r.erpUserId.toLowerCase().includes(text))
  );

  const working = EMPLOYEE_STATUS.filter((r) => r.status === "WORKING").length;
  const roster = EMPLOYEE_STATUS.length;

  return (
    <WidgetShell
      title="Employee Status"
      id="whos-in"
      bodyClassName="p-0"
      footer={
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <IconUsers className="h-4 w-4 text-neon" />
            <span className="font-mono text-sm font-bold text-neon tabular-nums">
              {working}
            </span>
            <span className="text-[10px] font-bold tracking-[0.16em] text-muted uppercase">
              Working now
            </span>
          </span>
          <span className="flex items-center gap-2">
            <IconUsers className="h-4 w-4 text-muted" />
            <span className="font-mono text-sm font-bold text-muted tabular-nums">
              {roster}
            </span>
            <span className="text-[10px] font-bold tracking-[0.16em] text-muted uppercase">
              On roster
            </span>
          </span>
        </div>
      }
    >
      <div ref={wrapRef}>
        {/* Search bar + filter icon ----------------------------------- */}
        <div className="relative border-b border-white/[0.06] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <IconSearch className="h-4 w-4 flex-none text-neon" />
            <input
              value={query}
              onChange={onChange}
              onFocus={() => results.length > 0 && setOpen(true)}
              onKeyDown={onKey}
              placeholder="Search for ID or Name"
              aria-label="Search for ID or Name"
              className="w-full bg-transparent text-sm text-ink placeholder:text-muted/70 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Filter by status"
              aria-expanded={menuOpen}
              className={`flex-none rounded-lg border p-1.5 transition-colors ${
                menuOpen || filter !== "ALL"
                  ? "border-neon/40 bg-neon/10 text-neon"
                  : "border-white/10 bg-white/[0.03] text-muted hover:text-ink"
              }`}
              title="Filter by status"
            >
              <IconFilter className="h-4 w-4" />
            </button>
          </div>

          {/* Filter menu ------------------------------------------------ */}
          {menuOpen ? (
            <div className="glass rise absolute right-4 top-full z-40 mt-2 w-44 overflow-hidden shadow-[0_16px_44px_rgba(0,0,0,0.55)] sm:right-5">
              <ul>
                {FILTER_OPTIONS.map((opt) => (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => {
                        setFilter(opt.value);
                        setMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors ${
                        filter === opt.value
                          ? "bg-panel-deep/60 text-ink"
                          : "text-muted hover:bg-white/[0.04] hover:text-ink"
                      }`}
                    >
                      {opt.label}
                      {filter === opt.value ? (
                        <IconCheck className="h-3.5 w-3.5 text-neon" />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Type-ahead dropdown ---------------------------------------- */}
          {open ? (
            <div className="glass rise absolute inset-x-4 top-full z-30 mt-2 overflow-hidden shadow-[0_16px_44px_rgba(0,0,0,0.55)] sm:inset-x-5">
              {results.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">
                  No employee matches “{query.trim()}”.
                </p>
              ) : (
                <ul className="scroll-thin max-h-72 divide-y divide-white/5 overflow-y-auto">
                  {results.map((emp, i) => (
                    <li key={emp.id}>
                      <button
                        type="button"
                        onClick={() => pick(emp)}
                        onMouseEnter={() => setActive(i)}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors sm:px-5 ${
                          i === active ? "bg-panel-deep/50" : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <Avatar name={emp.fullName} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-ink">
                            {emp.fullName}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {emp.department || "Unassigned"} · {emp.erpUserId}
                          </span>
                        </span>
                        <span className="chip chip--neon flex-none">Open</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        {/* Column header --------------------------------------------- */}
        <div className="flex items-center gap-3 px-4 pb-2 pt-3 text-[9px] font-bold tracking-[0.18em] text-muted uppercase sm:px-5">
          <span className="flex-1 pl-12">Name</span>
          <span>Status</span>
          <span className="w-16 text-right">Time</span>
        </div>

        {/* Roster list ------------------------------------------------ */}
        <div className="scroll-thin max-h-[340px] divide-y divide-white/5 overflow-y-auto border-t border-white/[0.05]">
          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">
              No employee matches this view.
            </p>
          ) : (
            rows.map((row) => (
              <button
                key={row.employeeId}
                type="button"
                onClick={() => router.push(`/employees/${row.employeeId}`)}
                title={`Open ${row.name}'s timesheet`}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.04] sm:px-5"
              >
                <Avatar name={row.name} tone={row.status === "WORKING" ? "neon" : "muted"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">
                    {row.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted">
                    {row.erpUserId} · {row.department}
                  </span>
                </span>
                <span className={`flex-none ${STATUS_CHIP[row.status]}`}>
                  {row.status}
                </span>
                <span className="w-16 flex-none text-right font-mono text-xs text-muted tabular-nums">
                  {row.time}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
      {searching ? (
        <span className="sr-only" role="status">
          Searching…
        </span>
      ) : null}
    </WidgetShell>
  );
}
