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

/**
 * How a site / device is allowed to accept clock-ins (Phase 15).
 *
 *   Biometric  — the physical fingerprint terminal only (the default).
 *   Geofence   — hands-free geofenced mobile app only (no terminal needed).
 *   Both       — either channel (a.k.a. "Hybrid" in the admin UI).
 *
 * Stored verbatim in Branches/Terminals.Clocking_Method. The admin UI shows
 * friendlier labels ("Biometric Only" / "Geofence Only" / "Hybrid — Both")
 * while the API accepts common aliases and normalises via
 * `normalizeClockingMethod()` (src/lib/geofence.ts).
 */
export type ClockingMethod = "Biometric" | "Geofence" | "Both";

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
  /** Allowed clock-in channel for this device (Phase 15). */
  Clocking_Method: ClockingMethod;
  /** Geofence centre (WGS-84) — null when the device has none configured. */
  Latitude: number | null;
  Longitude: number | null;
  /** Accept radius around the centre, in metres. */
  Geofence_Radius_Meters: number | null;
}

export interface AttendanceLogRow {
  Log_ID: number;
  Employee_ID: number | null; // null = unrecognised ID pushed by a terminal
  Timestamp: number; // epoch ms of the punch (device time, interpreted as server-local)
  Terminal_ID: number | null;
  ERP_Sync_Status: ErpSyncStatus;
  Verify_Result: VerifyResult;
  Direction: PunchDirection;
  Verify_Method: string; // "Fingerprint", "Card", "Face", "Geofence", ...
  Raw_Payload: string | null; // original frame received from the device
  /** GPS captured with a geofenced mobile punch (Phase 15) — null for terminals. */
  Latitude: number | null;
  Longitude: number | null;
  /** Device-reported GPS accuracy in metres (null when unavailable). */
  Location_Accuracy_Meters: number | null;
  /** Metres from the site centre at punch time (null = not a geofence punch). */
  Geofence_Distance_Meters: number | null;
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
  /** Allowed clock-in channel (Phase 15). */
  clockingMethod: ClockingMethod;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusMeters: number | null;
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
  /** Allowed clock-in channel for this site (Phase 15). */
  Clocking_Method: ClockingMethod;
  /** Geofence centre (WGS-84) — null when this site has none configured. */
  Latitude: number | null;
  Longitude: number | null;
  /** Accept radius around the centre, in metres. */
  Geofence_Radius_Meters: number | null;
}

