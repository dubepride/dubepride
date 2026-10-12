/**
 * Shared type definitions for the Biometric Time & Attendance Bridge.
 *
 * Two layers live here:
 *   1. `*Row` types    — mirror the raw SQLite tables (PascalCase column names
 *                        match the database schema exactly).
 *   2. DTO types       — camelCase payloads exchanged with the frontend via
 *                        the JSON API routes.
 */

import type { PermissionsMap } from "./rbac";

/* ------------------------------------------------------------------ */
/* Domain enums                                                        */
/* ------------------------------------------------------------------ */

/** ERP synchronisation lifecycle of a single attendance record. */
export type ErpSyncStatus = "Pending" | "Success" | "Failed";

/** Connection state of an IP fingerprint terminal. */
export type TerminalStatus = "Online" | "Offline";

/** Outcome of a biometric verification attempt. */
export type VerifyResult = "Verified" | "Denied";

/** Clock direction captured by the terminal. */
export type PunchDirection = "IN" | "OUT";

/** Outcome of one batch push to the ERP. */
export type BatchStatus = "Success" | "Failed";

/* ------------------------------------------------------------------ */
/* Raw SQLite rows                                                     */
/* ------------------------------------------------------------------ */

export interface EmployeeRow {
  Employee_ID: number;
  ERP_User_ID: string;
  Full_Name: string;
  Fingerprint_Enrolled: number; // SQLite booleans are 0/1 integers
  /** Comma-separated enrolled finger indexes (0‥4) — "" = none captured. */
  Fingers_Enrolled: string;
  Department: string;
  /** Job title — Phase 11 directory column. */
  Position: string;
  /** Home branch assigned when the employee was added — "" = unassigned. */
  Branch_Name: string;
  /** FK-ish reference to Shifts.Shift_ID (null = unassigned). */
  Shift_ID: number | null;
  /** Employment state — "Active" | "Inactive". */
  Status: string;
  Created_At: number; // epoch ms
}

export interface TerminalRow {
  Terminal_ID: number;
  Terminal_MAC: string;
  IP_Address: string;
  Location_Name: string;
  /** One of the company's 17 branches — "Branch 1" … "Branch 17". */
  Branch_Name: string;
  Status: TerminalStatus;
  Last_Ping: number | null; // epoch ms of last heartbeat / scan
}

export interface AttendanceLogRow {
  Log_ID: number;
  Employee_ID: number | null; // null = unrecognised ID pushed by a terminal
  Timestamp: number; // epoch ms of the punch (device time, interpreted as server-local)
  Terminal_ID: number | null;
  ERP_Sync_Status: ErpSyncStatus;
  Verify_Result: VerifyResult;
  Direction: PunchDirection;
  Verify_Method: string; // "Fingerprint", "Card", "Face", ...
  Raw_Payload: string | null; // original frame received from the device
  Created_At: number; // epoch ms of ingestion
}

export interface SyncBatchRow {
  Batch_ID: number;
  Created_At: number;
  Record_Count: number;
  Status: BatchStatus;
  Response_Code: number | null; // HTTP status returned by the ERP
  Error_Message: string | null;
  Duration_MS: number | null;
  Trigger_Source: "Manual" | "Auto"; // admin button vs. background retry loop
  Payload_JSON: string; // exact JSON body pushed to the ERP
}

/** Attendance log joined with employee + terminal info (feed query). */
export interface FeedRow {
  Log_ID: number;
  Timestamp: number;
  ERP_Sync_Status: ErpSyncStatus;
  Verify_Result: VerifyResult;
  Direction: PunchDirection;
  Full_Name: string | null;
  ERP_User_ID: string | null;
  Location_Name: string | null;
  IP_Address: string | null;
  Branch_Name: string | null;
  /** 1-based position of this punch in the employee's working day. */
  Day_Seq: number | null;
}

/** Terminal joined with today's punch counter. */
export interface TerminalJoinedRow extends TerminalRow {
  Scans_Today: number;
}

