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
  { employeeId: 1,  erpUserId: "ERP-1001", name: "Amara Okafor",       department: "Operations",        status: "WORKING", time: "7:42 AM" },
  { employeeId: 2,  erpUserId: "ERP-1002", name: "Daniel Whitfield",   department: "Logistics",         status: "WORKING", time: "7:58 AM" },
  { employeeId: 3,  erpUserId: "ERP-1003", name: "Priya Raghunathan",  department: "Engineering",       status: "WORKING", time: "8:03 AM" },
  { employeeId: 4,  erpUserId: "ERP-1004", name: "Marcus Delaney",     department: "Engineering",       status: "NOT IN",  time: "—" },
  { employeeId: 5,  erpUserId: "ERP-1005", name: "Sofia Castellanos",  department: "Finance",           status: "WORKING", time: "7:31 AM" },
  { employeeId: 6,  erpUserId: "ERP-1006", name: "Kwame Mensah",       department: "Warehouse",         status: "ON BREAK", time: "12:14 PM" },
  { employeeId: 7,  erpUserId: "ERP-1007", name: "Elena Petrova",      department: "Human Resources",   status: "WORKING", time: "8:12 AM" },
  { employeeId: 8,  erpUserId: "ERP-1008", name: "Jackson Rowe",       department: "Security",          status: "WORKING", time: "6:58 AM" },
  { employeeId: 9,  erpUserId: "ERP-1009", name: "Fatima Al-Sayed",    department: "Procurement",       status: "NOT IN",  time: "—" },
  { employeeId: 10, erpUserId: "ERP-1010", name: "Thomas Achebe",      department: "Maintenance",       status: "WORKING", time: "8:45 AM" },
  { employeeId: 11, erpUserId: "ERP-1011", name: "Grace Lindqvist",    department: "Engineering",       status: "WORKING", time: "8:21 AM" },
  { employeeId: 12, erpUserId: "ERP-1012", name: "Rafael Moreno",      department: "Logistics",         status: "NOT IN",  time: "—" },
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
  { type: "arrived_early", label: "Arrived Early",  count: 4, tone: "neutral" },
  { type: "arrived_late",  label: "Arrived Late",   count: 3, tone: "warn"    },
  { type: "left_early",    label: "Left Early",     count: 2, tone: "warn"    },
  { type: "left_late",     label: "Left Late",      count: 5, tone: "neutral" },
  { type: "no_show",       label: "No Show",        count: 1, tone: "danger"  },
  { type: "missing_punch", label: "Missing Punch",  count: 2, tone: "danger"  },
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

export const OVERTIME_ROWS: OvertimeRow[] = [
  { employeeId: 1,  erpUserId: "ERP-1001", name: "Amara Okafor",      department: "Operations",      worked: "30:20", approaching: "9h 39m to OT1",  status: "ON TRACK" },
  { employeeId: 2,  erpUserId: "ERP-1002", name: "Daniel Whitfield",  department: "Logistics",       worked: "34:05", approaching: "5h 55m to OT1",  status: "NEAR OT"  },
  { employeeId: 3,  erpUserId: "ERP-1003", name: "Priya Raghunathan", department: "Engineering",     worked: "36:40", approaching: "3h 20m to OT1",  status: "NEAR OT"  },
  { employeeId: 5,  erpUserId: "ERP-1005", name: "Sofia Castellanos", department: "Finance",         worked: "28:15", approaching: "11h 45m to OT1", status: "ON TRACK" },
  { employeeId: 6,  erpUserId: "ERP-1006", name: "Kwame Mensah",      department: "Warehouse",       worked: "38:10", approaching: "1h 50m to OT1",  status: "NEAR OT"  },
];

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

export const TIME_OFF_REQUESTS: TimeOffRequest[] = [
  { id: 1, employeeId: 11, name: "Grace Lindqvist",  hours: 16, type: "Vacation",    fromLabel: "Nov 18", toLabel: "Nov 19" },
  { id: 2, employeeId: 4,  name: "Marcus Delaney",   hours: 8,  type: "Sick Leave",  fromLabel: "Oct 22", toLabel: "Oct 22" },
  { id: 3, employeeId: 9,  name: "Fatima Al-Sayed",  hours: 4,  type: "Personal",    fromLabel: "Nov 02", toLabel: "Nov 02" },
  { id: 4, employeeId: 10, name: "Thomas Achebe",    hours: 24, type: "Vacation",    fromLabel: "Dec 24", toLabel: "Dec 26" },
];
