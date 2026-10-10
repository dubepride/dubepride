/**
 * Isomorphic formatting helpers — safe to import from server components,
 * client components, API routes and the mock generator.
 *
 * All timestamps throughout the bridge are stored as epoch milliseconds
 * (integer) in SQLite. Formatting always happens at the edges so the
 * stored values stay timezone-safe.
 */

/** Pad a number to two digits: 7 → "07". */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Start of the current local day (midnight) as epoch ms. */
export function startOfTodayMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 24-hour wall clock: "14:03:07". Used by the master clock. */
export function formatClockTime(input: Date | number): string {
  const d = input instanceof Date ? input : new Date(input);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
    d.getSeconds()
  )}`;
}

/** Feed timestamps: "08:02:07 AM" (matches the spec's live-feed example). */
export function formatFeedTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${pad2(h12)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${ampm}`;
}

/** Human date line under the master clock: "Wednesday · 07 October 2026". */
export function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** Compact timestamp for tables: "07 Oct, 14:03". */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const day = pad2(d.getDate());
  const month = d.toLocaleString("en-GB", { month: "short" });
  return `${day} ${month}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Date only: "07 Oct". */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const day = pad2(d.getDate());
  const month = d.toLocaleString("en-GB", { month: "short" });
  return `${day} ${month}`;
}

/** "YYYY-MM-DD" string → "07 Oct". */
export function formatDateString(ymd: string): string {
  const d = new Date(ymd + "T00:00:00");
  if (isNaN(d.getTime())) return ymd;
  const day = pad2(d.getDate());
  const month = d.toLocaleString("en-GB", { month: "short" });
  return `${day} ${month}`;
}

/** ERP-facing punch time in device/server local time: "2026-10-07 08:02:07". */
export function formatPunchTime(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Relative age for "last ping" cells: "12s ago" / "4m ago" / "3h ago". */
export function formatRelative(ms: number | null, now: number = Date.now()): string {
  if (ms === null || ms === undefined) return "never";
  const delta = Math.max(0, now - ms);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "AO" for "Amara Okafor" — feed avatars. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Phase 2 helpers — timesheets & multi-punch presentation             */
/* ------------------------------------------------------------------ */

/** Timesheet clock cells: "08:02 AM" (seconds omitted for readability). */
export function formatTime12(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${pad2(h12)}:${pad2(d.getMinutes())} ${ampm}`;
}

/** Worked durations: "7h 42m", "45m", "0h 00m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0h 00m";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${pad2(m)}m`;
}

/** Compact date label used in tables/timesheets: "07 Oct". */
export function formatDayLabel(d: Date): string {
  return `${pad2(d.getDate())} ${d.toLocaleString("en-GB", { month: "short" })}`;
}

/** Day key safe for grouping across DST boundaries: "2026-10-07". */
export function dateKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
