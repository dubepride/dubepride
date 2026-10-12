/**
 * ============================================================================
 *  timesheet-export.ts — individual employee timesheet export (print + CSV)
 * ============================================================================
 *
 *  Turns one employee's raw punches for an arbitrary calendar period into the
 *  structure behind the "Timesheet Export" feature:
 *
 *     raw logs ──► one entry per calendar day in the range (gaps included)
 *              ──► full chronological punch sequence (In → Out → In → Out)
 *              ──► per-punch pairing flag (unmatched / open / denied)
 *              ──► per-day status + worked time, reusing buildDay verbatim
 *              ──► period totals
 *
 *  `timesheetExportToCsv` renders the same structure as an RFC-4180 CSV that
 *  opens cleanly in Excel / LibreOffice Calc (CRLF, quoted when needed, and
 *  the route prepends a UTF-8 BOM).
 *
 *  Pure/isomorphic: no database or framework imports, so the exact same
 *  pairing + formatting runs server-side (API route) and in the browser.
 */

import { dateKeyOf, formatPunchTime, formatTime12 } from "@/lib/format";
import { addDays, buildDay } from "@/lib/timesheet";
import type {
  EmployeePunchRow,
  EmployeeTimesheetExport,
  TimesheetDayStatus,
  TimesheetExportDay,
  TimesheetExportPunch,
  TimesheetPunch,
  TimesheetPunchFlag,
} from "@/lib/types";

/** Hard stop against pathological ranges (the route enforces its own cap). */
const MAX_DAYS = 4000;

/** Short explanation of each flag — shared by the print tag and the CSV. */
export const FLAG_NOTE: Record<TimesheetPunchFlag, string> = {
  "unmatched-in": "unmatched clock-in",
  "unmatched-out": "unmatched clock-out — no clock-in",
  open: "missing clock-out",
  denied: "verification denied",
};

/* ------------------------------------------------------------------ */
/* Pairing analysis                                                    */
/* ------------------------------------------------------------------ */

/**
 * Mirror buildDay's IN → OUT pairing to flag the punches it could not pair.
 * Only verified punches participate (a denied attempt never opens/closes a
 * pair), matching the worked-time calculation exactly.
 */
function flagPunches(punches: TimesheetPunch[]): {
  flags: Map<number, TimesheetPunchFlag>;
  issues: string[];
} {
  const flags = new Map<number, TimesheetPunchFlag>();
  const issues: string[] = [];
  let open: TimesheetPunch | null = null;

  for (const p of punches) {
    if (p.verifyResult === "Denied") {
      flags.set(p.logId, "denied");
      issues.push(`Denied clock attempt at ${formatTime12(p.timestamp)}`);
      continue;
    }
    if (p.direction === "IN") {
      if (open === null) {
        open = p;
      } else {
        flags.set(p.logId, "unmatched-in");
        issues.push(
          `Unmatched clock-in at ${formatTime12(p.timestamp)} (already clocked in)`
        );
      }
    } else if (open !== null) {
      open = null; // clean IN → OUT pair
    } else {
      flags.set(p.logId, "unmatched-out");
      issues.push(
        `Unmatched clock-out at ${formatTime12(p.timestamp)} (no clock-in)`
      );
    }
  }

  if (open) {
    flags.set(open.logId, "open");
    issues.push(
      `Clock-in at ${formatTime12(open.timestamp)} has no clock-out recorded`
    );
  }
  return { flags, issues };
}

/** Resolve the display status for one day from its paired punches. */
function dayStatus(
  punchCount: number,
  firstIn: number | null,
  openShift: boolean,
  isRestDay: boolean,
  flags: Map<number, TimesheetPunchFlag>
): TimesheetDayStatus {
  if (punchCount === 0) return isRestDay ? "Rest day" : "No punches";
  if (firstIn === null) return "Incomplete"; // clock-out(s) without a clock-in
  if (openShift) return "Incomplete";
  for (const f of flags.values()) {
    if (f === "unmatched-in" || f === "unmatched-out") return "Incomplete";
  }
  return "Present";
}

/* ------------------------------------------------------------------ */
/* Day / totals construction                                           */
/* ------------------------------------------------------------------ */

/**
 * Build every calendar day in the inclusive [fromMs, toMs] range. Days with
 * no punches are included with an empty sequence so the printout and the CSV
 * describe the whole requested period (and "no records" is explicit).
 */