/** Branch wired for the Settings tab — includes usage counts. */
export interface BranchDto {
  id: number;
  name: string;
  employeeCount: number;
  terminalCount: number;
  createdAt: number;
  /** Allowed clock-in channel (Phase 15). */
  clockingMethod: ClockingMethod;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusMeters: number | null;
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

/* ------------------------------------------------------------------ */
/* Phase 15 — Hands-Free Geofenced Mobile Clocking                     */
/* ------------------------------------------------------------------ */

/**
 * Machine-readable outcome of a mobile GPS punch. The mobile app switches on
 * `reason` rather than parsing prose.
 */
export type GeoPunchReason =
  | "CLOCKED_IN"
  | "CLOCKED_OUT"
  | "OUTSIDE_GEOFENCE"
  | "BIOMETRIC_ONLY"
  | "LOW_ACCURACY"
  | "RATE_LIMITED"
  | "GEOFENCE_NOT_CONFIGURED";

/** How a punch's governing site was chosen (Phase 17). */
export type GeoPunchDetection = "terminal" | "branchRef" | "auto";

/** Geofence verdict attached to a processed / rejected mobile punch. */
export interface GeoPunchGeo {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  /** Great-circle distance from the site centre, rounded to whole metres. */
  distanceMeters: number;
  /** Configured accept radius in metres. */
  radiusMeters: number;
  withinGeofence: boolean;
  /** The channel the resolved location permits. */
  method: ClockingMethod;
  /** Human location/branch the punch was validated against. */
  location: string | null;
  branch: string | null;
  /**
   * Which site was used and how it was picked: the terminal the app scanned,
   * an explicit `branchRef`, or the bridge matching the GPS fix against every
   * registered site. `auto` is the travelling employee's normal path.
   */
  detectedBy: GeoPunchDetection;
  /** True when the fix fell outside every registered site (auto detection). */
  insideAnySite: boolean;
  /** Nearest registered site when the fix was outside all of them. */
  nearestBranch: string | null;
  nearestDistanceMeters: number | null;
}

/**
 * POST /api/attendance/geopunch response.
 *
 * `ok:true`  — an in-radius punch was written as Pending for the ERP.
 * `ok:false` with `reason:"OUTSIDE_GEOFENCE"` — the attempt was recorded as an
 *            exception (Verified_Result "Denied", not queued for the ERP).
 * Other `ok:false` values (BIOMETRIC_ONLY / GEOFENCE_NOT_CONFIGURED + 4xx)
 * mean nothing was written.
 */
/**
 * One registered site a mobile punch may be validated against (Phase 17).
 *
 * Sign-in hands the phone EVERY qualifying site — not just the employee's
 * roster branch — because an employee may travel and clock in wherever they
 * can physically stand. The bridge stays authoritative: it re-derives the
 * governing site from the GPS fix on every punch, so this list only tells the
 * app which fences to listen for.
 */
export interface GeoFenceSite {
  /** Branches.Branch_ID. */
  id: number;
  /** Branches.Branch_Name — quoted back as `branchRef`. */
  branch: string;
  method: ClockingMethod;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/**
 * POST /api/mobile/login response — the companion app's sign-in result.
 *
 * `ok:true` hands the phone the roster identity it must quote on every punch
 * plus every site its punches may be judged against. The employee's own
 * branch is reported for display only; it no longer gates sign-in and no
 * longer decides where a punch is valid — the GPS fix does.
 */
export interface MobileLoginResponse {
  ok: boolean;
  message: string;
  employee: {
    employeeId: number;
    erpUserId: string;
    fullName: string;
    department: string;
    branch: string;
  };
  /**
   * The employee's own (roster) site, shown as "Home site". Null when they
   * have no branch assigned — which is no longer a sign-in error.
   */
  geofence: {
    configured: boolean;
    method: ClockingMethod;
    /** Human label — the branch name (or device Location_Name). */
    label: string | null;
    branch: string | null;
    latitude: number | null;
    longitude: number | null;
    radiusMeters: number | null;
  } | null;
  /**
   * Every site that may accept this phone's punch: mobile-capable AND
   * geo-ready. Empty means nothing is set up yet — the app still signs in,
   * but hands-free clocking has nothing to watch.
   */
  fences: GeoFenceSite[];
  generatedAt: number;
  /** Present only on ok:false — "BIOMETRIC_ONLY" is the common one. */
  reason?: GeoPunchReason;
  error?: string;
}

export interface GeoPunchResponse {
  ok: boolean;
  reason: GeoPunchReason;
  message: string;
  punch: {
    /** Attendance_Logs.Log_ID — null when no row was written. */
    logId: number | null;
    employeeId: number;
    employeeName: string;
    erpUserId: string;
    timestamp: number;
    direction: PunchDirection;
    verifyMethod: string;
    syncStatus: ErpSyncStatus | null;
    verifyResult: VerifyResult | null;
  } | null;
  geo: GeoPunchGeo | null;
  error?: string;
}

/**
 * GET /api/attendance/geofences — every site a browser self-clock may use
 * (Phase 18). Feeds the My Portal map so the worker can see the fences near
 * them. Read-only and non-sensitive (site names + centres, already visible in
 * Settings → Branches); gated by can_remote_clock along with the punch route.
 */
export interface GeofencesResponse {
  ok: boolean;
  sites: GeoFenceSite[];
  generatedAt: number;
  error?: string;
}

/**
 * GET /api/attendance/geofence-activity — the Phase 9 mobile-GPS report.
 * One row per GPS-validated punch, filterable by date range, branch, verdict
 * and employee, with a source comparison against non-geofence punches.
 */
export interface GeofenceActivityRow {
  logId: number;
  employeeId: number | null;
  employeeName: string;
  erpUserId: string | null;
  branch: string | null;
  timestamp: number;
  direction: PunchDirection;
  verifyResult: VerifyResult;
  syncStatus: ErpSyncStatus;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  latitude: number | null;
  longitude: number | null;
  insideGeofence: boolean;
}

export interface GeofenceActivityResponse {
  ok: boolean;
  rows: GeofenceActivityRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  accepted: number;
  rejected: number;
  totalBiometric: number;
  totalGeofence: number;
  branches: string[];
  generatedAt: number;
  error?: string;
}

/**
 * GET /api/map/overview — data for the always-available map overlay (Phase 18).
 *
 * A single read-only snapshot of everything the floating map shows: the site
 * fences the caller may see and the most recent GPS punch locations. Scope is
 * permission-aware:
 *   • "org"  — callers with attendance/settings visibility see every
 *              geo-ready branch and organisation-wide recent punches.
 *   • "self" — everyone else sees the mobile-capable fences and only their own
 *              punches.
 * Because the overlay is display-only, a tampered response cannot affect where
 * a punch lands — the bridge re-derives the governing site on every punch.
 */
export interface MapOverviewSite {
  id: number;
  branch: string;
  method: ClockingMethod;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  /** False for biometric-only sites (shown, but not usable for a mobile punch). */
  mobile: boolean;
}

export interface MapOverviewPunch {
  logId: number;
  employeeId: number | null;
  employeeName: string;
  branch: string | null;
  timestamp: number;
  direction: PunchDirection;
  verifyResult: VerifyResult;
  latitude: number;
  longitude: number;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  insideGeofence: boolean;
}

export interface MapOverviewResponse {
  ok: boolean;
  /** "org" = all sites + everyone's punches; "self" = your fences + your punches. */
  scope: "org" | "self";
  sites: MapOverviewSite[];
  punches: MapOverviewPunch[];
  /** Suggested initial centre (centroid of the visible fences), or null. */
  center: { latitude: number; longitude: number } | null;
  /** Window the punches cover, in ms. */
  windowMs: number;
  generatedAt: number;
  error?: string;
}

