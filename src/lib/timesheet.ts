/**
 * ============================================================================
 *  timesheet.ts — multi-punch grouping engine (Phase 2 · Objectives 3 & 4)
 * ============================================================================
 *
 *  Turns a flat list of attendance rows into the structure a formal HR
 *  timesheet needs:
 *
 *     raw logs ──► grouped by local day (Mon–Sat only)
 *              ──► chronologically ordered: In → Out → In → Out
 *              ──► each punch labelled ("Morning in", "Lunch out",
 *                  "Return in", "Knock off out")
 *              ──► days bucketed into weeks ("Week 1", "Week 2", …)
 *
 *  Pure/isomorphic: no database or framework imports, so it can be unit
 *  tested, used from API routes, or reused client-side.
 */

import { dateKeyOf, formatDayLabel } from "@/lib/format";
import type {
  EmployeePunchRow,
  TimesheetDay,
  TimesheetPunch,
  TimesheetWeek,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Calendar helpers                                                    */
/* ------------------------------------------------------------------ */

/** Local midnight of the Monday that opens `ms`'s week. */
export function startOfWeekMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday = 0
  return d.getTime();
}

/** DST-safe day arithmetic: local midnight of `ms` + `n` days. */
export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Fractional local hour: 13:45 → 13.75 (drives the punch labels). */
function hourOf(ms: number): number {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
}

/* ------------------------------------------------------------------ */
/* Day construction                                                    */
/* ------------------------------------------------------------------ */

/**
 * Label one punch from its position in the day's VERIFIED sequence:
 *
 *   IN  #1 before 11:00 → "Morning in"   ·  after → "Clock in"
 *   OUT #1 before 14:30 → "Lunch out"    ·  after → "Knock off out"
 *   IN  #2              → "Return in"    ·  OUT #2 from 16:00 → "Knock off out"
 *   beyond              → "Extra in/out" ·  Denied → "Denied attempt"
 *
 * This matches the real-world pattern: in for the morning, out for lunch,
 * back in after lunch, knock off between 17:00–18:00. OUT #2 only reads as
 * the knock-off when it actually lands in the late-afternoon window — an
 * extra out-punch at lunchtime (live simulator, split shifts) is "Extra out".
 */
function labelPunch(
  direction: "IN" | "OUT",
  verifiedCount: number,
  timestamp: number,
  denied: boolean
): string {
  if (denied) return "Denied attempt";
  const hour = hourOf(timestamp);
  if (direction === "IN") {
    if (verifiedCount === 1) return hour < 11 ? "Morning in" : "Clock in";
    if (verifiedCount === 2) return "Return in";
    return "Extra in";
  }
  if (verifiedCount === 1) return hour >= 14.5 ? "Knock off out" : "Lunch out";
  if (verifiedCount === 2) return hour >= 16 ? "Knock off out" : "Extra out";
  return "Extra out";
}

/**
 * Build one Monday–Saturday timesheet day row from its raw punches.
 * Exported so the timesheet-report generator can reuse the exact same
 * pairing, worked-time and label logic for an arbitrary date window.
 */
export function buildDay(dateMs: number, rows: EmployeePunchRow[], now: number): TimesheetDay {
  const sorted = [...rows].sort((a, b) => a.Timestamp - b.Timestamp);

  // Sequential pairing IN → OUT computes real worked time (lunch breaks
  // fall outside every pair, so they are automatically excluded).
  let openAt: number | null = null;
  let workedMs = 0;
  let firstIn: number | null = null;
  let lastOut: number | null = null;

  for (const r of sorted) {
    if (r.Verify_Result === "Denied") continue;
    if (r.Direction === "IN") {
      if (openAt === null) openAt = r.Timestamp;
      if (firstIn === null) firstIn = r.Timestamp;
    } else {
      if (openAt !== null) {
        workedMs += Math.max(0, r.Timestamp - openAt);
        openAt = null;
      }
      lastOut = r.Timestamp;
    }
  }

  const punches: TimesheetPunch[] = sorted.map((r, i) => {
    const denied = r.Verify_Result === "Denied";
    const verifiedCount = verifiedInCountUpTo(sorted, i, r.Direction);
    return {
      logId: r.Log_ID,
      timestamp: r.Timestamp,
      direction: r.Direction,
      verifyResult: r.Verify_Result,
      syncStatus: r.ERP_Sync_Status,
      branch: r.Branch_Name,
      location: r.Location_Name,
      seq: i + 1,
      label: labelPunch(r.Direction, verifiedCount, r.Timestamp, denied),
    };
  });

  const date = new Date(dateMs);
  return {
    dateKey: dateKeyOf(dateMs),
    dayName: date.toLocaleDateString("en-GB", { weekday: "long" }),
    dateLabel: formatDayLabel(date),
    dateMs,
    punches,
    firstIn,
    lastOut,
    workedMs,
    openShift: openAt !== null,
    isToday: dateKeyOf(dateMs) === dateKeyOf(now),
  };
}