/** Pending log joined with employee + terminal (ERP payload builder). */
export interface ErpLogRow {
  Log_ID: number;
  Timestamp: number;
  Direction: PunchDirection;
  Verify_Method: string;
  ERP_User_ID: string | null;
  Full_Name: string | null;
  Terminal_MAC: string | null;
  IP_Address: string | null;
  Location_Name: string | null;
  Branch_Name: string | null;
}

/* ------------------------------------------------------------------ */
/* API DTOs                                                            */
/* ------------------------------------------------------------------ */

export interface FeedEntry {
  logId: number;
  employeeName: string;
  erpUserId: string | null;
  timestamp: number;
  location: string;
  /** Branch the capturing terminal belongs to ("Branch 3" …). */
  branchName: string | null;
  /** Sequence # of this punch in the employee's day (null = unknown ID). */
  daySeq: number | null;
  verifyResult: VerifyResult;
  syncStatus: ErpSyncStatus;
  direction: PunchDirection;
  registered: boolean; // false → ID was never enrolled in this bridge
}

export interface DashboardMetrics {
  clockedInToday: number; // distinct employees with a punch today
  scansToday: number;
  terminalsOnline: number;
  terminalsTotal: number;
  pendingSync: number;
  syncedToday: number;
}

/**
 * Headline attendance split behind the dashboard's summary cards and the
 * "Today's Attendance Overview" doughnut (Phase 11).
 *
 *   present + late + absent === total  (every employee lands in exactly one
 *   bucket: first punch ≤/ > the 08:00 shift start, or no punch at all).
 */
export interface AttendanceSummary {
  total: number; // roster size (Employees rows)
  present: number; // first verified punch at/before 08:00
  late: number; // first verified punch after 08:00
  absent: number; // no verified punch today
}

