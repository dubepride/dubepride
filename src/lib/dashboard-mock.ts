/**
 * Dashboard widget mock data (redesign phase).
 *
 * Feeds the four redesigned dashboard modules — Employee Status,
 * Exceptions, Approaching Overtime and Time Off Requests — so the grid is
 * fully populated and "alive" on the very first render, before any API
 * round-trip resolves.
 *
 * HYDRATION RULE: every constant here is static (no Date.now() /
 * Math.random()) so the server prerender and the client hydration pass
 * produce byte-identical markup. Employee ids/names mirror the seeded
 * Employees table so clicking a status row opens that person's real
 * timesheet at /employees/[id].
 */

import type { ExceptionType } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Widget A — Employee Status                                          */
/* ------------------------------------------------------------------ */

export type EmployeeWorkStatus = "WORKING" | "ON BREAK" | "NOT IN";

export interface EmployeeStatusRow {
  /** Real Employees.Employee_ID — rows deep-link to /employees/[id]. */
  employeeId: number;
  erpUserId: string;
  name: string;
  department: string;
  status: EmployeeWorkStatus;
  /** Last punch of the day, "8:45 AM" — "—" while not checked in. */
  time: string;
}

export const EMPLOYEE_STATUS: EmployeeStatusRow[] = [
  { employeeId: 1, erpUserId: "EMP1001", name: "Pride Admin", department: "IT", status: "NOT IN", time: "—" },
];

/* ------------------------------------------------------------------ */
/* Widget B — Exceptions                                               */
/* ------------------------------------------------------------------ */

/**
 * `neutral` = informational (white), `warn` = amber deviation,
 * `danger` = red exception (No Show / Missing Punch).
 *
 * `type` maps each box to its drill-down bucket (Phase 4): the counts
 * seed the first render, then hydrate from GET /api/dashboard/exceptions.
 */
export interface ExceptionMetric {
  type: ExceptionType;
  label: string;
  count: number;
  tone: "neutral" | "warn" | "danger";
}

export const EXCEPTION_METRICS: ExceptionMetric[] = [
  { type: "arrived_early", label: "Arrived Early",  count: 0, tone: "neutral" },
  { type: "arrived_late",  label: "Arrived Late",   count: 0, tone: "warn"    },
  { type: "left_early",    label: "Left Early",     count: 0, tone: "warn"    },
  { type: "left_late",     label: "Left Late",      count: 0, tone: "neutral" },
  { type: "no_show",       label: "No Show",        count: 0, tone: "danger"  },
  { type: "missing_punch", label: "Missing Punch",  count: 0, tone: "danger"  },
];

/* ------------------------------------------------------------------ */
/* Widget C — Approaching Overtime                                     */
/* ------------------------------------------------------------------ */

export interface OvertimeRow {
  employeeId: number;
  erpUserId: string;
  name: string;
  department: string;
  /** Weekly total in H:MM — rendered as "30:20 (Weekly)". */
  worked: string;
  /** Remaining time before the first overtime tier. */
  approaching: string;
  status: "ON TRACK" | "NEAR OT";
}

export const OVERTIME_ROWS: OvertimeRow[] = [];

/* ------------------------------------------------------------------ */
/* Widget D — Time Off Requests                                        */
/* ------------------------------------------------------------------ */

export interface TimeOffRequest {
  id: number;
  employeeId: number;
  name: string;
  /** e.g. 16 → "16 Hr(s) Vacation". */
  hours: number;
  type: string;
  /** e.g. "Nov 18" / "Nov 19" — equal values render as a single day. */
  fromLabel: string;
  toLabel: string;
}

export const TIME_OFF_REQUESTS: TimeOffRequest[] = [];