/** How many verified punches of this direction occurred up to index `i`. */
function verifiedInCountUpTo(
  rows: EmployeePunchRow[],
  i: number,
  direction: "IN" | "OUT"
): number {
  let n = 0;
  for (let k = 0; k <= i; k++) {
    if (rows[k].Direction === direction && rows[k].Verify_Result !== "Denied") n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Week construction                                                   */
/* ------------------------------------------------------------------ */

export interface BuildTimesheetOptions {
  /** Window start (snapped down to its Monday). */
  fromMs: number;
  /** Window end (snapped up to the end of its Saturday). */
  toMs: number;
  /** Reference "now" for today-highlighting / open shifts. */
  now?: number;
}

/**
 * Group an employee's punches into calendar weeks, Monday → Saturday.
 * Weeks are enumerated even when empty so the UI can offer a complete
 * "Week 1 … Week N" selector, chronologically ordered and 1-based.
 */
export function buildTimesheet(
  logs: EmployeePunchRow[],
  opts: BuildTimesheetOptions
): TimesheetWeek[] {
  const now = opts.now ?? Date.now();

  // 1. Bucket punches by local day. Sunday punches are excluded — the
  //    working week is Monday–Saturday (Sunday = rest day).
  const byDay = new Map<string, EmployeePunchRow[]>();
  for (const row of logs) {
    if (new Date(row.Timestamp).getDay() === 0) continue;
    const key = dateKeyOf(row.Timestamp);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(row);
    else byDay.set(key, [row]);
  }

  // 2. Enumerate every week in the window (Monday-start).
  const weeks: TimesheetWeek[] = [];
  let cursor = startOfWeekMs(opts.fromMs);
  const lastWeek = startOfWeekMs(opts.toMs);
  let guard = 0; // hard stop against pathological ranges
  while (cursor <= lastWeek && guard++ < 520) {
    const days: TimesheetDay[] = [];
    for (let d = 0; d < 6; d++) {
      // 6 working days: Monday (0) … Saturday (5). Sunday is never rendered.
      const dayMs = addDays(cursor, d);
      days.push(buildDay(dayMs, byDay.get(dateKeyOf(dayMs)) ?? [], now));
    }

    const totals = days.reduce(
      (acc, day) => ({
        daysWorked: acc.daysWorked + (day.firstIn !== null ? 1 : 0),
        punches: acc.punches + day.punches.length,
        workedMs: acc.workedMs + day.workedMs,
      }),
      { daysWorked: 0, punches: 0, workedMs: 0 }
    );

    weeks.push({
      index: weeks.length + 1,
      startMs: cursor,
      endMs: addDays(cursor, 7),
      label: "",
      days,
      totals,
    });

    const nextMonday = new Date(cursor);
    nextMonday.setDate(nextMonday.getDate() + 7);
    nextMonday.setHours(0, 0, 0, 0);
    cursor = nextMonday.getTime();
  }

  // 3. Human labels once indices are final.
  for (const w of weeks) {
    w.label = `Week ${w.index} · ${formatDayLabel(new Date(w.startMs))} – ${formatDayLabel(
      new Date(addDays(w.startMs, 5))
    )}`;
  }

  return weeks;
}