export function buildExportDays(
  logs: EmployeePunchRow[],
  fromMs: number,
  toMs: number,
  now: number
): TimesheetExportDay[] {
  // Bucket by local day so buildDay receives exactly one day's punches.
  const byDay = new Map<string, EmployeePunchRow[]>();
  for (const log of logs) {
    const key = dateKeyOf(log.Timestamp);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(log);
    else byDay.set(key, [log]);
  }

  const days: TimesheetExportDay[] = [];
  let cursor = fromMs;
  let guard = 0;
  while (cursor <= toMs && guard++ < MAX_DAYS) {
    const base = buildDay(cursor, byDay.get(dateKeyOf(cursor)) ?? [], now);
    const { flags, issues } = flagPunches(base.punches);
    const punches: TimesheetExportPunch[] = base.punches.map((p) => ({
      ...p,
      flag: flags.get(p.logId) ?? null,
    }));
    const isRestDay = new Date(cursor).getDay() === 0;

    days.push({
      ...base,
      punches,
      isRestDay,
      issues,
      status: dayStatus(
        base.punches.length,
        base.firstIn,
        base.openShift,
        isRestDay,
        flags
      ),
    });
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Aggregate the period totals from the built days. */
export function exportTotals(
  days: TimesheetExportDay[]
): EmployeeTimesheetExport["totals"] {
  let daysRecorded = 0;
  let daysWorked = 0;
  let punches = 0;
  let workedMs = 0;
  let openShifts = 0;
  let issues = 0;
  for (const d of days) {
    if (d.punches.length > 0) daysRecorded++;
    if (d.firstIn !== null) daysWorked++;
    punches += d.punches.length;
    workedMs += d.workedMs;
    if (d.openShift) openShifts++;
    issues += d.issues.length;
  }
  return { daysRecorded, daysWorked, punches, workedMs, openShifts, issues };
}

/* ------------------------------------------------------------------ */
/* CSV rendering                                                       */
/* ------------------------------------------------------------------ */

/** Column order — punch-level rows grouped under their calendar day. */
export const CSV_HEADERS = [
  "Employee ID",
  "Employee Name",
  "Department",
  "Date",
  "Day of Week",
  "Punch Number",
  "Punch Time",
  "Punch Type (IN/OUT)",
  "Attendance Description",
  "Branch/Location",
  "Synchronization Status",
  "First In",
  "Last Out",
  "Total Hours Worked",
  "Attendance Status",
] as const;

/** RFC-4180 cell: quote only when the value contains a comma, quote or newline. */
export function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Decimal hours (2 dp) so spreadsheet columns can be summed directly. */
function decimalHours(ms: number): string {
  return (ms / 3_600_000).toFixed(2);
}

/** "Branch 4 · Main Gate" — whichever of branch/location are present. */
export function branchLocation(branch: string | null, location: string | null): string {
  return [branch, location]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(" · ");
}

/**
 * Render the export as CRLF-delimited CSV. Days without punches emit a single
 * day-only row so the period is complete; every other day emits one row per
 * punch, repeating the day-level columns (first in / last out / hours / status).
 */
export function timesheetExportToCsv(data: EmployeeTimesheetExport): string {
  const { employee, days } = data;
  const lines: string[] = [CSV_HEADERS.join(",")];

  for (const d of days) {
    const dayCols: (string | number | null)[] = [
      employee.erpUserId,
      employee.fullName,
      employee.department,
      d.dateKey,
      d.dayName,
    ];

    if (d.punches.length === 0) {
      lines.push(
        [
          ...dayCols,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          decimalHours(0),
          d.status,
        ]
          .map(csvCell)
          .join(",")
      );
      continue;
    }

    for (const p of d.punches) {
      const description = p.flag
        ? `${p.label} — ${FLAG_NOTE[p.flag]}`
        : p.label;
      lines.push(
        [
          ...dayCols,
          p.seq,
          formatPunchTime(p.timestamp),
          p.direction,
          description,
          branchLocation(p.branch, p.location),
          p.syncStatus,
          d.firstIn !== null ? formatPunchTime(d.firstIn) : "",
          d.lastOut !== null ? formatPunchTime(d.lastOut) : "",
          decimalHours(d.workedMs),
          d.status,
        ]
          .map(csvCell)
          .join(",")
      );
    }
  }

  return lines.join("\r\n");
}

/* ------------------------------------------------------------------ */
/* Download filename                                                   */
/* ------------------------------------------------------------------ */

/** `Timesheet_Amara_Okafor_2026-10-12_to_2026-10-17.csv` */
export function exportFilename(
  fullName: string,
  fromKey: string,
  toKey: string,
  ext: string
): string {
  const name = fullName
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `Timesheet_${name || "Employee"}_${fromKey}_to_${toKey}.${ext}`;
}