export interface DashboardResponse {
  metrics: DashboardMetrics;
  summary: AttendanceSummary;
  feed: FeedEntry[];
  generatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Phase 11 — shifts, attendance records, employee management          */
/* ------------------------------------------------------------------ */

/** One row of the Shifts table (Phase 11 /shifts). */
export interface ShiftRow {
  Shift_ID: number;
  Name: string;
  /** "08:00" — 24h local wall clock. */
  Start_Time: string;
  End_Time: string;
  /** Signed span in minutes (overnight shifts wrap past midnight). */
  Duration_Minutes: number;
  /** Assigned days as a comma list: "Mon,Tue,Wed,Thu,Fri". */
  Days: string;
  Created_At: number;
  /** Employees currently assigned to this shift. */
  Assigned: number;
}

export interface ShiftsResponse {
  shifts: ShiftRow[];
  generatedAt: number;
}

/** One employee × one calendar day inside /attendance-records. */
export interface AttendanceRecord {
  /** Stable row key — `${employeeId}:${dateKey}`. */
  key: string;
  dateMs: number;
  employeeId: number;
  erpUserId: string;
  fullName: string;
  department: string;
  position: string;
  shiftId: number | null;
  shiftName: string | null;
  /** First punch of the day (null = no punch in range). */
  clockIn: number | null;
  /** Last OUT punch of the day (null = still clocked in / none). */
  clockOut: number | null;
  /** Worked time = sum of completed IN → OUT pairs (breaks excluded). */
  workedMs: number;
  status: "Present" | "In Progress" | "Missing Punch";
}

export interface AttendanceRecordsResponse {
  rows: AttendanceRecord[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  /** Distinct departments present in the roster (filter dropdown). */
  departments: string[];
  shifts: { id: number; name: string }[];
  generatedAt: number;
}

export interface TerminalDto {
  id: number;
  mac: string;
  ip: string;
  location: string;
  branch: string;
  status: TerminalStatus;
  lastPing: number | null;
  scansToday: number;
}

export interface TerminalsResponse {
  terminals: TerminalDto[];
  generatedAt: number;
}

/** One attendance record as the ERP expects to receive it. */
export interface ErpRecord {
  log_id: number;
  employee_ref: string | null; // ERP_User_ID
  employee_name: string | null;
  direction: PunchDirection;
  punch_time: string; // "YYYY-MM-DD HH:mm:ss" in server-local time
  timestamp_ms: number;
  verify_method: string;
  terminal: {
    mac: string | null;
    ip: string | null;
    location: string | null;
    /** Branch of the capturing terminal (Phase 2 ERP payload field). */
    branch: string | null;
  };
}

/** The exact JSON envelope POSTed to the external ERP REST API. */
export interface ErpBatchPayload {
  batch_ref: string;
  source: "TA-BRIDGE";
  pushed_at: string; // ISO-8601 UTC
  record_count: number;
  records: ErpRecord[];
}

export interface SyncBatchDto {
  batchId: number;
  createdAt: number;
  recordCount: number;
  status: BatchStatus;
  responseCode: number | null;
  errorMessage: string | null;
  durationMs: number | null;
  trigger: "Manual" | "Auto";
  payload: ErpBatchPayload | null; // parsed for the diagnostics drawer
}

export interface BacklogEntry {
  logId: number;
  employeeName: string;
  erpUserId: string | null;
  timestamp: number;
  location: string;
  branchName: string | null;
  ageMs: number;
}

export interface SyncStats {
  pendingLogs: number;
  syncedToday: number;
  successBatches: number;
  failedBatches: number;
  lastBatchAt: number | null;
  lastSuccessAt: number | null;
}

export interface ErpSyncGetResponse {
  stats: SyncStats;
  batches: SyncBatchDto[];
  backlog: BacklogEntry[];
  /** "mock" = built-in ERP simulator, "live" = real ERP_API_URL target. */
  mode: "mock" | "live";
  erpUrl: string | null;
  failEvery: number; // simulator outage frequency (0 = never)
  generatedAt: number;
}

export interface ErpSyncPostResponse {
  ok: boolean;
  attempted: number;
  synced: number;
  failed: number; // records quarantined as Failed (ERP 4xx rejection)
  message: string;
  batch: SyncBatchDto | null;
  trigger: "Manual" | "Auto";
}

/** Acknowledgement returned to the physical fingerprint terminal. */
export interface PushAck {
  ok: boolean;
  received: number;
  ignored?: number;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Phase 2 — auth, branches, multi-punch timesheets                    */
/* ------------------------------------------------------------------ */

/** One punch as returned by getEmployeeLogs (joined with terminal branch). */
export interface EmployeePunchRow {
  Log_ID: number;
  Timestamp: number;
  Direction: PunchDirection;
  Verify_Result: VerifyResult;
  ERP_Sync_Status: ErpSyncStatus;
  Location_Name: string | null;
  Branch_Name: string | null;
}

/** One hit in the dashboard's employee search dropdown. */
export interface EmployeeSearchResult {
  id: number;
  erpUserId: string;
  fullName: string;
  department: string;
  enrolled: boolean;
  punches30d: number;
  lastPunch: number | null;
}

export interface EmployeeSearchResponse {
  query: string;
  results: EmployeeSearchResult[];
  generatedAt: number;
}

/** One row of the /employees master directory (Phase 5 → 11). */
export interface EmployeeDirectoryEntry {
  /** Internal Employee_ID — the id used by /employees/[id]. */
  id: number;
  erpUserId: string;
  fullName: string;
  enrolled: boolean;
  department: string;
  position: string;
  /** Employment state — "Active" | "Inactive". */
  status: string;
  shiftId: number | null;
  /** Most recent Attendance_Logs timestamp (null = never punched). */
  lastSeen: number | null;
  /** Display branch: assigned branch, else the branch of the last punch. */
  branch: string | null;
  /** The branch written on the employee record ("" = never assigned). */
  assignedBranch: string;
  /** Enrolled finger indexes 0‥4 (thumb → little) for the hand map. */
  fingers: number[];
}

export interface EmployeeDirectoryResponse {
  query: string;
  employees: EmployeeDirectoryEntry[];
  generatedAt: number;
}

/** POST /api/employees/[id]/fingers — the enrolment console's save result. */
export interface FingersSaveResponse {
  ok: boolean;
  fingers: number[];
  enrolled: boolean;
}

/** One employee currently clocked in (Phase 7 /whos-in). */
export interface WhosInPerson {
  employeeId: number;
  erpUserId: string;
  fullName: string;
  department: string;
  branchName: string | null;
  locationName: string | null;
  clockedInAt: number;
}

export interface WhosInResponse {
  people: WhosInPerson[];
  count: number;
  generatedAt: number;
}

/** A single punch as rendered inside a timesheet day cell. */
export interface TimesheetPunch {
  logId: number;
  timestamp: number;
  direction: PunchDirection;
  verifyResult: VerifyResult;
  syncStatus: ErpSyncStatus;
  /** Branch where this scan took place (null = unassigned terminal). */
  branch: string | null;
  location: string | null;
  /** 1-based chronological position within the working day. */
  seq: number;
  /** Human role: "Morning in", "Lunch out", "Return in", "Knock off out"… */
  label: string;
}

/** One calendar day (Monday–Saturday) of a timesheet. */
export interface TimesheetDay {
  /** Local "YYYY-MM-DD" key. */
  dateKey: string;
  dayName: string; // "Monday"
  dateLabel: string; // "07 Oct"
  dateMs: number; // local midnight of that day
  punches: TimesheetPunch[];
  firstIn: number | null;
  lastOut: number | null;
  /** Worked time = sum of completed IN → OUT pairs (lunch excluded). */
  workedMs: number;
  /** True when an IN punch has no matching OUT yet (shift in progress). */
  openShift: boolean;
  isToday: boolean;
}

/** One working week (Monday → Saturday) of a timesheet. */
export interface TimesheetWeek {
  /** 1-based "Week N" inside the requested range (chronological). */
  index: number;
  startMs: number; // local midnight of the Monday
  endMs: number; // local midnight of the following Sunday
  label: string; // "Week 1 · 05 Oct – 10 Oct"
  days: TimesheetDay[]; // always Mon…Sat; empty days included
  totals: {
    daysWorked: number;
    punches: number;
    workedMs: number;
  };
}

/** GET /api/employees/[id] — profile header + fully grouped timesheet. */
export interface EmployeeProfileResponse {
  employee: {
    id: number;
    erpUserId: string;
    fullName: string;
    department: string;
    enrolled: boolean;
    /** Enrolled finger indexes 0‥4 — drives the enrolment hand map. */
    fingers: number[];
    createdAt: number;
  };
  weeks: TimesheetWeek[];
  stats: {
    punchesInWindow: number;
    daysPresent: number;
    workedMs: number;
    branchesUsed: string[];
    lastPunch: number | null;
  };
  window: {
    fromMs: number;
    toMs: number;
  };
  generatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Phase 11+ — timesheet report (custom period · PDF/print)            */
/* ------------------------------------------------------------------ */

/** One day of a timesheet report row (same shape Earth-side as TimesheetDay). */
export interface TimesheetReportDay {
  dateKey: string;
  dayName: string; // "Monday"
  dateLabel: string; // "07 Oct"
  dateMs: number; // local midnight
  firstIn: number | null;
  lastOut: number | null;
  workedMs: number;
  /** Verified punches that day (denied attempts not counted). */
  punches: number;
  openShift: boolean;
}

/** One employee in a timesheet report. */
export interface TimesheetReportEmployee {
  id: number;
  erpUserId: string;
  fullName: string;
  department: string;
  position: string;
  days: TimesheetReportDay[];
  daysWorked: number;
  punches: number;
  workedMs: number;
}

/** GET /api/employees/timesheet-report — summary + daily rows for a period. */
export interface TimesheetReportResponse {
  /** Echoed scope: empty search = whole roster. */
  query: string;
  period: {
    fromKey: string;
    toKey: string;
    fromMs: number;
    toMs: number;
  };
  employees: TimesheetReportEmployee[];
  totals: {
    employees: number;
    daysWorked: number;
    punches: number;
    workedMs: number;
  };
  generatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Individual employee timesheet export (print + CSV)                  */
/* ------------------------------------------------------------------ */

/**
 * Why a punch does not pair cleanly. `null` on the punch = clean pair.
 *   unmatched-in  → a second clock-in while already clocked in
 *   unmatched-out → a clock-out with no open clock-in
 *   open          → clock-in with no clock-out recorded (shift in progress)
 *   denied        → biometric verification failed (never counted as work)
 */
export type TimesheetPunchFlag =
  | "unmatched-in"
  | "unmatched-out"
  | "open"
  | "denied";

/** One punch in an individual export day, annotated with its pairing flag. */
export interface TimesheetExportPunch extends TimesheetPunch {
  flag: TimesheetPunchFlag | null;
}

/** Per-day attendance status shown in the preview / print / CSV. */
export type TimesheetDayStatus =
  | "Present"
  | "Incomplete"
  | "No punches"
  | "Rest day";

/** One calendar day of an individual employee export (full punch sequence). */
export interface TimesheetExportDay extends Omit<TimesheetDay, "punches"> {
  punches: TimesheetExportPunch[];
  /** Sunday = rest day for the Monday–Saturday working week. */
  isRestDay: boolean;
  status: TimesheetDayStatus;
  /** Human-readable description of every unmatched / denied event. */
  issues: string[];
}

/** GET /api/employees/[id]/timesheet — one employee, one custom period. */
export interface EmployeeTimesheetExport {
  employee: {
    id: number;
    erpUserId: string;
    fullName: string;
    department: string;
    position: string;
    branch: string;
    status: string;
    enrolled: boolean;
    fingers: number[];
    shiftId: number | null;
  };
  period: {
    fromKey: string; // "YYYY-MM-DD"
    toKey: string;
    fromMs: number; // local midnight
    toMs: number; // inclusive end of the `to` day
    days: number; // calendar days in range
  };
  days: TimesheetExportDay[];
  totals: {
    daysRecorded: number; // days with ≥1 punch
    daysWorked: number; // days with a clock-in
    punches: number;
    workedMs: number;
    openShifts: number;
    issues: number;
  };
  generatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Phase 13/14 — relational settings, access matrix, system accounts   */
/* ------------------------------------------------------------------ */

/** One row of the Branches table (Phase 13 — the global branch list). */
export interface BranchRow {
  Branch_ID: number;
  Branch_Name: string;
  Created_At: number; // epoch ms
}

/** Branch wired for the Settings tab — includes usage counts. */
export interface BranchDto {
  id: number;
  name: string;
  employeeCount: number;
  terminalCount: number;
  createdAt: number;
}

export interface BranchesResponse {
  branches: BranchDto[];
  generatedAt: number;
}

/** One row of the Access_Levels table — the Matrix lives in Permissions_JSON. */
export interface AccessLevelRow {
  Access_Level_ID: number;
  Level_Name: string;
  Permissions_JSON: string;
  Created_At: number;
}

/** Access level wired for the Settings tab (matrix + account headcount). */
export interface AccessLevelDto {
  id: number;
  name: string;
  permissions: PermissionsMap;
  enabled: number;
  total: number;
  accountCount: number;
  createdAt: number;
}

export interface AccessLevelsResponse {
  levels: AccessLevelDto[];
  generatedAt: number;
}

/** One row of the System_Accounts table (Phase 13). */
export interface SystemAccountRow {
  Account_ID: number;
  First_Name: string;
  Surname: string;
  Company_Email: string;
  Password_Hash: string;
  Access_Level_ID: number | null;
  Branch_ID: number | null;
  /** Optional link to Employees — drives the My Portal worker demo. */
  Employee_ID: number | null;
  Created_At: number;
}

/** System account joined with its level, branch and (optional) employee. */
export interface SystemAccountDto {
  id: number;
  firstName: string;
  surname: string;
  name: string;
  email: string;
  accessLevelId: number | null;
  levelName: string | null;
  branchId: number | null;
  branchName: string | null;
  employeeId: number | null;
  employeeName: string | null;
  createdAt: number;
}

export interface SystemAccountsResponse {
  accounts: SystemAccountDto[];
  /** Catalogue for the "Access Level" dropdown. */
  levels: { id: number; name: string }[];
  /** Catalogue for the "Branch" dropdown. */
  branches: { id: number; name: string }[];
  generatedAt: number;
}

/** Identity + permission snapshot returned by GET /api/auth/me. */
export interface MeAccount {
  accountId: number;
  firstName: string;
  surname: string;
  name: string;
  email: string;
  accessLevelId: number | null;
  levelName: string;
  branchId: number | null;
  branchName: string | null;
  employeeId: number | null;
}

export interface MeResponse {
  ok: boolean;
  account: MeAccount;
  permissions: PermissionsMap;
  /** Page the account should land on after login / on denial redirects. */
  home: string;
}

/* ------------------------------------------------------------------ */
/* Phase 14 — My Portal (worker remote clocking hub)                   */
/* ------------------------------------------------------------------ */

/** One row of the Time_Off_Requests table (worker portal). */
export interface TimeOffRequestRow {
  Request_ID: number;
  Account_ID: number;
  Employee_ID: number | null;
  Type: string; // "Annual" | "Sick" | "Unpaid" | "Other"
  Start_Date: string; // "YYYY-MM-DD"
  End_Date: string;
  Reason: string;
  Status: string; // "Pending"
  Created_At: number;
}

/** Orientation payload for /my-portal — who you are + your day status. */
export interface MyPortalResponse {
  ok: boolean;
  account: {
    accountId: number;
    name: string;
    email: string;
    levelName: string;
    branchName: string | null;
  };
  /** Linked roster identity (null when the account has no employee link). */
  employee: {
    id: number;
    erpUserId: string;
    fullName: string;
    department: string;
    position: string;
    branch: string | null;
    enrolled: boolean;
  } | null;
  status: {
    /** Latest punch today is an IN → the remote clock button shows "out". */
    clockedIn: boolean;
    lastPunchAt: number | null;
    lastDirection: "IN" | "OUT" | null;
  };
  generatedAt: number;
}

/** One punch row of the worker's own punch history table. */
export interface MyPortalPunch {
  logId: number;
  timestamp: number;
  direction: "IN" | "OUT";
  verifyResult: VerifyResult;
  syncStatus: ErpSyncStatus;
  location: string | null;
  branch: string | null;
}

export interface MyPortalHistoryResponse {
  ok: boolean;
  employeeId: number | null;
  employeeName: string;
  rows: MyPortalPunch[];
  generatedAt: number;
}

/** POST /api/my-portal/clock — the remote clock result. */
export interface MyPortalClockResponse {
  ok: boolean;
  punch: {
    employeeName: string;
    timestamp: number;
    direction: "IN" | "OUT";
    terminalName: string | null;
  } | null;
  message: string;
  error?: string;
}

export interface MyPortalTimeOffResponse {
  ok: boolean;
  requests: TimeOffRequestRow[];
  message: string;
  error?: string;
}

/** All permission/account related re-exports for convenience. */
export type { PermissionKey, PermissionsMap } from "./rbac";

/* ------------------------------------------------------------------ */
/* Phase 4 — interactive exception drill-down                          */
/* ------------------------------------------------------------------ */

/** The six drill-down buckets behind the dashboard's Exceptions widget. */
export type ExceptionType =
  | "arrived_early"
  | "arrived_late"
  | "left_early"
  | "left_late"
  | "no_show"
  | "missing_punch";

/** One employee inside an exception bucket (wire shape from the API). */
export interface ExceptionRow {
  employeeId: number;
  erpUserId: string;
  fullName: string;
  department: string;
  /** Branch of the punch that triggered the exception (null for no_show). */
  branchName: string | null;
  /** Exact punch time behind the exception; null when no punch exists. */
  timestamp: number | null;
  /** Signed whole minutes against the bucket's baseline (null if n/a). */
  varianceMin: number | null;
  /** Structural gap flavour for missing_punch / no_show rows. */
  note?: "no_punch" | "missing_in" | "missing_out";
}

/**
 * GET /api/dashboard/exceptions — summary (`type: null`, counts only) or
 * one bucket (`rows` filled). `counts` always carries the live totals for
 * ALL six widget boxes so the number on the box and the rows in the
 * drawer can never disagree.
 */
export interface ExceptionsResponse {
  type: ExceptionType | null;
  /** Human title for the bucket ("Arrived Late") — null on summary. */
  label: string | null;
  /** Baseline rule shown under the drawer title — null on summary. */
  rule: string | null;
  /** Matching employees for the requested bucket — [] on summary. */
  rows: ExceptionRow[];
  counts: Record<ExceptionType, number>;
  generatedAt: number;
}
