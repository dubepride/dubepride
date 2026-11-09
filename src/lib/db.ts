/**
 * ============================================================================
 *  db.ts — SQLite data access layer (hardware → ERP bridge core)
 * ============================================================================
 *
 *  Single source of truth for the bridge: schema creation, deterministic
 *  demo seeding and every query the API routes / background services rely on.
 *
 *  Tables
 *    Employees        — roster (ERP id, fingerprint, department, position …)
 *    Terminals        — the 17 branches' IP fingerprint terminals
 *    Attendance_Logs  — every punch (Pending → Success/Failed for the ERP)
 *    Erp_Sync_Batches — one row per push attempt (exact payload retained)
 *    Shifts           — shift definitions (Phase 11)
 *
 *  Conventions
 *    • all timestamps are epoch milliseconds (SQLite INTEGER)
 *    • SQLite has no booleans — flags are stored as 0/1 integers
 *    • PascalCase column names mirror the physical schema 1:1
 *
 *  The connection is a process-wide singleton kept on `globalThis` so
 *  dev-HMR module graphs and separately bundled route modules all share
 *  one libSQL client (local file in dev, remote Turso in production —
 *  see sqlite.ts). The schema is maintained by this layer, not by triggers.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  The database file lives at data/ta-bridge.db (override with TA_DB_PATH).
 *  Schema migrations are idempotent: every table/column/index is created
 *  with IF NOT EXISTS semantics, so the same code boots a fresh checkout
 *  and an existing data file alike.
 *  ─────────────────────────────────────────────────────────────────────
 */

import crypto from "node:crypto";
import type { Client } from "@libsql/client";
import {
  executeBatch,
  getReadyClient,
  isServerlessRuntime,
  setBootstrap,
  type SqlStatement,
  type SqlValue,
} from "@/lib/sqlite";
import { EXCEPTION_LABELS, EXCEPTION_RULES, EXCEPTION_TYPES } from "@/lib/exception-meta";
import { dateKeyOf, formatPunchTime, startOfTodayMs } from "@/lib/format";
import {
  allPermissions,
  countEnabled,
  parsePermissions,
  PERMISSION_KEYS,
  serializePermissions,
} from "@/lib/rbac";
import {
  haversineMetersRounded,
  methodAllowsMobile,
  normalizeClockingMethod,
} from "@/lib/geofence";
import { verifySessionToken } from "@/lib/session";
import type {
  AccessLevelDto,
  AccessLevelRow,
  AttendanceRecord,
  AttendanceSummary,
  BacklogEntry,
  BranchDto,
  BranchRow,
  ClockingMethod,
  DashboardMetrics,
  EmployeeImportItem,
  EmployeeImportResult,
  EmployeePunchRow,
  EmployeeRow,
  ErpBatchPayload,
  ErpLogRow,
  ErpSyncGetResponse,
  ErpSyncStatus,
  ExceptionRow,
  ExceptionsResponse,
  ExceptionType,
  FeedEntry,
  FeedRow,
  FieldTrackerCounts,
  FieldTrackerDevice,
  FieldTrackerSite,
  MyPortalPunch,
  PermissionKey,
  PermissionsMap,
  PunchDirection,
  ReportsAttendanceRow,
  ReportsBranchRow,
  ReportsEvent,
  ReportsExceptionKind,
  ReportsResponse,
  ReportsSummary,
  ReportsTrendPoint,
  ShiftRow,
  SyncBatchDto,
  SyncBatchRow,
  SyncStats,
  SystemAccountDto,
  SystemAccountRow,
  TerminalJoinedRow,
  TerminalRow,
  TerminalStatus,
  TimeOffRequestRow,
  VerifyResult,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Connection + low-level helpers                                      */
/* ------------------------------------------------------------------ */


/** Values accepted as bound parameters (name kept for existing callers). */
export type SQLInputValue = SqlValue;

/** Run a statement for its side effects. */
async function exec(db: Client, sql: string, ...params: SQLInputValue[]): Promise<void> {
  await db.execute({ sql, args: params });
}

/** Run a multi-statement script (DDL only — libSQL allows no bound params). */
async function execMulti(db: Client, sql: string): Promise<void> {
  await db.executeMultiple(sql);
}

/**
 * Run a statement and return its row count + generated rowid.
 *
 * The rowid comes from THIS statement's result: a follow-up
 * `SELECT last_insert_rowid()` is only reliable on a single connection, which
 * remote libSQL (Turso) does not guarantee — see the create* functions.
 */
async function run(
  db: Client,
  sql: string,
  ...params: SQLInputValue[]
): Promise<{ changes: number; lastId: number }> {
  const res = await db.execute({ sql, args: params });
  return { changes: Number(res.rowsAffected), lastId: Number(res.lastInsertRowid ?? 0) };
}

/** Run a SELECT and return every row. */
async function queryAll<T>(db: Client, sql: string, ...params: SQLInputValue[]): Promise<T[]> {
  const res = await db.execute({ sql, args: params });
  return res.rows as unknown as T[];
}

/** Run a SELECT and return the first row (undefined when there is none). */
async function queryOne<T>(
  db: Client,
  sql: string,
  ...params: SQLInputValue[]
): Promise<T | undefined> {
  const res = await db.execute({ sql, args: params });
  return res.rows[0] as unknown as T | undefined;
}

/** Run many statements in ONE round trip (remote-friendly bulk writes). */
async function batch(db: Client, statements: SqlStatement[]): Promise<void> {
  await executeBatch(db, statements);
}

/** WHERE-clause placeholder list: [1,2] → "?,?". */
function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

/** True when a column already exists on a table (idempotent migrations). */
async function columnExists(db: Client, table: string, column: string): Promise<boolean> {
  // Table-valued pragma: accepted by a local file AND by remote libSQL, where
  // the bare `PRAGMA table_info(x)` form is not.
  const rows = await queryAll<{ name: string }>(db, "SELECT name FROM pragma_table_info(?)", table);
  return rows.some((c) => c.name === column);
}

/** Add a column when an older data file predates it. */
async function ensureColumn(db: Client, table: string, column: string, ddl: string): Promise<void> {
  if (!(await columnExists(db, table, column))) {
    await exec(db, `ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * Sample content (roster, terminals, punch history) is OPT-IN.
 *
 * A live bridge must never invent people or punches: an empty console is
 * honest, a console full of fabricated staff is not. Set SEED_DEMO_DATA=true
 * only when you deliberately want the old first-run demo dataset.
 *
 * Reference configuration is always seeded regardless: the 13 real branches,
 * the standard shifts, the baseline access levels and the admin account.
 */
function seedDemoData(): boolean {
  return (process.env.SEED_DEMO_DATA ?? "").trim().toLowerCase() === "true";
}

/** Schema + seed. Runs once per process, before the first query. */
async function bootstrap(client: Client): Promise<void> {
  await migrate(client);
  await seedShifts(client);
  if (seedDemoData()) {
    await seedRoster(client);
    await seedTerminals(client);
  }
  await seedBranches(client);
  await seedAccessLevels(client);
  await ensureLiveMapPermission(client);
  await ensureTabletStationPermissionAndLevel(client);
  if (seedDemoData()) await ensureBranchCoverage(client);
  await backfillEmployeeMeta(client);
  await seedSystemAccounts(client);
  await ensureSeedAdmin(client);
  if (seedDemoData()) await seedAttendanceHistory(client);
}

// db.ts owns the schema; sqlite.ts owns the connection + bootstrap ordering.
setBootstrap(bootstrap);

/**
 * Open (and lazily initialise) the process-wide connection. Safe to call from
 * any route or background service at any time.
 *
 * Local dev/tests read a SQLite file; production reads remote Turso/libSQL.
 */
export function getDb(): Promise<Client> {
  return getReadyClient();
}

/** Raw-SQL helpers for route handlers that need them (identical semantics). */
export { exec as execSql, run as runSql, queryAll, queryOne, batch as batchSql };

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

async function migrate(db: Client): Promise<void> {
  await execMulti(db, `
    CREATE TABLE IF NOT EXISTS Employees (
      Employee_ID         INTEGER PRIMARY KEY AUTOINCREMENT,
      ERP_User_ID         TEXT    NOT NULL UNIQUE,
      Full_Name           TEXT    NOT NULL,
      Fingerprint_Enrolled INTEGER NOT NULL DEFAULT 0,
      Department          TEXT    NOT NULL DEFAULT '',
      Position            TEXT    NOT NULL DEFAULT '',
      Shift_ID            INTEGER,
      Status              TEXT    NOT NULL DEFAULT 'Active',
      Created_At          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Terminals (
      Terminal_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
      Terminal_MAC  TEXT    NOT NULL UNIQUE,
      IP_Address    TEXT    NOT NULL,
      Location_Name TEXT    NOT NULL,
      Status        TEXT    NOT NULL DEFAULT 'Offline',
      Last_Ping     INTEGER,
      Branch_Name   TEXT    NOT NULL DEFAULT '',
      Device_Name   TEXT,
      Clocking_Method        TEXT    NOT NULL DEFAULT 'Biometric',
      Latitude               REAL,
      Longitude              REAL,
      Geofence_Radius_Meters INTEGER
    );

    CREATE TABLE IF NOT EXISTS Attendance_Logs (
      Log_ID          INTEGER PRIMARY KEY AUTOINCREMENT,
      Employee_ID     INTEGER,               -- NULL = unrecognised device ID
      Timestamp       INTEGER NOT NULL,      -- epoch ms of the punch
      Terminal_ID     INTEGER,
      ERP_Sync_Status TEXT    NOT NULL DEFAULT 'Pending',
      Verify_Result   TEXT    NOT NULL DEFAULT 'Verified',
      Direction       TEXT    NOT NULL DEFAULT 'IN',
      Verify_Method   TEXT    NOT NULL DEFAULT 'Fingerprint',
      Raw_Payload     TEXT,
      Latitude                  REAL,        -- geofenced mobile punch (Phase 15)
      Longitude                 REAL,
      Location_Accuracy_Meters  INTEGER,
      Geofence_Distance_Meters  INTEGER,
      Created_At      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Erp_Sync_Batches (
      Batch_ID       INTEGER PRIMARY KEY AUTOINCREMENT,
      Created_At     INTEGER NOT NULL,
      Record_Count   INTEGER NOT NULL,
      Status         TEXT    NOT NULL,
      Response_Code  INTEGER,
      Error_Message  TEXT,
      Duration_MS    INTEGER,
      Trigger_Source TEXT    NOT NULL DEFAULT 'Auto',
      Payload_JSON   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Shifts (
      Shift_ID         INTEGER PRIMARY KEY AUTOINCREMENT,
      Name             TEXT    NOT NULL UNIQUE,
      Start_Time       TEXT    NOT NULL,
      End_Time         TEXT    NOT NULL,
      Duration_Minutes INTEGER NOT NULL,
      Days             TEXT    NOT NULL DEFAULT 'Mon,Tue,Wed,Thu,Fri',
      Created_At       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Branches (
      Branch_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
      Branch_Name TEXT    NOT NULL UNIQUE,
      Created_At  INTEGER NOT NULL,
      Clocking_Method        TEXT    NOT NULL DEFAULT 'Biometric',
      Latitude               REAL,
      Longitude              REAL,
      Geofence_Radius_Meters INTEGER
    );

    CREATE TABLE IF NOT EXISTS Access_Levels (
      Access_Level_ID  INTEGER PRIMARY KEY AUTOINCREMENT,
      Level_Name       TEXT    NOT NULL UNIQUE,
      Permissions_JSON TEXT    NOT NULL DEFAULT '{}',
      Created_At       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS System_Accounts (
      Account_ID      INTEGER PRIMARY KEY AUTOINCREMENT,
      First_Name      TEXT    NOT NULL,
      Surname         TEXT    NOT NULL,
      Company_Email   TEXT    NOT NULL UNIQUE,
      Password_Hash   TEXT    NOT NULL,
      Access_Level_ID INTEGER,
      Branch_ID       INTEGER,
      Employee_ID     INTEGER,
      Created_At      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS Time_Off_Requests (
      Request_ID  INTEGER PRIMARY KEY AUTOINCREMENT,
      Account_ID  INTEGER NOT NULL,
      Employee_ID INTEGER,
      Type        TEXT    NOT NULL,
      Start_Date  TEXT    NOT NULL,
      End_Date    TEXT    NOT NULL,
      Reason      TEXT,
      Status      TEXT    NOT NULL DEFAULT 'Pending',
      Created_At  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS App_Meta (
      Key   TEXT PRIMARY KEY,
      Value TEXT NOT NULL
    );

    -- Field Tracker: the latest location reported by a signed-in phone.
    -- Deliberately NOT a history table — one row per employee, overwritten.
    CREATE TABLE IF NOT EXISTS Employee_Presence (
      Employee_ID      INTEGER PRIMARY KEY,
      Latitude         REAL    NOT NULL,
      Longitude        REAL    NOT NULL,
      Accuracy_Meters  REAL,
      Branch_Name      TEXT,
      Device_ID        TEXT,
      Device_Name      TEXT,
      Source           TEXT    NOT NULL DEFAULT 'mobile',
      Last_Seen        INTEGER NOT NULL,
      Updated_At       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_emp  ON Attendance_Logs (Employee_ID, Timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_sync ON Attendance_Logs (ERP_Sync_Status, Log_ID);
    CREATE INDEX IF NOT EXISTS idx_logs_ts   ON Attendance_Logs (Timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tor_emp   ON Time_Off_Requests (Employee_ID);
    CREATE INDEX IF NOT EXISTS idx_presence_seen ON Employee_Presence (Last_Seen DESC);
  `);

  // Columns introduced by later phases — upgrade older data files in place.
  await ensureColumn(db, "Terminals", "Branch_Name", "Branch_Name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "Terminals", "Device_Name", "Device_Name TEXT");
  await ensureColumn(db, "Employees", "Position", "Position TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "Employees", "Shift_ID", "Shift_ID INTEGER");
  await ensureColumn(db, "Employees", "Status", "Status TEXT NOT NULL DEFAULT 'Active'");
  await ensureColumn(db, "Employees", "Branch_Name", "Branch_Name TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "Employees", "Fingers_Enrolled", "Fingers_Enrolled TEXT NOT NULL DEFAULT ''");

  // Phase 15 — Hands-Free Geofenced Mobile Clocking. The biometric path is
  // the default, so every pre-existing row lands on 'Biometric' (mobile off)
  // and only sites/devices an admin explicitly switches to Geofence/Both
  // will accept a GPS punch. These ALTERs are additive — the ADMS push
  // listener and the ERP payload are untouched.
  for (const table of ["Branches", "Terminals"] as const) {
    await ensureColumn(db, table, "Clocking_Method", "Clocking_Method TEXT NOT NULL DEFAULT 'Biometric'");
    await ensureColumn(db, table, "Latitude", "Latitude REAL");
    await ensureColumn(db, table, "Longitude", "Longitude REAL");
    await ensureColumn(db, table, "Geofence_Radius_Meters", "Geofence_Radius_Meters INTEGER");
  }
  await ensureColumn(db, "Attendance_Logs", "Latitude", "Latitude REAL");
  await ensureColumn(db, "Attendance_Logs", "Longitude", "Longitude REAL");
  await ensureColumn(db, "Attendance_Logs", "Location_Accuracy_Meters", "Location_Accuracy_Meters INTEGER");
  await ensureColumn(db, "Attendance_Logs", "Geofence_Distance_Meters", "Geofence_Distance_Meters INTEGER");
  // Phase 17 — a mobile punch may happen at ANY registered site (an employee
  // travelling between branches clocks in wherever they actually are), so the
  // governing site is recorded on the row itself rather than being inferable
  // only from the employee's roster branch. NULL for terminal/fingerprint
  // punches, whose site is already carried by Terminal_ID.
  await ensureColumn(db, "Attendance_Logs", "Branch_Name", "Branch_Name TEXT");

  // Phase 16 — BIOBRIDGE companion app sign-in. A *device* credential (an ATM
  // PIN, not a password) stored as a digest. NULL means "this employee has no
  // personal PIN yet, so the MOBILE_DEFAULT_PIN deployment value applies".
  // Purely additive — no existing flow reads this column.
  await ensureColumn(db, "Employees", "Mobile_PIN", "Mobile_PIN TEXT");

  // Phase 19 — Anti-Buddy Clocking (Hardware Device Binding).
  // Binds an employee's mobile sign-in to a single physical device (1-to-1) so
  // workers cannot sign in or clock in for each other on a different phone.
  await ensureColumn(db, "Employees", "Bound_Device_ID", "Bound_Device_ID TEXT");
  await ensureColumn(db, "Employees", "Bound_Device_Name", "Bound_Device_Name TEXT");
  await ensureColumn(db, "Employees", "Bound_Device_At", "Bound_Device_At INTEGER");
  await ensureColumn(db, "Attendance_Logs", "Device_ID", "Device_ID TEXT");
  await ensureColumn(db, "Attendance_Logs", "Device_Name", "Device_Name TEXT");
}

/* ------------------------------------------------------------------ */
/* Finger enrolment helpers                                            */
/* ------------------------------------------------------------------ */

/** "0,1,3" → [0, 1, 3] — tolerant of junk, always sorted + deduped. */
export function parseFingers(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const seen = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 4) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** [3, 0, 0] → "0,3" — the canonical storage form for Fingers_Enrolled. */
export function serializeFingers(fingers: readonly number[]): string {
  const seen = new Set<number>();
  for (const f of fingers) {
    if (Number.isInteger(f) && f >= 0 && f <= 4) seen.add(f);
  }
  return [...seen].sort((a, b) => a - b).join(",");
}

/* ------------------------------------------------------------------ */
/* Deterministic seed data                                             */
/* ------------------------------------------------------------------ */

/** Fixed creation stamp so a fresh install always yields identical rows. */
const SEED_CREATED_AT = 1791365078189; // 2026-10-06

interface SeedEmployee {
  erp: string;
  name: string;
  enrolled: 0 | 1;
  department: string;
  position: string;
  shiftId: number;
  /** Home branch written on the record (matches a BRANCH_TERMINALS site). */
  branch: string;
  /** How many fingers (thumb → little) are already captured on the device. */
  fingers: number;
}

/**
 * Live default roster — only Pride Admin (EMP1001).
 */
const SEED_EMPLOYEES: SeedEmployee[] = [
  { erp: "EMP1001", name: "Pride Admin", enrolled: 1, department: "IT", position: "Administrator", shiftId: 2, branch: "", fingers: 5 },
];

const LEGACY_DEMO_NAMES: string[] = [
  "Amara Okafor",
  "Daniel Whitfield",
  "Priya Raghunathan",
  "Marcus Delaney",
  "Sofia Castellanos",
  "Kwame Mensah",
  "Elena Petrova",
  "Jackson Rowe",
  "Fatima Al-Sayed",
  "Thomas Achebe",
  "Grace Lindqvist",
  "Rafael Moreno",
  "Hannah Kim",
  "Oliver Baptiste",
  "Nadia Volkova",
];

/** The first `count` fingers of a seed employee — thumb → little. */
function seedFingers(count: number): number[] {
  return Array.from({ length: Math.max(0, Math.min(5, count)) }, (_, i) => i);
}

interface SeedTerminal {
  branch: string;
  mac: string;
  ip: string;
  location: string;
  status: TerminalStatus;
  /** Phase 15 — optional demo clocking channel (defaults to Biometric). */
  clocking?: ClockingMethod;
}

/** Empty by default in production — admins register real terminals/branches. */
const BRANCH_TERMINALS: SeedTerminal[] = [];

interface SeedShift {
  id: number;
  name: string;
  start: string;
  end: string;
  duration: number;
  days: string;
}

/** Standard shift definitions — ids are pinned so Employees.Shift_ID is stable. */
const SEED_SHIFTS: SeedShift[] = [
  { id: 1, name: "Morning", start: "06:00", end: "14:00", duration: 480, days: "Mon,Tue,Wed,Thu,Fri" },
  { id: 2, name: "Day",     start: "08:00", end: "17:00", duration: 540, days: "Mon,Tue,Wed,Thu,Fri" },
  { id: 3, name: "Evening", start: "14:00", end: "22:00", duration: 480, days: "Mon,Tue,Wed,Thu,Fri" },
  { id: 4, name: "Night",   start: "22:00", end: "06:00", duration: 480, days: "Tue,Wed,Thu,Fri,Sat" },
];

async function seedShifts(db: Client): Promise<void> {
  const count = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Shifts"))?.c ?? 0;
  if (count > 0) return;
  await batch(
    db,
    SEED_SHIFTS.map((s) => ({
      sql: `INSERT INTO Shifts (Shift_ID, Name, Start_Time, End_Time, Duration_Minutes, Days, Created_At)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [s.id, s.name, s.start, s.end, s.duration, s.days, SEED_CREATED_AT],
    }))
  );
}

async function seedRoster(db: Client): Promise<void> {
  const count = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Employees"))?.c ?? 0;
  if (count > 0) return;
  await batch(
    db,
    SEED_EMPLOYEES.map((e) => ({
      sql: `INSERT INTO Employees
         (ERP_User_ID, Full_Name, Fingerprint_Enrolled, Fingers_Enrolled,
          Department, Position, Branch_Name, Shift_ID, Status, Created_At)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`,
      args: [
        e.erp,
        e.name,
        e.enrolled,
        e.enrolled ? serializeFingers(seedFingers(e.fingers)) : "",
        e.department,
        e.position,
        e.branch,
        e.shiftId,
        SEED_CREATED_AT,
      ],
    }))
  );
}

async function seedTerminals(db: Client): Promise<void> {
  const count = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Terminals"))?.c ?? 0;
  if (count > 0) return;
  const now = Date.now();
  await batch(
    db,
    BRANCH_TERMINALS.map((t) => ({
      sql: `INSERT INTO Terminals
         (Terminal_MAC, IP_Address, Location_Name, Branch_Name, Status, Last_Ping, Clocking_Method)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        t.mac,
        t.ip,
        t.location,
        t.branch,
        t.status,
        t.status === "Online" ? now : null,
        t.clocking ?? "Biometric",
      ],
    }))
  );
}

/**
 * Every branch must expose at least one terminal (Phase 10 grouping).
 * Re-seeds any branch whose devices were all removed.
 */
async function ensureBranchCoverage(db: Client): Promise<void> {
  const covered = new Set(
    (await queryAll<{ Branch_Name: string }>(
      db,
      "SELECT DISTINCT Branch_Name FROM Terminals WHERE Branch_Name <> ''"
    )).map((r) => r.Branch_Name)
  );
  const now = Date.now();
  for (const t of BRANCH_TERMINALS) {
    if (covered.has(t.branch)) continue;
    await exec(
      db,
      `INSERT OR IGNORE INTO Terminals
         (Terminal_MAC, IP_Address, Location_Name, Branch_Name, Status, Last_Ping)
       VALUES (?, ?, ?, ?, ?, ?)`,
      t.mac,
      t.ip,
      t.location,
      t.branch,
      t.status,
      t.status === "Online" ? now : null
    );
  }
}

/**
 * Fill the Phase 11 columns on rows created before the migration ran.
 * Matched on the demo roster's ERP ids so every employee keeps their own
 * position/shift; anything unknown falls back to a Department default.
 */
async function backfillEmployeeMeta(db: Client): Promise<void> {
  // 1. Purge legacy fake demo employees & their punches so only real staff (e.g. Pride Admin) remain
  if (!seedDemoData() && LEGACY_DEMO_NAMES.length > 0) {
    const namePlaceholders = placeholders(LEGACY_DEMO_NAMES.length);
    await exec(
      db,
      `DELETE FROM Attendance_Logs WHERE Employee_ID IN (SELECT Employee_ID FROM Employees WHERE Full_Name IN (${namePlaceholders}))`,
      ...LEGACY_DEMO_NAMES
    );
    await exec(
      db,
      `DELETE FROM Employees WHERE Full_Name IN (${namePlaceholders})`,
      ...LEGACY_DEMO_NAMES
    );
    // Purge legacy demo system accounts
    await exec(
      db,
      `DELETE FROM System_Accounts WHERE Company_Email IN ('hr@biobridge.example', 'sales@biobridge.example', 'worker@biobridge.example')`
    );
    // Purge legacy pre-seeded testing branches (SEED_CREATED_AT and Branch 1..17) while keeping user-created branches
    await exec(
      db,
      `DELETE FROM Terminals WHERE Branch_Name GLOB 'Branch [0-9]*' OR IP_Address LIKE '192.168.10.%' OR IP_Address LIKE '192.168.17.%'`
    );
    await exec(
      db,
      `DELETE FROM Branches WHERE Created_At = ? OR Branch_Name GLOB 'Branch [0-9]*'`,
      SEED_CREATED_AT
    );
  }

  // 2. Automatically convert any legacy ERP-xxxx / EMP-xxxx / ERP_xxxx / EMP_xxxx Employee IDs to EMPxxxx
  //    NOTE: Use GLOB (not LIKE) because '_' in SQLite LIKE is a single-character wildcard!
  await exec(
    db,
    `UPDATE OR IGNORE Employees
        SET ERP_User_ID = 'EMP' || substr(ERP_User_ID, 5)
      WHERE ERP_User_ID GLOB 'ERP-*'
         OR ERP_User_ID GLOB 'EMP-*'
         OR ERP_User_ID GLOB 'ERP_*'
         OR ERP_User_ID GLOB 'EMP_*'`
  );

  // 2b. Repair Pride Admin (and any employee whose ERP_User_ID was truncated to 'EMP' or 'EMP0*' by earlier LIKE '_')
  await exec(
    db,
    `UPDATE OR IGNORE Employees
        SET ERP_User_ID = 'EMP1001'
      WHERE (Full_Name = 'Pride Admin' OR ERP_User_ID = 'EMP' OR ERP_User_ID = 'EMP1' OR ERP_User_ID = 'EMP01' OR ERP_User_ID = 'EMP001')
        AND NOT EXISTS (SELECT 1 FROM Employees WHERE ERP_User_ID = 'EMP1001')`
  );
  await exec(
    db,
    `UPDATE OR IGNORE Employees
        SET ERP_User_ID = 'EMP' || (1000 + Employee_ID)
      WHERE ERP_User_ID = 'EMP' OR ERP_User_ID GLOB 'EMP0*'`
  );

  // 3. Ensure Pride Admin (EMP1001) exists if roster is completely empty
  const empCount = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Employees"))?.c ?? 0;
  if (empCount === 0) {
    await seedRoster(db);
  }

  // 3b. Ensure the admin System_Accounts row is linked to Pride Admin (EMP1001)
  const prideRow = await queryOne<{ id: number }>(
    db,
    "SELECT Employee_ID AS id FROM Employees WHERE ERP_User_ID = 'EMP1001' OR Full_Name = 'Pride Admin' LIMIT 1"
  );
  if (prideRow) {
    await exec(
      db,
      `UPDATE System_Accounts
          SET Employee_ID = ?, First_Name = 'Pride', Surname = 'Admin'
        WHERE lower(Company_Email) = 'admin@biobridge.com'
          AND (Employee_ID IS NULL OR Employee_ID <> ?)`,
      prideRow.id,
      prideRow.id
    );
  }

  if (seedDemoData()) {
    for (const e of SEED_EMPLOYEES) {
      await exec(
        db,
        `UPDATE Employees
            SET Position = ?, Shift_ID = ?, Status = 'Active'
          WHERE ERP_User_ID = ?
            AND (Position = '' OR Position IS NULL OR Shift_ID IS NULL)`,
        e.position,
        e.shiftId,
        e.erp
      );
    }
  }
  // Roster rows outside the demo seed: give them a sensible department default.
  const orphans = await queryAll<{ Employee_ID: number; Position: string }>(
    db,
    "SELECT Employee_ID, Position FROM Employees WHERE Shift_ID IS NULL OR Position = ''"
  );
  for (const o of orphans) {
    await exec(db, "UPDATE Employees SET Position = ?, Shift_ID = 2 WHERE Employee_ID = ?", o.Position || "Team Member", o.Employee_ID);
  }

  // Branch + captured fingers for the demo roster (idempotent: only fills
  // blanks, so an admin's edits on the enrolment page survive restarts —
  // clearing all fingers drops Fingerprint_Enrolled to 0, which also stops
  // this backfill from resurrecting them).
  if (seedDemoData()) {
    for (const e of SEED_EMPLOYEES) {
      if (e.branch) {
        await exec(
          db,
          "UPDATE Employees SET Branch_Name = ? WHERE ERP_User_ID = ? AND (Branch_Name IS NULL OR Branch_Name = '')",
          e.branch,
          e.erp
        );
      }
      if (e.enrolled && e.fingers > 0) {
        await exec(
          db,
          `UPDATE Employees SET Fingers_Enrolled = ?
            WHERE ERP_User_ID = ? AND Fingerprint_Enrolled = 1
              AND (Fingers_Enrolled IS NULL OR Fingers_Enrolled = '')`,
          serializeFingers(seedFingers(e.fingers)),
          e.erp
        );
      }
    }
  }
}

/**
 * Deterministic 6-day punch history for a brand-new install so timesheets,
 * attendance records and reports are populated on the very first render.
 * Never runs against an existing data file (the simulator keeps it alive).
 */
async function seedAttendanceHistory(db: Client): Promise<void> {
  const count = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Attendance_Logs"))?.c ?? 0;
  if (count > 0) return;

  // Small LCG — identical sequence for every fresh install.
  let state = 0x2f6e2b1;
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const randInt = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

  const employees = await queryAll<{ Employee_ID: number; ERP_User_ID: string; Fingerprint_Enrolled: number }>(
    db,
    "SELECT Employee_ID, ERP_User_ID, Fingerprint_Enrolled FROM Employees ORDER BY Employee_ID"
  );
  const terminals = await queryAll<{ Terminal_ID: number; Terminal_MAC: string; IP_Address: string }>(
    db,
    "SELECT Terminal_ID, Terminal_MAC, IP_Address FROM Terminals ORDER BY Terminal_ID"
  );
  if (employees.length === 0 || terminals.length === 0) return;

  const HOUR = 3_600_000;
  const MINUTE = 60_000;
  // Collect every row, then write them in ONE round trip. Sequential inserts
  // would be ~200 network round trips against a remote (Turso) database — and
  // a fire-and-forget insert could be cut off when a serverless function ends.
  const statements: SqlStatement[] = [];
  const insert = (
    employeeId: number,
    timestamp: number,
    terminalId: number,
    direction: PunchDirection,
    method: string,
    sync: "Pending" | "Success",
    ip: string,
    mac: string
  ) => {
    statements.push({
      sql: `INSERT INTO Attendance_Logs
         (Employee_ID, Timestamp, Terminal_ID, ERP_Sync_Status, Verify_Result, Direction, Verify_Method, Raw_Payload, Created_At)
       VALUES (?, ?, ?, ?, 'Verified', ?, ?, ?, ?)`,
      args: [
        employeeId,
        timestamp,
        terminalId,
        sync,
        direction,
        method,
        `ID=${employeeId}&Time=${formatPunchTime(timestamp)}&Status=0&Verify=1&IP=${ip}&MAC=${mac}`,
        timestamp,
      ],
    });
  };

  const today = startOfTodayMs();
  for (let back = 6; back >= 1; back--) {
    const dayStart = today - back * 86_400_000;
    const dow = new Date(dayStart).getDay();
    if (dow === 0) continue; // Sunday — the bridge classifies Mon–Sat only.

    for (const emp of employees) {
      if (emp.Fingerprint_Enrolled === 0 && rnd() < 0.75) continue; // mostly absent
      if (rnd() < 0.18) continue; // rest day / leave

      const term = pick(terminals);
      const method = rnd() < 0.12 ? "Card" : "Fingerprint";
      const sync: "Pending" | "Success" = rnd() < 0.9 ? "Success" : "Pending";

      const inMs = dayStart + 6 * HOUR + randInt(30, 120) * MINUTE;
      const lunchOut = inMs + (4 * HOUR + randInt(0, 60)) * MINUTE;
      const lunchIn = lunchOut + randInt(35, 65) * MINUTE;
      const outMs = lunchIn + (3 * HOUR + randInt(0, 90)) * MINUTE;

      insert(emp.Employee_ID, inMs, term.Terminal_ID, "IN", method, sync, term.IP_Address, term.Terminal_MAC);
      insert(emp.Employee_ID, lunchOut, term.Terminal_ID, "OUT", method, sync, term.IP_Address, term.Terminal_MAC);
      insert(emp.Employee_ID, lunchIn, term.Terminal_ID, "IN", method, sync, term.IP_Address, term.Terminal_MAC);
      if (rnd() > 0.08) {
        insert(emp.Employee_ID, outMs, term.Terminal_ID, "OUT", method, sync, term.IP_Address, term.Terminal_MAC);
      }
    }
  }

  if (statements.length > 0) {
    await batch(db, statements);
  }
}

/* ------------------------------------------------------------------ */
/* Phase 13/14 — relational settings & access control                  */
/* ------------------------------------------------------------------ */

/**
 * The real field sites — the only branches a fresh install seeds. All ship as
 * "Both" (biometric + mobile geofence) so a phone can clock in on site. Radius
 * defaults to 150 m; the tightest site (Junkshop) uses 100 m because its
 * neighbours are close together.
 */
const SEED_REAL_BRANCHES: Record<
  string,
  { lat: number; lng: number; radius: number }
> = {
  Belmont: { lat: -20.1725, lng: 28.5752, radius: 150 },
  Tongogara: { lat: -20.1503, lng: 28.5898, radius: 150 },
  Junkshop: { lat: -20.1486, lng: 28.587, radius: 100 },
  Maphisa: { lat: -21.0648, lng: 28.4586, radius: 150 },
  "Esigodini 2": { lat: -20.2932, lng: 28.9385, radius: 150 },
  Habane: { lat: -20.3123, lng: 28.9426, radius: 150 },
  Mthwakazi: { lat: -20.5455, lng: 29.2762, radius: 150 },
  Mswela: { lat: -20.5337, lng: 29.2889, radius: 150 },
  "Filabusi Mainshop": { lat: -20.5264, lng: 29.2981, radius: 150 },
  "Gwanda VID": { lat: -20.9378, lng: 29.0092, radius: 150 },
  Thobelani: { lat: -20.9431, lng: 29.0057, radius: 150 },
  "Gweru MMS": { lat: -19.4468, lng: 29.8142, radius: 150 },
  "Gweru EazyTools": { lat: -19.4484, lng: 29.8103, radius: 150 },
};

/** Deterministic password digest for demo accounts (sha256, static salt). */
export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(`${password}::biobridge-salt`).digest("hex");
}

/** Constant behaviour comparison for the digest above. */
export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

async function seedBranches(db: Client): Promise<void> {
  if (!seedDemoData()) return;
  const count = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Branches"))?.c ?? 0;
  if (count > 0) return;
  // Only the real field sites are seeded, each geofenced ("Both") so a phone can
  // clock in on site. Idempotent: a branch of the same name is left untouched
  // (never duplicated).
  const statements: SqlStatement[] = [];
  for (const [name, geo] of Object.entries(SEED_REAL_BRANCHES)) {
    const existing = await queryOne<{ id: number }>(
      db,
      "SELECT Branch_ID AS id FROM Branches WHERE Branch_Name = ?",
      name
    );
    if (existing) continue;
    statements.push({
      sql: `INSERT INTO Branches
         (Branch_Name, Created_At, Clocking_Method, Latitude, Longitude, Geofence_Radius_Meters)
       VALUES (?, ?, ?, ?, ?, ?)`,
      args: [name, SEED_CREATED_AT, "Both", geo.lat, geo.lng, geo.radius],
    });
  }
  if (statements.length > 0) {
    await batch(db, statements);
  }
}

/** Start every level from "nothing allowed" and switch on its key set. */
function levelWith(...keys: PermissionKey[]): PermissionsMap {
  const map = allPermissions(false);
  for (const key of keys) map[key] = true;
  return map;
}

interface SeedAccessLevel {
  name: string;
  perms: PermissionsMap;
}

/**
 * Baseline roles for the Access Level Matrix. The IT Administrator owns
 * every capability; the Worker only sees My Portal — the exact split the
 * sidebar + settings rendering use to demonstrate granular RBAC.
 */
const SEED_ACCESS_LEVELS: SeedAccessLevel[] = [
  { name: "IT Administrator", perms: allPermissions(true) },
  {
    name: "HR Manager",
    perms: levelWith(
      "can_view_dashboard",
      "can_view_employees",
      "can_add_employee",
      "can_edit_employee",
      "can_delete_employee",
      "can_manage_fingerprints",
      "can_view_attendance",
      "can_manage_shifts",
      "can_view_reports",
      "can_export_reports",
      "can_view_exceptions",
      "can_view_whos_in",
      "can_view_live_map",
      "can_view_devices",
      "can_view_sync",
      "can_view_settings",
      "can_edit_settings",
      "can_manage_branches",
      "can_add_accounts"
      // deliberately NO can_manage_access_levels / can_config_devices —
      // the Settings tab bar hides Access Levels + Biometric Device for HR
    ),
  },
  {
    name: "Sales Manager",
    perms: levelWith(
      "can_view_dashboard",
      "can_view_employees",
      "can_view_reports",
      "can_export_reports",
      "can_view_exceptions",
      "can_view_whos_in",
      "can_view_devices"
      // no attendance / shifts / settings / accounts
    ),
  },
  {
    name: "Worker",
    perms: levelWith(
      "can_view_my_portal",
      "can_remote_clock",
      "can_view_my_history",
      "can_request_time_off"
    ),
  },
  {
    name: "Tablet Station",
    perms: levelWith(
      "can_view_tablet_station"
    ),
  },
];

async function seedAccessLevels(db: Client): Promise<void> {
  const count = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Access_Levels"))?.c ?? 0;
  if (count > 0) return;
  await batch(
    db,
    SEED_ACCESS_LEVELS.map((lvl) => ({
      sql: "INSERT INTO Access_Levels (Level_Name, Permissions_JSON, Created_At) VALUES (?, ?, ?)",
      args: [lvl.name, serializePermissions(lvl.perms), SEED_CREATED_AT],
    }))
  );
}

/**
 * Field Tracker is gated by a NEW capability (`can_view_live_map`). Existing
 * databases already hold a serialised permissions JSON without that key, and
 * `parsePermissions` defaults unknown keys to false — so an already-seeded IT
 * Administrator would silently lose access to the new page.
 *
 * Grant it to the built-in administrator exactly once (App_Meta marker). Other
 * levels stay untouched: an admin can switch it on per level in Settings →
 * Access Levels, which is the point of a dedicated permission.
 */
const LIVE_MAP_PERMISSION_MARKER = "perm_live_map_v1";

async function ensureLiveMapPermission(db: Client): Promise<void> {
  const done = await queryOne<{ v: string }>(
    db,
    "SELECT Value AS v FROM App_Meta WHERE Key = ?",
    LIVE_MAP_PERMISSION_MARKER
  );
  if (done) return;

  const admin = await queryOne<{ id: number; json: string }>(
    db,
    "SELECT Access_Level_ID AS id, Permissions_JSON AS json FROM Access_Levels WHERE Level_Name = ?",
    "IT Administrator"
  );
  if (admin) {
    const perms = parsePermissions(admin.json);
    if (!perms.can_view_live_map) {
      perms.can_view_live_map = true;
      await run(
        db,
        "UPDATE Access_Levels SET Permissions_JSON = ? WHERE Access_Level_ID = ?",
        serializePermissions(perms),
        admin.id
      );
    }
  }

  await run(
    db,
    "INSERT OR REPLACE INTO App_Meta (Key, Value) VALUES (?, ?)",
    LIVE_MAP_PERMISSION_MARKER,
    String(Date.now())
  );
}

const TABLET_STATION_PERMISSION_MARKER = "perm_tablet_station_v1";

async function ensureTabletStationPermissionAndLevel(db: Client): Promise<void> {
  const done = await queryOne<{ v: string }>(
    db,
    "SELECT Value AS v FROM App_Meta WHERE Key = ?",
    TABLET_STATION_PERMISSION_MARKER
  );
  if (done) return;

  // 1. Grant to IT Administrator so admins can view and configure the tablet station
  const admin = await queryOne<{ id: number; json: string }>(
    db,
    "SELECT Access_Level_ID AS id, Permissions_JSON AS json FROM Access_Levels WHERE Level_Name = ?",
    "IT Administrator"
  );
  if (admin) {
    const perms = parsePermissions(admin.json);
    if (!perms.can_view_tablet_station) {
      perms.can_view_tablet_station = true;
      await run(
        db,
        "UPDATE Access_Levels SET Permissions_JSON = ? WHERE Access_Level_ID = ?",
        serializePermissions(perms),
        admin.id
      );
    }
  }

  // 2. Ensure "Tablet Station" access level exists
  const existingLevel = await queryOne<{ id: number }>(
    db,
    "SELECT Access_Level_ID AS id FROM Access_Levels WHERE Level_Name = ?",
    "Tablet Station"
  );
  if (!existingLevel) {
    const tabletPerms = levelWith("can_view_tablet_station");
    await run(
      db,
      "INSERT INTO Access_Levels (Level_Name, Permissions_JSON, Created_At) VALUES (?, ?, ?)",
      "Tablet Station",
      serializePermissions(tabletPerms),
      Date.now()
    );
  }

  await run(
    db,
    "INSERT OR REPLACE INTO App_Meta (Key, Value) VALUES (?, ?)",
    TABLET_STATION_PERMISSION_MARKER,
    String(Date.now())
  );
}

interface SeedAccount {
  first: string;
  surname: string;
  email: string;
  password: string;
  level: string;
  branch: string;
  /** Optional Employees.ERP_User_ID linking the account to a roster row. */
  employeeErp: string | null;
}

/**
 * The seeded logins.
 *
 * `SEED_ADMIN` always exists so a fresh install is usable, with the
 * `admin@biobridge.com` / `admin` credentials requested by the owner.
 * `ensureSeedAdmin` also repairs older databases (legacy email or an unknown
 * hash). The password can be changed afterwards from Settings -> Accounts.
 * The three demo accounts are seeded on a normal host and skipped on
 * serverless, unless BIOBRIDGE_SEED_DEMO_ACCOUNTS=true.
 */
const SEED_ADMIN: SeedAccount = {
  first: "Pride",
  surname: "Admin",
  email: "admin@biobridge.com",
  password: "admin",
  level: "IT Administrator",
  branch: "",
  employeeErp: "EMP1001",
};

const SEED_DEMO_ACCOUNTS: SeedAccount[] = [];

/** Demo logins: explicit flag wins, else on for a normal host and off serverless. */
function includeDemoAccounts(): boolean {
  const flag = (process.env.BIOBRIDGE_SEED_DEMO_ACCOUNTS ?? "").trim().toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  return !isServerlessRuntime();
}

/** The accounts to seed, with the admin password resolved for this runtime. */
function seededAccounts(): SeedAccount[] {
  const accounts: SeedAccount[] = [];
  // The owner asked for a predictable admin login (admin@biobridge.com / admin).
  // It can be changed afterwards from Settings -> Accounts.
  accounts.push(SEED_ADMIN);
  if (includeDemoAccounts()) accounts.push(...SEED_DEMO_ACCOUNTS);
  return accounts;
}

async function seedSystemAccounts(db: Client): Promise<void> {
  const count = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM System_Accounts"))?.c ?? 0;
  if (count > 0) return;

  const levelId = async (name: string): Promise<number | null> =>
    (await queryOne<{ id: number }>(db, "SELECT Access_Level_ID AS id FROM Access_Levels WHERE Level_Name = ?", name))?.id ?? null;
  const branchId = async (name: string): Promise<number | null> =>
    (await queryOne<{ id: number }>(db, "SELECT Branch_ID AS id FROM Branches WHERE Branch_Name = ?", name))?.id ?? null;
  const employeeId = async (erp: string | null): Promise<number | null> =>
    erp ? ((await queryOne<{ id: number }>(db, "SELECT Employee_ID AS id FROM Employees WHERE ERP_User_ID = ?", erp))?.id ?? null) : null;

  const statements: SqlStatement[] = [];
  for (const a of seededAccounts()) {
    statements.push({
      sql: `INSERT INTO System_Accounts
         (First_Name, Surname, Company_Email, Password_Hash, Access_Level_ID, Branch_ID, Employee_ID, Created_At)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        a.first,
        a.surname,
        a.email,
        hashPassword(a.password),
        await levelId(a.level),
        await branchId(a.branch),
        await employeeId(a.employeeErp),
        SEED_CREATED_AT,
      ],
    });
  }
  await batch(db, statements);
}

/**
 * Guarantee the built-in administrator exists at `admin@biobridge.com` with the
 * requested password, whatever state the database was in before:
 *
 *   • new email already present  → reset its password (unknown legacy hash)
 *   • old `admin@biobridge.example` present → rename it + reset the password
 *   • neither present            → create the account
 *
 * Runs once per database (marker in App_Meta) so a password changed later from
 * Settings → Accounts is not reverted on every restart/cold start.
 */
const ADMIN_LOGIN_MARKER = "admin_login_v2";

async function ensureSeedAdmin(db: Client): Promise<void> {
  const done = await queryOne<{ v: string }>(
    db,
    "SELECT Value AS v FROM App_Meta WHERE Key = ?",
    ADMIN_LOGIN_MARKER
  );
  if (done) return;

  const hash = hashPassword(SEED_ADMIN.password);
  const existing = await queryOne<{ id: number }>(
    db,
    "SELECT Account_ID AS id FROM System_Accounts WHERE lower(Company_Email) = ?",
    SEED_ADMIN.email.toLowerCase()
  );

  if (existing) {
    await run(
      db,
      "UPDATE System_Accounts SET Password_Hash = ? WHERE Account_ID = ?",
      hash,
      existing.id
    );
  } else {
    const legacy = await queryOne<{ id: number }>(
      db,
      "SELECT Account_ID AS id FROM System_Accounts WHERE lower(Company_Email) = ?",
      "admin@biobridge.example"
    );
    if (legacy) {
      await run(
        db,
        "UPDATE System_Accounts SET Company_Email = ?, Password_Hash = ? WHERE Account_ID = ?",
        SEED_ADMIN.email,
        hash,
        legacy.id
      );
    } else {
      const levelId =
        (
          await queryOne<{ id: number }>(
            db,
            "SELECT Access_Level_ID AS id FROM Access_Levels WHERE Level_Name = ?",
            SEED_ADMIN.level
          )
        )?.id ?? null;
      const inserted = await run(
        db,
        `INSERT INTO System_Accounts
           (First_Name, Surname, Company_Email, Password_Hash, Access_Level_ID, Branch_ID, Employee_ID, Created_At)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
        SEED_ADMIN.first,
        SEED_ADMIN.surname,
        SEED_ADMIN.email,
        hash,
        levelId,
        SEED_CREATED_AT
      );
      // If the insert was rejected, leave the marker unset so the next boot retries.
      if (!inserted.changes) return;
    }
  }

  await run(
    db,
    "INSERT OR REPLACE INTO App_Meta (Key, Value) VALUES (?, ?)",
    ADMIN_LOGIN_MARKER,
    String(Date.now())
  );
}

/* ------------------------------------------------------------------ */
/* Branches (Phase 13 — Settings tab 1)                                */
/* ------------------------------------------------------------------ */

/** Branch list with live headcounts (employees + terminals) per site. */
export async function listBranches(): Promise<BranchDto[]> {
  const db = await getDb();
  const rows = await queryAll<BranchRow>(db, "SELECT * FROM Branches ORDER BY Branch_ID");
  const employees = await queryAll<{ Branch_Name: string; c: number }>(
    db,
    "SELECT Branch_Name, COUNT(*) AS c FROM Employees WHERE Branch_Name <> '' GROUP BY Branch_Name"
  );
  const terminals = await queryAll<{ Branch_Name: string; c: number }>(
    db,
    "SELECT Branch_Name, COUNT(*) AS c FROM Terminals WHERE Branch_Name <> '' GROUP BY Branch_Name"
  );
  const empMap = new Map(employees.map((r) => [r.Branch_Name, r.c]));
  const termMap = new Map(terminals.map((r) => [r.Branch_Name, r.c]));
  return rows.map((r) => ({
    id: r.Branch_ID,
    name: r.Branch_Name,
    employeeCount: empMap.get(r.Branch_Name) ?? 0,
    terminalCount: termMap.get(r.Branch_Name) ?? 0,
    createdAt: r.Created_At,
    clockingMethod: normalizeClockingMethod(r.Clocking_Method),
    latitude: r.Latitude,
    longitude: r.Longitude,
    geofenceRadiusMeters: r.Geofence_Radius_Meters,
  }));
}

/** The flat site names ("Branch 1" …) — branch dropdowns merge this with "Unassigned". */
export async function listBranchNames(): Promise<string[]> {
  return (await queryAll<BranchRow>(await getDb(), "SELECT * FROM Branches ORDER BY Branch_ID")).map((r) => r.Branch_Name);
}

/** One branch row by exact (case-insensitive) name — the geofence lookup. */
export async function branchByName(name: string | null | undefined): Promise<BranchRow | null> {
  const value = (name ?? "").trim();
  if (!value) return null;
  return (
    await queryOne<BranchRow>(
      await getDb(),
      "SELECT * FROM Branches WHERE Branch_Name COLLATE NOCASE = ?",
      value
    ) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* Phase 15 — clocking method + geofence on Branches/Terminals          */
/* ------------------------------------------------------------------ */

/**
 * Partial geofence configuration. Every field is optional: omitted values are
 * left untouched, explicit `null` clears the stored value.
 */
export interface ClockingConfigInput {
  clockingMethod?: ClockingMethod;
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusMeters?: number | null;
}

/** Coerce an untrusted numeric (null/""/NaN → null, else the finite number). */
function coerceCoord(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function createBranch(name: string, clocking?: ClockingConfigInput): Promise<number> {
  const db = await getDb();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Branch name is required.");
  const method = normalizeClockingMethod(clocking?.clockingMethod);
  const lat = coerceCoord(clocking?.latitude);
  const lng = coerceCoord(clocking?.longitude);
  const radius = coerceCoord(clocking?.geofenceRadiusMeters);
  const { lastId } = await run(
    db,
    `INSERT INTO Branches
       (Branch_Name, Created_At, Clocking_Method, Latitude, Longitude, Geofence_Radius_Meters)
     VALUES (?, ?, ?, ?, ?, ?)`,
    trimmed,
    Date.now(),
    method,
    lat,
    lng,
    radius
  );
  if (clocking && (clocking.clockingMethod !== undefined || lat !== null || radius !== null)) {
    await exec(
      db,
      `UPDATE Terminals
          SET Clocking_Method = ?, Latitude = ?, Longitude = ?, Geofence_Radius_Meters = ?
        WHERE Branch_Name COLLATE NOCASE = ?`,
      method,
      lat,
      lng,
      radius,
      trimmed
    );
  }
  return lastId;
}

/** Set/clear a site's clocking method + geofence centre (Phase 15). */
export async function setBranchClocking(branchId: number, input: ClockingConfigInput): Promise<void> {
  const db = await getDb();
  const current = await queryOne<BranchRow>(db, "SELECT * FROM Branches WHERE Branch_ID = ?", branchId);
  if (!current) throw new Error("That branch no longer exists.");
  const method =
    input.clockingMethod !== undefined
      ? normalizeClockingMethod(input.clockingMethod)
      : normalizeClockingMethod(current.Clocking_Method);
  const lat = input.latitude !== undefined ? coerceCoord(input.latitude) : current.Latitude;
  const lng = input.longitude !== undefined ? coerceCoord(input.longitude) : current.Longitude;
  const radius =
    input.geofenceRadiusMeters !== undefined
      ? coerceCoord(input.geofenceRadiusMeters)
      : current.Geofence_Radius_Meters;
  await exec(
    db,
    `UPDATE Branches
        SET Clocking_Method = ?, Latitude = ?, Longitude = ?, Geofence_Radius_Meters = ?
      WHERE Branch_ID = ?`,
    method,
    lat,
    lng,
    radius,
    branchId
  );
  if (current.Branch_Name) {
    await exec(
      db,
      `UPDATE Terminals
          SET Clocking_Method = ?, Latitude = ?, Longitude = ?, Geofence_Radius_Meters = ?
        WHERE Branch_Name COLLATE NOCASE = ?`,
      method,
      lat,
      lng,
      radius,
      current.Branch_Name
    );
  }
}

/** Rename a site and keep the denormalised Employees/Terminals in sync. */
export async function renameBranch(branchId: number, name: string): Promise<void> {
  const db = await getDb();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Branch name is required.");
  const current = await queryOne<BranchRow>(db, "SELECT * FROM Branches WHERE Branch_ID = ?", branchId);
  if (!current) throw new Error("That branch no longer exists.");
  if (trimmed === current.Branch_Name) return;
  await exec(db, "UPDATE Employees SET Branch_Name = ? WHERE Branch_Name = ?", trimmed, current.Branch_Name);
  await exec(db, "UPDATE Terminals SET Branch_Name = ? WHERE Branch_Name = ?", trimmed, current.Branch_Name);
  await exec(db, "UPDATE Branches SET Branch_Name = ? WHERE Branch_ID = ?", trimmed, branchId);
}

/** Remove a site; records that referenced it fall back to "Unassigned" (""). */
export async function deleteBranch(branchId: number): Promise<boolean> {
  const db = await getDb();
  const current = await queryOne<BranchRow>(db, "SELECT * FROM Branches WHERE Branch_ID = ?", branchId);
  if (!current) return false;
  await exec(db, "UPDATE Employees SET Branch_Name = '' WHERE Branch_Name = ?", current.Branch_Name);
  await exec(db, "UPDATE Terminals SET Branch_Name = '' WHERE Branch_Name = ?", current.Branch_Name);
  await exec(db, "DELETE FROM Branches WHERE Branch_ID = ?", branchId);
  return true;
}

/* ------------------------------------------------------------------ */
/* Access Levels (Phase 13 — Settings tab 2 / the Matrix)              */
/* ------------------------------------------------------------------ */

/** Every level with its parsed matrix + how many accounts hold it. */
export async function listAccessLevels(): Promise<AccessLevelDto[]> {
  const db = await getDb();
  const rows = await queryAll<AccessLevelRow>(db, "SELECT * FROM Access_Levels ORDER BY Access_Level_ID");
  const counts = await queryAll<{ Access_Level_ID: number; c: number }>(
    db,
    "SELECT Access_Level_ID, COUNT(*) AS c FROM System_Accounts GROUP BY Access_Level_ID"
  );
  const countMap = new Map(counts.map((r) => [r.Access_Level_ID, r.c]));
  return rows.map((r) => {
    const permissions = parsePermissions(JSON.parse(r.Permissions_JSON || "{}"));
    return {
      id: r.Access_Level_ID,
      name: r.Level_Name,
      permissions,
      enabled: countEnabled(permissions),
      total: PERMISSION_KEYS.length,
      accountCount: countMap.get(r.Access_Level_ID) ?? 0,
      createdAt: r.Created_At,
    };
  });
}

/** A single level with its parsed matrix + account count — the matrix GET. */
export async function accessLevelById(levelId: number): Promise<AccessLevelDto | null> {
  const db = await getDb();
  const row = await queryOne<AccessLevelRow>(db, "SELECT * FROM Access_Levels WHERE Access_Level_ID = ?", levelId);
  if (!row) return null;
  const permissions = parsePermissions(row.Permissions_JSON);
  const accountCount =
    (await queryOne<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM System_Accounts WHERE Access_Level_ID = ?",
      levelId
    ))?.c ?? 0;
  return {
    id: row.Access_Level_ID,
    name: row.Level_Name,
    permissions,
    enabled: countEnabled(permissions),
    total: PERMISSION_KEYS.length,
    accountCount,
    createdAt: row.Created_At,
  };
}

/** New level starts with every capability off — the IT admin ticks the matrix. */
export async function createAccessLevel(name: string, permissions?: PermissionsMap): Promise<number> {
  const db = await getDb();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Access level name is required.");
  const perms = parsePermissions(permissions);
  const { lastId } = await run(
    db,
    "INSERT INTO Access_Levels (Level_Name, Permissions_JSON, Created_At) VALUES (?, ?, ?)",
    trimmed,
    serializePermissions(perms),
    Date.now()
  );
  return lastId;
}

export interface AccessLevelPatch {
  name?: string;
  permissions?: PermissionsMap;
}

export async function updateAccessLevel(levelId: number, patch: AccessLevelPatch): Promise<void> {
  const db = await getDb();
  const current = await queryOne<AccessLevelRow>(db, "SELECT * FROM Access_Levels WHERE Access_Level_ID = ?", levelId);
  if (!current) throw new Error("That access level no longer exists.");
  const name = patch.name !== undefined ? patch.name.trim() : current.Level_Name;
  if (!name) throw new Error("Access level name is required.");
  const json =
    patch.permissions !== undefined
      ? serializePermissions(parsePermissions(patch.permissions))
      : current.Permissions_JSON;
  await exec(db, "UPDATE Access_Levels SET Level_Name = ?, Permissions_JSON = ? WHERE Access_Level_ID = ?", name, json, levelId);
}

/** Levels still attached to accounts cannot be removed (avoid orphans). */
export async function deleteAccessLevel(levelId: number): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  const current = await queryOne<AccessLevelRow>(db, "SELECT * FROM Access_Levels WHERE Access_Level_ID = ?", levelId);
  if (!current) return { ok: false, reason: "That access level no longer exists." };
  const used = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM System_Accounts WHERE Access_Level_ID = ?", levelId))?.c ?? 0;
  if (used > 0) {
    return {
      ok: false,
      reason: `${used} system account${used === 1 ? "" : "s"} still use this level — reassign them first.`,
    };
  }
  await exec(db, "DELETE FROM Access_Levels WHERE Access_Level_ID = ?", levelId);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* System Accounts (Phase 13 — Settings tab 3)                         */
/* ------------------------------------------------------------------ */

/** Account rows joined with level / branch / linked employee names. */
export interface SystemAccountJoinedRow extends SystemAccountRow {
  Level_Name: string | null;
  Branch_Name: string | null;
  Employee_Name: string | null;
}

export async function listSystemAccounts(): Promise<SystemAccountDto[]> {
  const db = await getDb();
  const rows = await queryAll<SystemAccountJoinedRow>(
    db,
    `SELECT a.*, l.Level_Name, b.Branch_Name, e.Full_Name AS Employee_Name
       FROM System_Accounts a
       LEFT JOIN Access_Levels l ON l.Access_Level_ID = a.Access_Level_ID
       LEFT JOIN Branches b     ON b.Branch_ID     = a.Branch_ID
       LEFT JOIN Employees e    ON e.Employee_ID   = a.Employee_ID
      ORDER BY a.Account_ID`
  );
  return rows.map((r) => ({
    id: r.Account_ID,
    firstName: r.First_Name,
    surname: r.Surname,
    name: `${r.First_Name} ${r.Surname}`.trim(),
    email: r.Company_Email,
    accessLevelId: r.Access_Level_ID,
    levelName: r.Level_Name,
    branchId: r.Branch_ID,
    branchName: r.Branch_Name,
    employeeId: r.Employee_ID,
    employeeName: r.Employee_Name,
    createdAt: r.Created_At,
  }));
}

export interface SystemAccountInput {
  firstName: string;
  surname: string;
  email: string;
  password: string;
  accessLevelId: number | null;
  branchId: number | null;
  employeeId: number | null;
}

export async function createSystemAccount(input: SystemAccountInput): Promise<number> {
  const db = await getDb();
  const first = (input.firstName ?? "").trim();
  const surname = (input.surname ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const password = input.password ?? "";
  if (!first || !surname || !email || !password) {
    throw new Error("First name, surname, email and password are required.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid company email address.");
  }
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }
  const refError = await checkAccountReferences(db, input.accessLevelId, input.branchId, input.employeeId);
  if (refError) {
    throw new Error(refError);
  }
  const { lastId } = await run(
    db,
    `INSERT INTO System_Accounts
       (First_Name, Surname, Company_Email, Password_Hash, Access_Level_ID, Branch_ID, Employee_ID, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    first,
    surname,
    email,
    hashPassword(password),
    input.accessLevelId,
    input.branchId,
    input.employeeId,
    Date.now()
  );
  return lastId;
}

/** Remove an account (guarded: the built-in bridge administrator stays). */
export async function deleteSystemAccount(accountId: number): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  const row = await queryOne<SystemAccountRow>(db, "SELECT * FROM System_Accounts WHERE Account_ID = ?", accountId);
  if (!row) return { ok: false, reason: "That account no longer exists." };
  if (
    ["admin@biobridge.com", "admin@biobridge.example"].includes(
      row.Company_Email.toLowerCase()
    )
  ) {
    return { ok: false, reason: "The built-in bridge administrator cannot be removed." };
  }
  await exec(db, "DELETE FROM Time_Off_Requests WHERE Account_ID = ?", accountId);
  await exec(db, "DELETE FROM System_Accounts WHERE Account_ID = ?", accountId);
  return { ok: true };
}

/**
 * A partial account update from the unified Add / Edit form. Only the keys
 * actually present are applied, so an edit that leaves the password fields
 * blank keeps the current credential untouched.
 */
export interface SystemAccountPatch {
  firstName?: string;
  surname?: string;
  email?: string;
  accessLevelId?: number | null;
  branchId?: number | null;
  employeeId?: number | null;
  /** New plaintext password — undefined or "" keeps the existing credential. */
  password?: string;
}

/**
 * Validate the optional level / branch / employee references. This schema
 * never enables SQLite foreign-key enforcement, so we check the parent rows
 * by hand and return a friendly message when one has disappeared.
 */
async function checkAccountReferences(
  db: Client,
  accessLevelId: number | null,
  branchId: number | null,
  employeeId: number | null
): Promise<string | null> {
  if (
    accessLevelId != null &&
    !await queryOne<{ ok: number }>(db, "SELECT 1 AS ok FROM Access_Levels WHERE Access_Level_ID = ?", accessLevelId)
  ) {
    return "That access level no longer exists.";
  }
  if (
    branchId != null &&
    !await queryOne<{ ok: number }>(db, "SELECT 1 AS ok FROM Branches WHERE Branch_ID = ?", branchId)
  ) {
    return "That branch no longer exists.";
  }
  if (
    employeeId != null &&
    !await queryOne<{ ok: number }>(db, "SELECT 1 AS ok FROM Employees WHERE Employee_ID = ?", employeeId)
  ) {
    return "That linked employee no longer exists.";
  }
  return null;
}

/**
 * Update an existing account (the Edit mode of the unified form). The account
 * is identified by its numeric id — never by the displayed name or email.
 *
 *  • Required fields, email format + uniqueness and every FK reference are
 *    re-validated here, so the API is authoritative regardless of the client.
 *  • The password is re-hashed **only** when an explicit non-empty value is
 *    supplied: a blank password can never overwrite the stored digest.
 */
export async function updateSystemAccount(
  accountId: number,
  patch: SystemAccountPatch
): Promise<{ ok: boolean; reason?: string }> {
  const db = await getDb();
  const row = await systemAccountById(accountId);
  if (!row) return { ok: false, reason: "That account no longer exists." };

  const first = (patch.firstName !== undefined ? String(patch.firstName) : row.First_Name).trim();
  const surname = (patch.surname !== undefined ? String(patch.surname) : row.Surname).trim();
  const email = (patch.email !== undefined ? String(patch.email) : row.Company_Email).trim().toLowerCase();

  if (!first || !surname || !email) {
    return { ok: false, reason: "First name, surname and company email are required." };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: "Enter a valid company email address." };
  }

  const clash = await queryOne<{ Account_ID: number }>(
    db,
    "SELECT Account_ID FROM System_Accounts WHERE Company_Email = ? COLLATE NOCASE AND Account_ID <> ?",
    email,
    accountId
  );
  if (clash) return { ok: false, reason: "An account with that company email already exists." };

  const accessLevelId = patch.accessLevelId !== undefined ? patch.accessLevelId : row.Access_Level_ID;
  const branchId = patch.branchId !== undefined ? patch.branchId : row.Branch_ID;
  const employeeId = patch.employeeId !== undefined ? patch.employeeId : row.Employee_ID;

  const refError = await checkAccountReferences(db, accessLevelId, branchId, employeeId);
  if (refError) return { ok: false, reason: refError };

  const password = patch.password ?? "";
  if (password.length > 0 && password.length < 6) {
    return { ok: false, reason: "Password must be at least 6 characters." };
  }

  if (password.length > 0) {
    await exec(
      db,
      `UPDATE System_Accounts
          SET First_Name = ?, Surname = ?, Company_Email = ?,
              Access_Level_ID = ?, Branch_ID = ?, Employee_ID = ?, Password_Hash = ?
        WHERE Account_ID = ?`,
      first,
      surname,
      email,
      accessLevelId,
      branchId,
      employeeId,
      hashPassword(password),
      accountId
    );
  } else {
    await exec(
      db,
      `UPDATE System_Accounts
          SET First_Name = ?, Surname = ?, Company_Email = ?,
              Access_Level_ID = ?, Branch_ID = ?, Employee_ID = ?
        WHERE Account_ID = ?`,
      first,
      surname,
      email,
      accessLevelId,
      branchId,
      employeeId,
      accountId
    );
  }
  return { ok: true };
}

export async function systemAccountById(accountId: number): Promise<SystemAccountRow | null> {
  return await queryOne<SystemAccountRow>(await getDb(), "SELECT * FROM System_Accounts WHERE Account_ID = ?", accountId) ?? null;
}

/** Case-insensitive email lookup for the login handler. */
export async function findAccountByEmail(email: string): Promise<SystemAccountRow | null> {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return (
    await queryOne<SystemAccountRow>(
      await getDb(),
      "SELECT * FROM System_Accounts WHERE Company_Email COLLATE NOCASE = ?",
      normalized
    ) ?? null
  );
}

/**
 * Find or auto-create a System_Accounts row for an existing roster employee
 * so any employee who exists in Employees (`EMPxxxx`) can sign in on the web
 * portal as well as the mobile app.
 */
export async function findOrCreateAccountForEmployee(
  employee: EmployeeRow
): Promise<SystemAccountRow | null> {
  const db = await getDb();

  // 1. Direct match by linked Employee_ID
  const byEmpId = await queryOne<SystemAccountRow>(
    db,
    "SELECT * FROM System_Accounts WHERE Employee_ID = ? LIMIT 1",
    employee.Employee_ID
  );
  if (byEmpId) return byEmpId;

  // 2. If this is EMP1001 / Pride Admin, link to the admin account
  if (
    employee.ERP_User_ID.toUpperCase() === "EMP1001" ||
    employee.Full_Name.toLowerCase() === "pride admin"
  ) {
    const adminAcc = await findAccountByEmail("admin@biobridge.com");
    if (adminAcc) {
      await exec(
        db,
        "UPDATE System_Accounts SET Employee_ID = ? WHERE Account_ID = ?",
        employee.Employee_ID,
        adminAcc.Account_ID
      );
      return (await systemAccountById(adminAcc.Account_ID)) ?? adminAcc;
    }
  }

  // 3. Auto-provision a Worker account linked to this employee
  const workerLevel = await queryOne<{ id: number }>(
    db,
    "SELECT Access_Level_ID AS id FROM Access_Levels WHERE Level_Name = 'Worker' LIMIT 1"
  );
  const branchRow = employee.Branch_Name
    ? await queryOne<{ id: number }>(
        db,
        "SELECT Branch_ID AS id FROM Branches WHERE Branch_Name COLLATE NOCASE = ? LIMIT 1",
        employee.Branch_Name
      )
    : undefined;
  const parts = employee.Full_Name.trim().split(/\s+/);
  const firstName = parts[0] || employee.ERP_User_ID;
  const surname = parts.slice(1).join(" ") || "Employee";
  const autoEmail = `${employee.ERP_User_ID.toLowerCase()}@biobridge.com`;

  const existingByEmail = await findAccountByEmail(autoEmail);
  if (existingByEmail) {
    await exec(
      db,
      "UPDATE System_Accounts SET Employee_ID = ? WHERE Account_ID = ?",
      employee.Employee_ID,
      existingByEmail.Account_ID
    );
    return (await systemAccountById(existingByEmail.Account_ID)) ?? existingByEmail;
  }

  const { lastId } = await run(
    db,
    `INSERT INTO System_Accounts
       (First_Name, Surname, Company_Email, Password_Hash, Access_Level_ID, Branch_ID, Employee_ID, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    firstName,
    surname,
    autoEmail,
    hashPassword(employee.ERP_User_ID),
    workerLevel?.id ?? null,
    branchRow?.id ?? null,
    employee.Employee_ID,
    Date.now()
  );
  return await systemAccountById(lastId);
}

/**
 * The server-side view of a signed-in account: identity + the live
 * permission matrix resolved from their Access_Level (never from the
 * token). `home` is the page they should land on after a fresh login.
 */
export interface ResolvedAccount {
  accountId: number;
  firstName: string;
  surname: string;
  name: string;
  email: string;
  accessLevelId: number | null;
  levelName: string;
  permissions: PermissionsMap;
  branchId: number | null;
  branchName: string | null;
  employeeId: number | null;
  home: string;
}

export async function resolveAccount(account: SystemAccountRow): Promise<ResolvedAccount> {
  const db = await getDb();
  const level =
    account.Access_Level_ID != null
      ? await queryOne<AccessLevelRow>(db, "SELECT * FROM Access_Levels WHERE Access_Level_ID = ?", account.Access_Level_ID)
      : undefined;
  const branch =
    account.Branch_ID != null
      ? await queryOne<BranchRow>(db, "SELECT * FROM Branches WHERE Branch_ID = ?", account.Branch_ID)
      : undefined;
  const permissions = parsePermissions(level?.Permissions_JSON);
  return {
    accountId: account.Account_ID,
    firstName: account.First_Name,
    surname: account.Surname,
    name: `${account.First_Name} ${account.Surname}`.trim(),
    email: account.Company_Email,
    accessLevelId: level?.Access_Level_ID ?? null,
    levelName: level?.Level_Name ?? "No access level",
    permissions,
    branchId: branch?.Branch_ID ?? null,
    branchName: branch?.Branch_Name ?? null,
    employeeId: account.Employee_ID ?? null,
    home: permissions.can_view_dashboard
      ? "/"
      : permissions.can_view_tablet_station
        ? "/tablet"
        : "/my-portal",
  };
}

/**
 * Resolve a session cookie to a full account — used by proxy.ts for page
 * permission gating and by every API handler for authorization. Returns
 * null when the token is missing/forged/expired OR the account was deleted.
 */
export async function accountByToken(token: string | null | undefined): Promise<ResolvedAccount | null> {
  const claims = verifySessionToken(token);
  if (!claims) return null;
  const id = Number(claims.sub);
  if (!Number.isInteger(id) || id <= 0) return null;
  const account = await systemAccountById(id);
  if (!account) return null;
  return resolveAccount(account);
}

/* ------------------------------------------------------------------ */
/* Time-off requests (Phase 14 — My Portal widget)                     */
/* ------------------------------------------------------------------ */

export async function listTimeOffRequests(employeeId: number | null): Promise<TimeOffRequestRow[]> {
  if (employeeId === null) return [];
  return await queryAll<TimeOffRequestRow>(
    await getDb(),
    "SELECT * FROM Time_Off_Requests WHERE Employee_ID = ? ORDER BY Created_At DESC",
    employeeId
  );
}

export interface TimeOffInput {
  accountId: number;
  employeeId: number | null;
  type: string;
  startDate: string;
  endDate: string;
  reason: string;
}

export async function createTimeOffRequest(input: TimeOffInput): Promise<TimeOffRequestRow> {
  const db = await getDb();
  const type = (input.type ?? "").trim();
  const start = (input.startDate ?? "").trim();
  const end = (input.endDate ?? "").trim();
  const reason = (input.reason ?? "").trim();
  if (!["Annual", "Sick", "Unpaid", "Other"].includes(type)) {
    throw new Error("Choose a valid request type.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error("Request dates must use YYYY-MM-DD.");
  }
  if (end < start) throw new Error("The end date cannot be before the start date.");
  const { lastId: id } = await run(
    db,
    `INSERT INTO Time_Off_Requests
       (Account_ID, Employee_ID, Type, Start_Date, End_Date, Reason, Status, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?)`,
    input.accountId,
    input.employeeId,
    type,
    start,
    end,
    reason,
    Date.now()
  );
  const row = await queryOne<TimeOffRequestRow>(db, "SELECT * FROM Time_Off_Requests WHERE Request_ID = ?", id);
  if (!row) throw new Error("Could not store the request.");
  return row;
}

/* ------------------------------------------------------------------ */
/* My Portal data (Phase 14 — worker clocking hub)                     */
/* ------------------------------------------------------------------ */

/** Latest punch today for an employee → the "clocked in?" badge. */
export async function employeeDayStatus(employeeId: number): Promise<{
  clockedIn: boolean;
  lastPunchAt: number | null;
  lastDirection: PunchDirection | null;
}> {
  const row = await queryOne<{ ts: number; dir: PunchDirection }>(
    await getDb(),
    `SELECT l.Timestamp AS ts, l.Direction AS dir
       FROM Attendance_Logs l
      WHERE l.Employee_ID = ? AND l.Timestamp >= ?
      ORDER BY l.Timestamp DESC, l.Log_ID DESC
      LIMIT 1`,
    employeeId,
    startOfTodayMs()
  );
  if (!row) return { clockedIn: false, lastPunchAt: null, lastDirection: null };
  return { clockedIn: row.dir === "IN", lastPunchAt: row.ts, lastDirection: row.dir };
}

/** The worker's own punch history feed (newest first). */
export async function getEmployeeRecentPunches(employeeId: number, limit: number): Promise<MyPortalPunch[]> {
  return await queryAll<MyPortalPunch>(
    await getDb(),
    `SELECT l.Log_ID                              AS logId,
            l.Timestamp                           AS timestamp,
            l.Direction                           AS direction,
            l.Verify_Result                       AS verifyResult,
            l.ERP_Sync_Status                     AS syncStatus,
            t.Location_Name                       AS location,
            t.Branch_Name                         AS branch
       FROM Attendance_Logs l
       LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
      WHERE l.Employee_ID = ?
      ORDER BY l.Timestamp DESC, l.Log_ID DESC
      LIMIT ?`,
    employeeId,
    Math.max(1, Math.min(50, limit))
  );
}

/* ------------------------------------------------------------------ */
/* Employees                                                           */
/* ------------------------------------------------------------------ */

/** Full roster (every row of Employees), alphabetical. */
export async function allEmployees(): Promise<EmployeeRow[]> {
  return await queryAll<EmployeeRow>(
    await getDb(),
    "SELECT * FROM Employees ORDER BY Employee_ID"
  );
}

/** Look up an employee by their immutable primary key Employee_ID. */
export async function employeeById(employeeId: number): Promise<EmployeeRow | null> {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return null;
  return (
    await queryOne<EmployeeRow>(
      await getDb(),
      "SELECT * FROM Employees WHERE Employee_ID = ?",
      employeeId
    ) ?? null
  );
}

/**
 * Normalize an employee code into the standard `EMPxxxx` format.
 * Examples:
 *   "EMP1001"  -> "EMP1001"
 *   "EMP_1001" -> "EMP1001"
 *   "ERP-1001" -> "EMP1001"
 *   "EMP-1001" -> "EMP1001"
 *   "1001"     -> "EMP1001"
 */
export function normalizeEmployeeId(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^(ERP|EMP)[-_ ]?(.+)$/i.test(v)) {
    const suffix = v.replace(/^(ERP|EMP)[-_ ]?/i, "").trim();
    return `EMP${suffix}`;
  }
  if (/^\d+$/.test(v)) {
    return `EMP${v}`;
  }
  return v;
}

/**
 * Resolve a device/ERP/route reference to an employee.
 * Accepts ERP_User_ID ("EMP1001"), the bare numeric id ("1", "1001" →
 * "EMP1001") or a route param in either form. Returns null when unknown.
 */
export async function resolveEmployee(db: Client, ref: string): Promise<EmployeeRow | null> {
  const value = ref.trim();
  if (!value) return null;

  // 1. Direct match on ERP_User_ID
  const direct = await queryOne<EmployeeRow>(
    db,
    "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
    value
  );
  if (direct) return direct;

  // 2. Extract digits if present (e.g. "1001", "EMP1001", "EMP_1001", "EMP-1001", "ERP-1001")
  const digitsMatch = value.match(/\d+/);
  const digits = digitsMatch ? digitsMatch[0] : "";

  if (digits) {
    const byId = await queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE Employee_ID = ?",
      Number(digits)
    );
    if (byId) return byId;

    const byEmpClean = await queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
      `EMP${digits}`
    );
    if (byEmpClean) return byEmpClean;

    const byEmpUnderscore = await queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
      `EMP_${digits}`
    );
    if (byEmpUnderscore) return byEmpUnderscore;

    const byEmpDash = await queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
      `EMP-${digits}`
    );
    if (byEmpDash) return byEmpDash;

    const byErp = await queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
      `ERP-${digits}`
    );
    if (byErp) return byErp;

    const byBare = await queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
      digits
    );
    if (byBare) return byBare;
  }

  // 3. Try stripped common prefixes (ERP-, EMP, EMP_, EMP-, ME-)
  const stripped = value.replace(/^(ERP|EMP|ME)[-_ ]?/i, "");
  if (stripped && stripped !== value) {
    const byStripped = await queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ? OR ERP_User_ID COLLATE NOCASE = ? OR ERP_User_ID COLLATE NOCASE = ? OR ERP_User_ID COLLATE NOCASE = ? OR ERP_User_ID COLLATE NOCASE = ?",
      stripped,
      `EMP${stripped}`,
      `EMP_${stripped}`,
      `EMP-${stripped}`,
      `ERP-${stripped}`
    );
    if (byStripped) return byStripped;
  }

  return null;
}

/** Extra columns the /employees directory and search type-ahead need. */
export interface EmployeeDirectoryRow extends EmployeeRow {
  Last_Seen: number | null;
  /** Branch of the most recent punch — fallback when none is assigned. */
  Punch_Branch: string | null;
}

export interface EmployeeSearchRow extends EmployeeRow {
  Punches_30d: number;
  Last_Punch: number | null;
}

/**
 * Master directory (Phase 5 → 11): roster rows plus last-seen stamp and
 * the branch of the most recent punch (Punch_Branch — the record's own
 * Branch_Name comes through e.*). Partial match on name / ERP id.
 */
export async function listEmployees(q: string): Promise<EmployeeDirectoryRow[]> {
  const like = `%${q.trim()}%`;
  return await queryAll<EmployeeDirectoryRow>(
    await getDb(),
    `SELECT e.*,
            (SELECT MAX(l.Timestamp) FROM Attendance_Logs l
              WHERE l.Employee_ID = e.Employee_ID) AS Last_Seen,
            (SELECT t.Branch_Name FROM Attendance_Logs l
               JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
              WHERE l.Employee_ID = e.Employee_ID
              ORDER BY l.Timestamp DESC LIMIT 1) AS Punch_Branch
       FROM Employees e
      WHERE (? = '' OR e.Full_Name LIKE ? OR e.ERP_User_ID LIKE ?)
      ORDER BY e.Full_Name COLLATE NOCASE`,
    q,
    like,
    like
  );
}

/** Dashboard type-ahead: top hits + 30-day activity counters. */
export async function searchEmployees(q: string, limit: number): Promise<EmployeeSearchRow[]> {
  const like = `%${q.trim()}%`;
  const since = Date.now() - 30 * 86_400_000;
  return await queryAll<EmployeeSearchRow>(
    await getDb(),
    `SELECT e.*,
            (SELECT COUNT(*) FROM Attendance_Logs l
              WHERE l.Employee_ID = e.Employee_ID AND l.Timestamp >= ?) AS Punches_30d,
            (SELECT MAX(l.Timestamp) FROM Attendance_Logs l
              WHERE l.Employee_ID = e.Employee_ID) AS Last_Punch
       FROM Employees e
      WHERE (? = '' OR e.Full_Name LIKE ? OR e.ERP_User_ID LIKE ?)
      ORDER BY Punches_30d DESC, e.Full_Name COLLATE NOCASE
      LIMIT ?`,
    since,
    q,
    like,
    like,
    Math.max(1, limit)
  );
}

/** One employee currently clocked in — latest punch today is an IN. */
export interface WhoIsInRow {
  Employee_ID: number;
  ERP_User_ID: string;
  Full_Name: string;
  Department: string;
  Branch_Name: string | null;
  Location_Name: string | null;
  Clocked_In_At: number;
}

export async function listWhoIsIn(): Promise<WhoIsInRow[]> {
  return await queryAll<WhoIsInRow>(
    await getDb(),
    `WITH latest AS (
        SELECT l.Employee_ID, l.Timestamp, l.Direction, l.Verify_Result, l.Terminal_ID,
               ROW_NUMBER() OVER (
                 PARTITION BY l.Employee_ID ORDER BY l.Timestamp DESC, l.Log_ID DESC
               ) AS rn
          FROM Attendance_Logs l
         WHERE l.Employee_ID IS NOT NULL
           AND l.Timestamp >= ?
     )
     SELECT e.Employee_ID, e.ERP_User_ID, e.Full_Name, e.Department,
            t.Branch_Name, t.Location_Name, latest.Timestamp AS Clocked_In_At
       FROM latest
       JOIN Employees e ON e.Employee_ID = latest.Employee_ID
       LEFT JOIN Terminals t ON t.Terminal_ID = latest.Terminal_ID
      WHERE latest.rn = 1
        AND latest.Direction = 'IN'
        AND latest.Verify_Result = 'Verified'
      ORDER BY latest.Timestamp DESC`,
    startOfTodayMs()
  );
}

/* ------------------------------------------------------------------ */
/* Field Tracker — latest device positions + live map snapshot         */
/* ------------------------------------------------------------------ */

/** A phone fix older than this is drawn grey ("stale"). */
export const PRESENCE_STALE_MS = 5 * 60_000;
/** Presence rows older than this are no longer shown as tracked devices. */
export const PRESENCE_WINDOW_MS = 30 * 60_000;
/** Keep the latest fix, but drop rows for employees gone for a day. */
const PRESENCE_PURGE_MS = 24 * 60 * 60_000;
/** Ignore duplicate fixes arriving within this window (battery / spam guard). */
export const PRESENCE_MIN_INTERVAL_MS = 15_000;

export interface PresenceInput {
  employeeId: number;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  branchName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  timestamp: number;
}

/**
 * Store the latest location reported by a signed-in phone. Upsert — there is
 * deliberately no history. Out-of-order or too-frequent fixes are dropped.
 */
export async function upsertEmployeePresence(
  input: PresenceInput
): Promise<{ recorded: boolean; reason?: "throttled" }> {
  const db = await getDb();
  const existing = await queryOne<{ last: number }>(
    db,
    "SELECT Last_Seen AS last FROM Employee_Presence WHERE Employee_ID = ?",
    input.employeeId
  );
  if (existing && input.timestamp <= existing.last + PRESENCE_MIN_INTERVAL_MS) {
    return { recorded: false, reason: "throttled" };
  }

  await run(
    db,
    `INSERT INTO Employee_Presence
       (Employee_ID, Latitude, Longitude, Accuracy_Meters, Branch_Name,
        Device_ID, Device_Name, Source, Last_Seen, Updated_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'mobile', ?, ?)
     ON CONFLICT(Employee_ID) DO UPDATE SET
       Latitude = excluded.Latitude,
       Longitude = excluded.Longitude,
       Accuracy_Meters = excluded.Accuracy_Meters,
       Branch_Name = excluded.Branch_Name,
       Device_ID = excluded.Device_ID,
       Device_Name = excluded.Device_Name,
       Source = excluded.Source,
       Last_Seen = excluded.Last_Seen,
       Updated_At = excluded.Updated_At`,
    input.employeeId,
    input.latitude,
    input.longitude,
    input.accuracyMeters,
    input.branchName,
    input.deviceId,
    input.deviceName,
    input.timestamp,
    Date.now()
  );
  return { recorded: true };
}

/** Remove an employee's row immediately (used on mobile sign-out). */
export async function clearEmployeePresence(employeeId: number): Promise<void> {
  await run(await getDb(), "DELETE FROM Employee_Presence WHERE Employee_ID = ?", employeeId);
}

/** Opportunistic retention sweep — safe to call on every map request. */
export async function purgeEmployeePresence(now = Date.now()): Promise<void> {
  await run(
    await getDb(),
    "DELETE FROM Employee_Presence WHERE Last_Seen < ?",
    now - PRESENCE_PURGE_MS
  );
}

interface PresenceJoinedRow {
  Employee_ID: number;
  Latitude: number;
  Longitude: number;
  Accuracy_Meters: number | null;
  Branch_Name: string | null;
  Device_ID: string | null;
  Device_Name: string | null;
  Source: string;
  Last_Seen: number;
  ERP_User_ID: string;
  Full_Name: string;
  Department: string;
  Home_Branch: string | null;
}

interface LatestPunchJoinedRow {
  Employee_ID: number;
  Timestamp: number;
  Direction: PunchDirection;
  Verify_Result: VerifyResult;
  Latitude: number | null;
  Longitude: number | null;
  Location_Accuracy_Meters: number | null;
  Punch_Branch: string | null;
  Device_Name: string | null;
  ERP_User_ID: string;
  Full_Name: string;
  Department: string;
  Home_Branch: string | null;
  Terminal_Branch: string | null;
  Location_Name: string | null;
  Terminal_Lat: number | null;
  Terminal_Lng: number | null;
}

export interface FieldTrackerSnapshot {
  sites: FieldTrackerSite[];
  devices: FieldTrackerDevice[];
  counts: FieldTrackerCounts;
  staleAfterMs: number;
  presenceWindowMs: number;
}

export interface FieldTrackerFilters {
  /** Only devices geometrically inside this fence (case-insensitive). */
  branch?: string | null;
  /** Free text over employee number and name. */
  query?: string | null;
  /** When false (default) only devices inside a fence are returned. */
  includeOffsite?: boolean;
  now?: number;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One read-only snapshot for the Field Tracker: every configured fence plus
 * every tracked device, with the server — not the phone — deciding which fence
 * a position falls inside.
 *
 * Position priority:
 *   1. latest phone presence (live ≤ staleAfterMs, otherwise stale),
 *   2. the latest GPS punch,
 *   3. the latest terminal's coordinates,
 *   4. the centre of the employee's known branch.
 *
 * Fences are read live from `Branches`/`Terminals`, so an edited radius or pin
 * is reflected on the very next request.
 */
export async function listFieldTracker(
  filters: FieldTrackerFilters = {}
): Promise<FieldTrackerSnapshot> {
  const db = await getDb();
  const now = filters.now ?? Date.now();

  const sites = (await listConfiguredBranches()).map<FieldTrackerSite>((site) => ({
    id: site.id,
    branch: site.branch,
    method: site.method,
    latitude: site.latitude,
    longitude: site.longitude,
    radiusMeters: site.radiusMeters,
    mobile: methodAllowsMobile(site.method),
    tracked: 0,
    clockedIn: 0,
  }));

  const presenceRows = await queryAll<PresenceJoinedRow>(
    db,
    `SELECT p.Employee_ID, p.Latitude, p.Longitude, p.Accuracy_Meters,
            p.Branch_Name, p.Device_ID, p.Device_Name, p.Source, p.Last_Seen,
            e.ERP_User_ID, e.Full_Name, e.Department, e.Branch_Name AS Home_Branch
       FROM Employee_Presence p
       JOIN Employees e ON e.Employee_ID = p.Employee_ID
      WHERE p.Last_Seen >= ?
        AND e.Status = 'Active'`,
    now - PRESENCE_WINDOW_MS
  );

  const punchRows = await queryAll<LatestPunchJoinedRow>(
    db,
    `WITH latest AS (
        SELECT l.*, ROW_NUMBER() OVER (
                 PARTITION BY l.Employee_ID ORDER BY l.Timestamp DESC, l.Log_ID DESC
               ) AS rn
          FROM Attendance_Logs l
         WHERE l.Employee_ID IS NOT NULL
           AND l.Timestamp >= ?
      )
      SELECT l.Employee_ID, l.Timestamp, l.Direction, l.Verify_Result,
             l.Latitude, l.Longitude, l.Location_Accuracy_Meters,
             l.Branch_Name AS Punch_Branch, l.Device_Name,
             e.ERP_User_ID, e.Full_Name, e.Department, e.Branch_Name AS Home_Branch,
             t.Branch_Name AS Terminal_Branch, t.Location_Name,
             t.Latitude AS Terminal_Lat, t.Longitude AS Terminal_Lng
        FROM latest l
        JOIN Employees e ON e.Employee_ID = l.Employee_ID
        LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
       WHERE l.rn = 1
         AND e.Status = 'Active'`,
    startOfTodayMs(now)
  );

  const punchByEmployee = new Map(punchRows.map((row) => [row.Employee_ID, row]));
  const presenceByEmployee = new Map(presenceRows.map((row) => [row.Employee_ID, row]));
  const employeeIds = new Set<number>([...punchByEmployee.keys(), ...presenceByEmployee.keys()]);

  const siteByName = new Map(sites.map((site) => [site.branch.toLowerCase(), site]));

  const devices: FieldTrackerDevice[] = [];
  for (const employeeId of employeeIds) {
    const presence = presenceByEmployee.get(employeeId);
    const punch = punchByEmployee.get(employeeId);

    const identity = presence ?? punch;
    if (!identity) continue;

    const homeBranch = (identity.Home_Branch ?? "").trim();
    const clockedIn = Boolean(
      punch && punch.Direction === "IN" && punch.Verify_Result === "Verified"
    );

    // ── Resolve the displayed fix ──────────────────────────────────────
    let latitude: number | null = null;
    let longitude: number | null = null;
    let accuracyMeters: number | null = null;
    let lastSeenAt = 0;
    let source: FieldTrackerDevice["source"] = "branch";
    let branchHint: string | null = null;

    if (presence) {
      latitude = finite(presence.Latitude);
      longitude = finite(presence.Longitude);
      accuracyMeters = finite(presence.Accuracy_Meters);
      lastSeenAt = presence.Last_Seen;
      source = "live";
      branchHint = presence.Branch_Name?.trim() || null;
    } else if (punch) {
      const pLat = finite(punch.Latitude);
      const pLng = finite(punch.Longitude);
      if (pLat !== null && pLng !== null) {
        latitude = pLat;
        longitude = pLng;
        accuracyMeters = finite(punch.Location_Accuracy_Meters);
        lastSeenAt = punch.Timestamp;
        source = "punch";
        branchHint = punch.Punch_Branch?.trim() || null;
      } else {
        const tLat = finite(punch.Terminal_Lat);
        const tLng = finite(punch.Terminal_Lng);
        if (tLat !== null && tLng !== null) {
          latitude = tLat;
          longitude = tLng;
          lastSeenAt = punch.Timestamp;
          source = "terminal";
          branchHint = punch.Terminal_Branch?.trim() || punch.Punch_Branch?.trim() || null;
        } else {
          const fallbackBranch =
            punch.Punch_Branch?.trim() ||
            punch.Terminal_Branch?.trim() ||
            homeBranch ||
            null;
          const site = fallbackBranch ? siteByName.get(fallbackBranch.toLowerCase()) : undefined;
          if (site) {
            latitude = site.latitude;
            longitude = site.longitude;
            lastSeenAt = punch.Timestamp;
            source = "branch";
            branchHint = site.branch;
          }
        }
      }
    }

    if (latitude === null || longitude === null) continue;

    // ── Which fence geometrically contains this fix? ──────────────────
    let containing: FieldTrackerSite | null = null;
    let containingDistance: number | null = null;
    for (const site of sites) {
      const distance = haversineMetersRounded(latitude, longitude, site.latitude, site.longitude);
      if (distance <= site.radiusMeters) {
        if (!containing || distance < (containingDistance ?? Infinity)) {
          containing = site;
          containingDistance = distance;
        }
      }
    }

    const resolvedBranch = containing?.branch ?? branchHint ?? (homeBranch || null);
    const knownSite =
      containing ?? (resolvedBranch ? siteByName.get(resolvedBranch.toLowerCase()) ?? null : null);
    const distanceMeters = knownSite
      ? haversineMetersRounded(latitude, longitude, knownSite.latitude, knownSite.longitude)
      : null;

    const age = Math.max(0, now - lastSeenAt);
    const status: FieldTrackerDevice["status"] =
      source === "live" ? (age <= PRESENCE_STALE_MS ? "live" : "stale") : "last-known";

    devices.push({
      employeeId,
      employeeNumber: identity.ERP_User_ID,
      fullName: identity.Full_Name,
      department: identity.Department ?? "",
      homeBranch,
      deviceName: presence?.Device_Name ?? punch?.Device_Name ?? null,
      branch: resolvedBranch,
      latitude,
      longitude,
      accuracyMeters,
      source,
      status,
      lastSeenAt,
      clockedIn,
      clockedInAt: clockedIn && punch ? punch.Timestamp : null,
      direction: punch?.Direction ?? null,
      insideFence: Boolean(containing),
      distanceMeters,
    });
  }

  // Compute per-fence counts from every tracked device (before filtering) so
  // the fence rail keeps its totals while one fence is selected.
  for (const site of sites) {
    const inside = devices.filter(
      (device) => device.insideFence && device.branch?.toLowerCase() === site.branch.toLowerCase()
    );
    site.tracked = inside.length;
    site.clockedIn = inside.filter((device) => device.clockedIn).length;
  }

  const branchFilter = (filters.branch ?? "").trim().toLowerCase();
  const text = (filters.query ?? "").trim().toLowerCase();
  const includeOffsite = filters.includeOffsite === true;

  const visible = devices
    .filter((device) => {
      if (!includeOffsite && !device.insideFence) return false;
      if (branchFilter && device.branch?.toLowerCase() !== branchFilter) return false;
      if (branchFilter && !device.insideFence) return false;
      if (
        text &&
        !device.employeeNumber.toLowerCase().includes(text) &&
        !device.fullName.toLowerCase().includes(text)
      ) {
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        Number(b.clockedIn) - Number(a.clockedIn) ||
        a.employeeNumber.localeCompare(b.employeeNumber)
    );

  const counts: FieldTrackerCounts = {
    tracked: visible.length,
    clockedIn: visible.filter((device) => device.clockedIn).length,
    live: visible.filter((device) => device.status === "live").length,
    stale: visible.filter((device) => device.status === "stale").length,
    offsite: visible.filter((device) => !device.insideFence).length,
    fences: sites.length,
  };

  return {
    sites,
    devices: visible,
    counts,
    staleAfterMs: PRESENCE_STALE_MS,
    presenceWindowMs: PRESENCE_WINDOW_MS,
  };
}

export interface EmployeeInput {
  erpUserId: string;
  fullName: string;
  department: string;
  position: string;
  /** Home branch written on the record ("" = unassigned). */
  branch: string;
  shiftId: number | null;
  enrolled: boolean;
  /** Explicit finger set — overrides what `enrolled` implies (create only). */
  fingers?: number[];
  status: string;
}

export async function createEmployee(input: EmployeeInput): Promise<number> {
  const db = await getDb();
  // "Enrolled on a terminal" without an explicit finger set ⇒ all five
  // templates already live on the device.
  const fingers =
    input.fingers ?? (input.enrolled ? [0, 1, 2, 3, 4] : []);
  const { lastId } = await run(
    db,
    `INSERT INTO Employees
       (ERP_User_ID, Full_Name, Fingerprint_Enrolled, Fingers_Enrolled,
        Department, Position, Branch_Name, Shift_ID, Status, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    normalizeEmployeeId(input.erpUserId),
    input.fullName.trim(),
    input.enrolled ? 1 : 0,
    serializeFingers(fingers),
    input.department.trim(),
    input.position.trim(),
    input.branch.trim(),
    input.shiftId,
    input.status.trim() || "Active",
    Date.now()
  );
  return lastId;
}

export async function updateEmployee(employeeId: number, patch: Partial<EmployeeInput>): Promise<void> {
  const db = await getDb();
  const current = await queryOne<EmployeeRow>(db, "SELECT * FROM Employees WHERE Employee_ID = ?", employeeId);
  if (!current) return;

  const updates: string[] = [];
  const params: SQLInputValue[] = [];
  const push = (column: string, value: SQLInputValue) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.erpUserId !== undefined) push("ERP_User_ID", normalizeEmployeeId(patch.erpUserId) || current.ERP_User_ID);
  if (patch.fullName !== undefined) push("Full_Name", patch.fullName.trim() || current.Full_Name);
  if (patch.department !== undefined) push("Department", patch.department.trim());
  if (patch.position !== undefined) push("Position", patch.position.trim());
  if (patch.branch !== undefined) push("Branch_Name", patch.branch.trim());
  if (patch.shiftId !== undefined) push("Shift_ID", patch.shiftId);
  if (patch.status !== undefined) push("Status", patch.status.trim() || "Active");

  // Finger set from the enrolment console — keeps the enrolled flag in sync.
  if (patch.fingers !== undefined) {
    const stored = serializeFingers(patch.fingers);
    push("Fingers_Enrolled", stored);
    push("Fingerprint_Enrolled", stored === "" ? 0 : 1);
  } else if (patch.enrolled !== undefined) {
    push("Fingerprint_Enrolled", patch.enrolled ? 1 : 0);
    if (patch.enrolled) {
      // Checked with no templates captured yet → the device already holds
      // all five; repairing legacy rows that flag enrolment without fingers.
      if (serializeFingers(parseFingers(current.Fingers_Enrolled)) === "") {
        push("Fingers_Enrolled", "0,1,2,3,4");
      }
    } else {
      push("Fingers_Enrolled", ""); // un-enrolling wipes the templates too
    }
  }

  if (updates.length === 0) return;
  params.push(employeeId);
  await exec(db, `UPDATE Employees SET ${updates.join(", ")} WHERE Employee_ID = ?`, ...params);
}

/** Remove an employee and their punches (keeps the feed free of orphans). */
export async function deleteEmployee(employeeId: number): Promise<void> {
  const db = await getDb();
  await exec(db, "DELETE FROM Attendance_Logs WHERE Employee_ID = ?", employeeId);
  await exec(db, "DELETE FROM Employees WHERE Employee_ID = ?", employeeId);
}

/**
 * Bind a physical mobile device (1-to-1) to an employee record on first login.
 */
export async function bindEmployeeDevice(
  employeeId: number,
  deviceId: string,
  deviceName?: string | null
): Promise<void> {
  const db = await getDb();
  await exec(
    db,
    "UPDATE Employees SET Bound_Device_ID = ?, Bound_Device_Name = ?, Bound_Device_At = ? WHERE Employee_ID = ?",
    deviceId.trim(),
    deviceName ? deviceName.trim() : null,
    Date.now(),
    employeeId
  );
}

/**
 * Unbind / reset an employee's mobile device so they can register a new phone.
 */
export async function unbindEmployeeDevice(employeeId: number): Promise<void> {
  const db = await getDb();
  await exec(
    db,
    "UPDATE Employees SET Bound_Device_ID = NULL, Bound_Device_Name = NULL, Bound_Device_At = NULL WHERE Employee_ID = ?",
    employeeId
  );
}

/**
 * Find any employee already bound to a given hardware device ID.
 */
export async function findEmployeeByDeviceId(deviceId: string): Promise<EmployeeRow | null> {
  const clean = deviceId.trim();
  if (!clean) return null;
  const db = await getDb();
  return (
    (await queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE Bound_Device_ID = ?",
      clean
    )) ?? null
  );
}

/**
 * Bulk import employees from parsed spreadsheet records (CSV, XLSX, XLS).
 * Supports upserting (updating existing records if ERP_User_ID already exists).
 */
export async function importEmployees(
  items: EmployeeImportItem[],
  options?: { updateExisting?: boolean }
): Promise<EmployeeImportResult> {
  const db = await getDb();
  const updateExisting = options?.updateExisting ?? true;
  const shifts = await listShifts();

  const shiftMap = new Map<string, number>();
  for (const s of shifts) {
    shiftMap.set(String(s.Shift_ID), s.Shift_ID);
    shiftMap.set(s.Name.toLowerCase().trim(), s.Shift_ID);
  }

  const result: EmployeeImportResult = {
    total: items.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  const now = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rowNum = i + 1;
    const erp = normalizeEmployeeId((item.erpUserId ?? "").toString());
    const name = (item.fullName ?? "").toString().trim();

    if (!erp) {
      result.errors.push({ row: rowNum, name, message: "Missing Employee Number / ID." });
      continue;
    }
    if (!name) {
      result.errors.push({ row: rowNum, erpUserId: erp, message: "Missing Full Name." });
      continue;
    }

    // Resolve shift ID if specified
    let shiftId: number | null = null;
    if (item.shift !== undefined && item.shift !== null && item.shift !== "") {
      const shiftStr = String(item.shift).trim().toLowerCase();
      if (shiftMap.has(shiftStr)) {
        shiftId = shiftMap.get(shiftStr)!;
      } else {
        const num = Number(shiftStr);
        if (Number.isInteger(num) && shiftMap.has(String(num))) {
          shiftId = num;
        }
      }
    }

    const dept = (item.department ?? "").toString().trim();
    const pos = (item.position ?? "").toString().trim();
    const branch = (item.branch ?? "").toString().trim();
    const status = (item.status ?? "").toString().trim() || "Active";
    const enrolled = Boolean(item.enrolled);
    const mobilePin = item.mobilePin ? String(item.mobilePin).trim() : null;

    try {
      const existing = await queryOne<EmployeeRow>(
        db,
        "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
        erp
      );

      if (existing) {
        if (!updateExisting) {
          result.skipped++;
          continue;
        }

        const updates: string[] = ["Full_Name = ?"];
        const params: SQLInputValue[] = [name];

        if (dept) {
          updates.push("Department = ?");
          params.push(dept);
        }
        if (pos) {
          updates.push("Position = ?");
          params.push(pos);
        }
        if (branch) {
          updates.push("Branch_Name = ?");
          params.push(branch);
        }
        if (shiftId !== null) {
          updates.push("Shift_ID = ?");
          params.push(shiftId);
        }
        if (status) {
          updates.push("Status = ?");
          params.push(status);
        }
        if (item.enrolled !== undefined) {
          updates.push("Fingerprint_Enrolled = ?");
          params.push(enrolled ? 1 : 0);
          if (enrolled && !existing.Fingers_Enrolled) {
            updates.push("Fingers_Enrolled = ?");
            params.push("0,1,2,3,4");
          }
        }
        if (mobilePin) {
          updates.push("Mobile_PIN = ?");
          params.push(mobilePin);
        }

        params.push(existing.Employee_ID);
        await exec(db, `UPDATE Employees SET ${updates.join(", ")} WHERE Employee_ID = ?`, ...params);
        result.updated++;
      } else {
        const fingers = enrolled ? "0,1,2,3,4" : "";
        await exec(
          db,
          `INSERT INTO Employees
             (ERP_User_ID, Full_Name, Fingerprint_Enrolled, Fingers_Enrolled,
              Department, Position, Branch_Name, Shift_ID, Status, Mobile_PIN, Created_At)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          erp,
          name,
          enrolled ? 1 : 0,
          fingers,
          dept,
          pos,
          branch,
          shiftId,
          status,
          mobilePin,
          now
        );
        result.created++;
      }
    } catch (err) {
      result.errors.push({
        row: rowNum,
        erpUserId: erp,
        name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Shifts (Phase 11 — /shifts)                                         */
/* ------------------------------------------------------------------ */

/** Whole-minute span between two "HH:MM" wall clocks (overnight aware). */
function spanMinutes(start: string, end: string): number {
  const toMin = (v: string) => {
    const [h, m] = v.split(":").map((n) => Number(n));
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const diff = toMin(end) - toMin(start);
  return diff > 0 ? diff : diff + 24 * 60;
}

export async function listShifts(): Promise<ShiftRow[]> {
  return await queryAll<ShiftRow>(
    await getDb(),
    `SELECT s.*,
            (SELECT COUNT(*) FROM Employees e WHERE e.Shift_ID = s.Shift_ID) AS Assigned
       FROM Shifts s
      ORDER BY s.Shift_ID`
  );
}

export interface ShiftInput {
  name: string;
  startTime: string;
  endTime: string;
  days: string;
}

export async function createShift(input: ShiftInput): Promise<number> {
  const db = await getDb();
  const { lastId } = await run(
    db,
    `INSERT INTO Shifts (Name, Start_Time, End_Time, Duration_Minutes, Days, Created_At)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.name.trim(),
    input.startTime,
    input.endTime,
    spanMinutes(input.startTime, input.endTime),
    input.days,
    Date.now()
  );
  return lastId;
}

export async function updateShift(shiftId: number, patch: Partial<ShiftInput>): Promise<void> {
  const db = await getDb();
  const current = await queryOne<ShiftRow>(db, "SELECT * FROM Shifts WHERE Shift_ID = ?", shiftId);
  if (!current) return;

  const name = patch.name !== undefined ? patch.name.trim() || current.Name : current.Name;
  const start = patch.startTime !== undefined ? patch.startTime : current.Start_Time;
  const end = patch.endTime !== undefined ? patch.endTime : current.End_Time;
  const days = patch.days !== undefined ? patch.days : current.Days;

  await exec(
    db,
    `UPDATE Shifts
        SET Name = ?, Start_Time = ?, End_Time = ?, Duration_Minutes = ?, Days = ?
      WHERE Shift_ID = ?`,
    name,
    start,
    end,
    spanMinutes(start, end),
    days,
    shiftId
  );
}

/** Delete a shift and release everyone assigned to it. */
export async function deleteShift(shiftId: number): Promise<void> {
  const db = await getDb();
  await exec(db, "UPDATE Employees SET Shift_ID = NULL WHERE Shift_ID = ?", shiftId);
  await exec(db, "DELETE FROM Shifts WHERE Shift_ID = ?", shiftId);
}

/* ------------------------------------------------------------------ */
/* Terminals                                                           */
/* ------------------------------------------------------------------ */

/** Every terminal row (used by the simulator + heartbeat). */
export async function allTerminalRows(): Promise<TerminalRow[]> {
  return await queryAll<TerminalRow>(await getDb(), "SELECT * FROM Terminals ORDER BY Terminal_ID");
}

/**
 * Device registry for /api/terminals — joined with today's capture count
 * so the Clocking Devices page can show live activity per device.
 */
export async function listTerminals(): Promise<TerminalJoinedRow[]> {
  return await queryAll<TerminalJoinedRow>(
    await getDb(),
    `SELECT t.*,
            (SELECT COUNT(*) FROM Attendance_Logs l
              WHERE l.Terminal_ID = t.Terminal_ID AND l.Timestamp >= ?) AS Scans_Today
       FROM Terminals t
      ORDER BY t.Terminal_ID`,
    startOfTodayMs()
  );
}

/** A random ONLINE terminal — where the next simulated punch comes from. */
export async function randomTerminal(): Promise<TerminalRow | null> {
  const rows = await queryAll<TerminalRow>(
    await getDb(),
    "SELECT * FROM Terminals WHERE Status = 'Online'"
  );
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

/**
 * Identify the sending device: serial (SN ≙ MAC) first, then source IP.
 * MAC comparison is case-insensitive — firmware often lowercases it.
 */
export async function findTerminal(
  db: Client,
  hint: { mac?: string | null; ip?: string | null }
): Promise<TerminalRow | null> {
  const mac = hint.mac?.trim();
  if (mac) {
    const byMac = await queryOne<TerminalRow>(
      db,
      "SELECT * FROM Terminals WHERE Terminal_MAC COLLATE NOCASE = ?",
      mac
    );
    if (byMac) return byMac;
  }
  const ip = hint.ip?.trim();
  if (ip) {
    const byIp = await queryOne<TerminalRow>(db, "SELECT * FROM Terminals WHERE IP_Address = ?", ip);
    if (byIp) return byIp;
  }
  return null;
}

/** Keep-alive stamp: mark the device Online and refresh its heartbeat. */
export async function touchTerminal(db: Client, terminalId: number): Promise<void> {
  await exec(
    db,
    "UPDATE Terminals SET Status = 'Online', Last_Ping = ? WHERE Terminal_ID = ?",
    Date.now(),
    terminalId
  );
}

/** Simulator flap / manual status change. */
export async function setTerminalStatus(terminalId: number, status: TerminalStatus): Promise<void> {
  const db = await getDb();
  if (status === "Online") {
    await exec(
      db,
      "UPDATE Terminals SET Status = ?, Last_Ping = ? WHERE Terminal_ID = ?",
      status,
      Date.now(),
      terminalId
    );
  } else {
    await exec(db, "UPDATE Terminals SET Status = ? WHERE Terminal_ID = ?", status, terminalId);
  }
}

/** Heartbeat: refresh Last_Ping on every device currently reporting Online. */
export async function pingOnlineTerminals(): Promise<void> {
  await exec(await getDb(), "UPDATE Terminals SET Last_Ping = ? WHERE Status = 'Online'", Date.now());
}

/* ------------------------------------------------------------------ */
/* Terminal CRUD (Phase 10 — /api/terminals)                           */
/* ------------------------------------------------------------------ */

export async function createTerminal({
  mac,
  ip,
  location,
  branch,
  deviceName,
  status = "Offline",
  clockingMethod,
  latitude,
  longitude,
  geofenceRadiusMeters,
}: {
  mac?: string | null;
  ip?: string | null;
  location?: string | null;
  branch: string;
  deviceName?: string | null;
  status?: "Online" | "Offline";
} & ClockingConfigInput) {
  const db = await getDb();
  const method = normalizeClockingMethod(clockingMethod);
  // A Geofence-only device has no physical MAC; synthesise a stable, unique
  // placeholder so the NOT NULL UNIQUE column is satisfied (and no real
  // terminal is ever mistaken for it).
  const cleanMac =
    mac?.trim() ||
    `GEO-${branch.trim().replace(/[^A-Za-z0-9]+/g, "").toUpperCase()}-${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  const loc = (location && location.trim()) || deviceName?.trim() || `Device ${cleanMac.slice(-6)}`;
  const devName = (deviceName && deviceName.trim()) || loc;
  const { lastId } = await run(
    db,
    `INSERT INTO Terminals
       (Terminal_MAC, IP_Address, Location_Name, Branch_Name, Status, Last_Ping,
        Clocking_Method, Latitude, Longitude, Geofence_Radius_Meters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cleanMac,
    ip?.trim() || "",
    devName,
    branch.trim(),
    status,
    status === "Online" ? Date.now() : null,
    method,
    coerceCoord(latitude),
    coerceCoord(longitude),
    coerceCoord(geofenceRadiusMeters)
  );

  const cleanBranch = branch.trim();
  const clockingTouched =
    clockingMethod !== undefined ||
    latitude !== undefined ||
    longitude !== undefined ||
    geofenceRadiusMeters !== undefined;
  if (cleanBranch && clockingTouched) {
    const existingBranch = await queryOne<BranchRow>(
      db,
      "SELECT * FROM Branches WHERE Branch_Name COLLATE NOCASE = ?",
      cleanBranch
    );
    if (existingBranch) {
      await exec(
        db,
        `UPDATE Branches
            SET Clocking_Method = ?,
                Latitude = COALESCE(?, Latitude),
                Longitude = COALESCE(?, Longitude),
                Geofence_Radius_Meters = COALESCE(?, Geofence_Radius_Meters)
          WHERE Branch_ID = ?`,
        method,
        latitude === null ? null : coerceCoord(latitude),
        longitude === null ? null : coerceCoord(longitude),
        geofenceRadiusMeters === null ? null : coerceCoord(geofenceRadiusMeters),
        existingBranch.Branch_ID
      );
    }
  }

  return lastId;
}

export async function updateTerminal(
  terminalId: number,
  patch: {
    mac?: string;
    ip?: string | null;
    location?: string | null;
    branch?: string;
    deviceName?: string | null;
    status?: "Online" | "Offline";
  } & ClockingConfigInput
) {
  const db = await getDb();
  const current = await queryOne<TerminalRow>(db, "SELECT * FROM Terminals WHERE Terminal_ID = ?", terminalId);
  if (!current) return;
  const updates: string[] = [];
  const params: SQLInputValue[] = [];
  if (patch.mac !== undefined && patch.mac.trim()) {
    updates.push("Terminal_MAC = ?");
    params.push(patch.mac.trim());
  }
  if (patch.ip !== undefined) {
    updates.push("IP_Address = ?");
    params.push(patch.ip?.trim() || "");
  }
  if (patch.location !== undefined || patch.deviceName !== undefined) {
    const loc = (patch.location !== undefined ? patch.location : current.Location_Name) ?? "";
    const dev = (patch.deviceName !== undefined ? patch.deviceName : loc) ?? "";
    const final = dev.trim() || loc.trim() || "Unnamed device";
    updates.push("Location_Name = ?");
    params.push(final);
  }
  if (patch.branch !== undefined) {
    updates.push("Branch_Name = ?");
    params.push(patch.branch.trim());
  }
  if (patch.status !== undefined) {
    updates.push("Status = ?");
    params.push(patch.status);
    updates.push("Last_Ping = ?");
    params.push(patch.status === "Online" ? Date.now() : null);
  }
  if (patch.clockingMethod !== undefined) {
    updates.push("Clocking_Method = ?");
    params.push(normalizeClockingMethod(patch.clockingMethod));
  }
  if (patch.latitude !== undefined) {
    updates.push("Latitude = ?");
    params.push(coerceCoord(patch.latitude));
  }
  if (patch.longitude !== undefined) {
    updates.push("Longitude = ?");
    params.push(coerceCoord(patch.longitude));
  }
  if (patch.geofenceRadiusMeters !== undefined) {
    updates.push("Geofence_Radius_Meters = ?");
    params.push(coerceCoord(patch.geofenceRadiusMeters));
  }
  if (updates.length === 0) return;
  params.push(terminalId);
  await exec(db, `UPDATE Terminals SET ${updates.join(", ")} WHERE Terminal_ID = ?`, ...params);

  const clockingTouched =
    patch.clockingMethod !== undefined ||
    patch.latitude !== undefined ||
    patch.longitude !== undefined ||
    patch.geofenceRadiusMeters !== undefined;
  const updatedTerm = await queryOne<TerminalRow>(db, "SELECT * FROM Terminals WHERE Terminal_ID = ?", terminalId);
  if (clockingTouched && updatedTerm && updatedTerm.Branch_Name) {
    const existingBranch = await queryOne<BranchRow>(
      db,
      "SELECT * FROM Branches WHERE Branch_Name COLLATE NOCASE = ?",
      updatedTerm.Branch_Name
    );
    if (existingBranch) {
      await exec(
        db,
        `UPDATE Branches
            SET Clocking_Method = ?,
                Latitude = ?,
                Longitude = ?,
                Geofence_Radius_Meters = ?
          WHERE Branch_ID = ?`,
        normalizeClockingMethod(updatedTerm.Clocking_Method),
        patch.latitude !== undefined ? updatedTerm.Latitude : existingBranch.Latitude,
        patch.longitude !== undefined ? updatedTerm.Longitude : existingBranch.Longitude,
        patch.geofenceRadiusMeters !== undefined
          ? updatedTerm.Geofence_Radius_Meters
          : existingBranch.Geofence_Radius_Meters,
        existingBranch.Branch_ID
      );
    }
  }
}

export async function deleteTerminal(terminalId: number) {
  await exec(await getDb(), "DELETE FROM Terminals WHERE Terminal_ID = ?", terminalId);
}

/* ------------------------------------------------------------------ */
/* Phase 15 — geofence location resolution (mobile punch validation)    */
/* ------------------------------------------------------------------ */

/** The resolved "location" a mobile GPS punch is validated against. */
export interface GeofenceLocation {
  kind: "terminal" | "branch";
  id: number;
  /** Human label — the device Location_Name or the branch name. */
  label: string;
  branch: string | null;
  method: ClockingMethod;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number | null;
}

/**
 * Decide which site/device governs a mobile punch, in priority order:
 *   1. an explicit terminal MAC (the app scanned a QR code on the device),
 *   2. an explicit branch name,
 *   3. the employee's assigned branch.
 * Returns null when nothing resolves (validation is impossible).
 */
export async function resolveGeofenceLocation(opts: {
  terminalMac?: string | null;
  branchName?: string | null;
  employeeBranch?: string | null;
}): Promise<GeofenceLocation | null> {
  const db = await getDb();
  const mac = opts.terminalMac?.trim();
  if (mac) {
    const t = await findTerminal(db, { mac });
    if (t) {
      return {
        kind: "terminal",
        id: t.Terminal_ID,
        label: t.Location_Name,
        branch: t.Branch_Name || null,
        method: normalizeClockingMethod(t.Clocking_Method),
        latitude: t.Latitude,
        longitude: t.Longitude,
        radiusMeters: t.Geofence_Radius_Meters,
      };
    }
  }

  const branch = await branchByName(opts.branchName) ?? await branchByName(opts.employeeBranch);
  if (branch) {
    return {
      kind: "branch",
      id: branch.Branch_ID,
      label: branch.Branch_Name,
      branch: branch.Branch_Name,
      method: normalizeClockingMethod(branch.Clocking_Method),
      latitude: branch.Latitude,
      longitude: branch.Longitude,
      radiusMeters: branch.Geofence_Radius_Meters,
    };
  }

  // Fallback: if the branch was configured on a Terminal (e.g. Branch 1..17) without a Branches row
  const targetBranch = (opts.branchName?.trim() || opts.employeeBranch?.trim() || "");
  if (targetBranch) {
    const term = await queryOne<TerminalRow>(
      db,
      `SELECT * FROM Terminals
        WHERE Branch_Name COLLATE NOCASE = ?
        ORDER BY (CASE WHEN Latitude IS NOT NULL AND Geofence_Radius_Meters IS NOT NULL THEN 0 ELSE 1 END), Terminal_ID
        LIMIT 1`,
      targetBranch
    );
    if (term) {
      return {
        kind: "terminal",
        id: term.Terminal_ID,
        label: term.Branch_Name || term.Location_Name,
        branch: term.Branch_Name || null,
        method: normalizeClockingMethod(term.Clocking_Method),
        latitude: term.Latitude,
        longitude: term.Longitude,
        radiusMeters: term.Geofence_Radius_Meters,
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Phase 17 — "clock in at any registered site"                        */
/*                                                                     */
/*  An employee may travel: the fence that governs a punch is the one   */
/*  they are physically standing inside, NOT the branch on their        */
/*  roster row. These helpers turn a GPS fix into that decision. They   */
/*  are the single implementation the mobile sign-in handler, the       */
/*  punch endpoint and the companion app all reason from — so the       */
/*  phone and the bridge can never disagree about where someone is.     */
/* ------------------------------------------------------------------ */

/** A site that may validate a mobile punch: mobile-capable AND geo-ready. */
export interface MobileFence {
  id: number;
  /** Branches.Branch_Name — the value the app quotes back as `branchRef`. */
  branch: string;
  method: ClockingMethod;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

/** A site plus how far a given fix sits from its centre. */
export interface MobileFenceMatch {
  site: MobileFence;
  distanceMeters: number;
  /** Inside the site's own configured radius. */
  withinGeofence: boolean;
}

/** Coerce a stored REAL/INTEGER to a usable number, or null. */
function finiteOrNull(value: number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every branch with a usable centre + radius, in branch order — whatever its
 * Clocking_Method. The mobile channel filters this down; the punch endpoint
 * also uses the full list to explain a refusal ("you are standing inside a
 * site that requires the fingerprint terminal").
 */
export async function listConfiguredBranches(): Promise<MobileFence[]> {
  const db = await getDb();
  const rows = await queryAll<BranchRow>(db, "SELECT * FROM Branches ORDER BY Branch_ID");
  const out: MobileFence[] = [];
  const seenBranches = new Set<string>();

  for (const row of rows) {
    seenBranches.add(row.Branch_Name.toLowerCase());
    const latitude = finiteOrNull(row.Latitude);
    const longitude = finiteOrNull(row.Longitude);
    const radiusMeters = finiteOrNull(row.Geofence_Radius_Meters);
    if (latitude === null || longitude === null || radiusMeters === null) continue;
    if (radiusMeters <= 0) continue;

    out.push({
      id: row.Branch_ID,
      branch: row.Branch_Name,
      method: normalizeClockingMethod(row.Clocking_Method),
      latitude,
      longitude,
      radiusMeters,
    });
  }

  // Also include any geofenced sites registered as Terminals that are not yet covered
  const termRows = await queryAll<TerminalRow>(
    db,
    "SELECT * FROM Terminals WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL AND Geofence_Radius_Meters IS NOT NULL AND Geofence_Radius_Meters > 0"
  );
  for (const t of termRows) {
    const branchName = (t.Branch_Name || t.Location_Name || `Terminal ${t.Terminal_ID}`).trim();
    if (seenBranches.has(branchName.toLowerCase())) continue;
    const latitude = finiteOrNull(t.Latitude);
    const longitude = finiteOrNull(t.Longitude);
    const radiusMeters = finiteOrNull(t.Geofence_Radius_Meters);
    if (latitude === null || longitude === null || radiusMeters === null) continue;
    if (radiusMeters <= 0) continue;

    out.push({
      id: 10000 + t.Terminal_ID,
      branch: branchName,
      method: normalizeClockingMethod(t.Clocking_Method),
      latitude,
      longitude,
      radiusMeters,
    });
    seenBranches.add(branchName.toLowerCase());
  }

  return out;
}

/**
 * Every site the mobile channel may use, in branch order.
 *
 * A site qualifies only when BOTH hold:
 *   1. its Clocking_Method permits mobile clocking (Geofence or Both), and
 *   2. it has a usable centre + radius.
 *
 * Biometric-only sites are excluded by design — they stay terminal-only, so
 * enabling "clock in anywhere" never silently opens a fingerprint-only plant
 * to GPS punches.
 */
export async function listMobileFences(): Promise<MobileFence[]> {
  return (await listConfiguredBranches()).filter((fence) => methodAllowsMobile(fence.method));
}

/** Rank a set of sites by distance from the fix, nearest first, stable on ties. */
function rankFences(
  sites: MobileFence[],
  latitude: number,
  longitude: number
): MobileFenceMatch[] {
  return sites
    .map((site) => {
      const distanceMeters = haversineMetersRounded(
        latitude,
        longitude,
        site.latitude,
        site.longitude
      );
      return { site, distanceMeters, withinGeofence: distanceMeters <= site.radiusMeters };
    })
    .sort((a, b) => a.distanceMeters - b.distanceMeters || a.site.id - b.site.id);
}

/**
 * Rank every mobile-capable site by how far the fix is from its centre,
 * nearest first. Ties fall back to branch order so the answer is stable
 * across calls — a flapping verdict would reset the dwell.
 */
export async function rankMobileFences(latitude: number, longitude: number): Promise<MobileFenceMatch[]> {
  return rankFences(await listMobileFences(), latitude, longitude);
}

/**
 * The site whose fence actually contains the fix, or null when the employee
 * is outside every registered site. Overlapping fences resolve to the nearest
 * centre.
 */
export async function findMobileFenceAt(
  latitude: number,
  longitude: number
): Promise<MobileFenceMatch | null> {
  return (await rankMobileFences(latitude, longitude)).find((match) => match.withinGeofence) ?? null;
}

/**
 * A site the employee is standing inside that does NOT accept mobile clocking
 * (Clocking_Method 'Biometric'), or null.
 *
 * Used only to explain a refusal: without this, an employee standing at a
 * fingerprint-only branch is told they are "N m from <some other branch>",
 * which sounds like a GPS fault rather than a policy. The correct answer is
 * "this site requires the terminal", so the endpoint can say exactly that.
 */
export async function findTerminalOnlyFenceAt(
  latitude: number,
  longitude: number
): Promise<MobileFenceMatch | null> {
  const terminalOnly = (await listConfiguredBranches()).filter(
    (fence) => !methodAllowsMobile(fence.method)
  );
  return rankFences(terminalOnly, latitude, longitude).find((match) => match.withinGeofence) ?? null;
}

/* ------------------------------------------------------------------ */
/* Phase 16 — companion app sign-in (Employee ID + PIN)                 */
/* ------------------------------------------------------------------ */

/**
 * Deployment-wide fallback PIN for employees with no personal PIN set.
 *
 * The companion app's PIN is a *device* credential, not an account password:
 * it unlocks the app UI and is verified here so the phone can never invent an
 * identity (anyone may type someone else's ERP id). Every employee can be
 * given their own PIN with `setEmployeeMobilePin()`; until an admin does,
 * `MOBILE_DEFAULT_PIN` applies.
 */
export const DEFAULT_MOBILE_PIN = "0000";

/** The fallback PIN the deployment currently uses. */
export function mobileDefaultPin(): string {
  return process.env.MOBILE_DEFAULT_PIN?.trim() || DEFAULT_MOBILE_PIN;
}

/** The stored digest for an employee — null when they rely on the default. */
export async function employeeMobilePinHash(employeeId: number): Promise<string | null> {
  return (
    (await queryOne<{ Mobile_PIN: string | null }>(
      await getDb(),
      "SELECT Mobile_PIN FROM Employees WHERE Employee_ID = ?",
      employeeId
    ))?.Mobile_PIN ?? null
  );
}

/** True when the employee has a personal PIN on file. */
export async function hasPersonalMobilePin(employeeId: number): Promise<boolean> {
  return await employeeMobilePinHash(employeeId) !== null;
}

/** Set (or clear, with null / "") an employee's personal mobile PIN. */
export async function setEmployeeMobilePin(employeeId: number, pin: string | null): Promise<void> {
  const trimmed = pin?.trim() ?? "";
  await exec(
    await getDb(),
    "UPDATE Employees SET Mobile_PIN = ? WHERE Employee_ID = ?",
    trimmed ? hashPassword(trimmed) : null,
    employeeId
  );
}

/**
 * Verify a companion-app PIN against the employee's personal digest, falling
 * back to the deployment default when they have none. Empty PINs never pass.
 */
export async function verifyEmployeeMobilePin(employee: EmployeeRow, pin: string): Promise<boolean> {
  const submitted = pin.trim();
  if (!submitted) return false;
  const stored = await employeeMobilePinHash(employee.Employee_ID);
  return stored ? verifyPassword(submitted, stored) : submitted === mobileDefaultPin();
}

/* ------------------------------------------------------------------ */
/* Punches                                                             */
/* ------------------------------------------------------------------ */

export interface PunchInput {
  /** ERP_User_ID / device id / any reference resolveEmployee() accepts. */
  employeeRef: string | null;
  timestamp: number;
  terminalId: number | null;
  verifyResult: VerifyResult;
  verifyMethod: string;
  rawPayload?: string | null;
  /** Omitted → inferred from the employee's punch sequence that day. */
  direction?: PunchDirection;
  /**
   * Initial ERP sync state — defaults to "Pending" (the offline buffer).
   * Geofence rejections write "Failed" so an out-of-range exception is kept
   * for audit but never drains to the ERP.
   */
  erpSyncStatus?: ErpSyncStatus;
  /** GPS captured with a geofenced mobile punch (Phase 15). */
  latitude?: number | null;
  longitude?: number | null;
  locationAccuracyMeters?: number | null;
  geofenceDistanceMeters?: number | null;
  /**
   * The site the punch was validated against (Phase 17). A mobile punch can
   * land at any registered branch, so this is the *governing* site — not the
   * employee's roster branch. Left NULL for terminal punches.
   */
  branchName?: string | null;
  /** Hardware device identifier and model name for mobile punches (Phase 19). */
  deviceId?: string | null;
  deviceName?: string | null;
}

/**
 * Alternate IN → OUT → IN … across the employee's day, starting on IN.
 * Unregistered ids (Employee_ID IS NULL) always land as IN.
 */
export async function inferDirection(employeeId: number | null, timestamp: number): Promise<PunchDirection> {
  if (employeeId === null) return "IN";
  const last = await queryOne<{ Direction: PunchDirection }>(
    await getDb(),
    `SELECT Direction FROM Attendance_Logs
      WHERE Employee_ID = ? AND Timestamp >= ? AND Timestamp <= ?
      ORDER BY Timestamp DESC, Log_ID DESC
      LIMIT 1`,
    employeeId,
    startOfTodayMs(timestamp),
    timestamp
  );
  if (!last) return "IN";
  return last.Direction === "IN" ? "OUT" : "IN";
}

/**
 * Persist one punch as Pending (offline buffer) — the single write path
 * shared by the HTTP push listener, the simulator and the admin's
 * "Ready to Clock" test widget.
 *
 * Returns the new Attendance_Logs.Log_ID so callers (e.g. the mobile geofence
 * endpoint) can echo the row they just created.
 */
export async function insertPunch(input: PunchInput): Promise<number> {
  const db = await getDb();
  const employee = input.employeeRef ? await resolveEmployee(db, input.employeeRef) : null;
  const employeeId = employee?.Employee_ID ?? null;
  const direction = input.direction ?? await inferDirection(employeeId, input.timestamp);

  const { lastId } = await run(
    db,
    `INSERT INTO Attendance_Logs
       (Employee_ID, Timestamp, Terminal_ID, ERP_Sync_Status, Verify_Result, Direction, Verify_Method, Raw_Payload,
        Latitude, Longitude, Location_Accuracy_Meters, Geofence_Distance_Meters, Branch_Name, Device_ID, Device_Name, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    employeeId,
    input.timestamp,
    input.terminalId,
    input.erpSyncStatus ?? "Pending",
    input.verifyResult,
    direction,
    input.verifyMethod,
    input.rawPayload ?? null,
    input.latitude ?? null,
    input.longitude ?? null,
    input.locationAccuracyMeters ?? null,
    input.geofenceDistanceMeters ?? null,
    input.branchName ?? null,
    input.deviceId ?? null,
    input.deviceName ?? null,
    Date.now()
  );
  return lastId;
}

/** Latest punch today per employee (simulator's anti-repeat guard). */
export async function todayPunchesByEmployee(): Promise<Map<number, { ts: number; terminalId: number | null }>> {
  const rows = await queryAll<{ Employee_ID: number; ts: number; terminalId: number | null }>(
    await getDb(),
    `SELECT l.Employee_ID, l.Timestamp AS ts, l.Terminal_ID AS terminalId
       FROM Attendance_Logs l
       JOIN (SELECT Employee_ID, MAX(Timestamp) AS m
               FROM Attendance_Logs
              WHERE Employee_ID IS NOT NULL AND Timestamp >= ?
              GROUP BY Employee_ID) x
         ON x.Employee_ID = l.Employee_ID AND x.m = l.Timestamp
      WHERE l.Employee_ID IS NOT NULL`,
    startOfTodayMs()
  );
  const map = new Map<number, { ts: number; terminalId: number | null }>();
  for (const r of rows) map.set(r.Employee_ID, { ts: r.ts, terminalId: r.terminalId });
  return map;
}

/** Earliest recorded punch for one employee (null = no records yet). */
export async function getEmployeeFirstLog(employeeId: number): Promise<number | null> {
  const row = await queryOne<{ ts: number | null }>(
    await getDb(),
    "SELECT MIN(Timestamp) AS ts FROM Attendance_Logs WHERE Employee_ID = ?",
    employeeId
  );
  return row?.ts ?? null;
}

/** One employee's punches inside a window (timesheet builder input). */
export async function getEmployeeLogs(
  employeeId: number,
  fromMs: number,
  toMs: number
): Promise<EmployeePunchRow[]> {
  return await queryAll<EmployeePunchRow>(
    await getDb(),
    `SELECT l.Log_ID, l.Timestamp, l.Direction, l.Verify_Result, l.ERP_Sync_Status,
            t.Location_Name, t.Branch_Name
       FROM Attendance_Logs l
       LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
      WHERE l.Employee_ID = ? AND l.Timestamp >= ? AND l.Timestamp <= ?
      ORDER BY l.Timestamp ASC, l.Log_ID ASC`,
    employeeId,
    fromMs,
    toMs
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

/** Feed window — the newest N punches rendered by the live scan feed. */
const FEED_LIMIT = 40;

export async function getDashboard(): Promise<{ metrics: DashboardMetrics; summary: AttendanceSummary; feed: FeedEntry[] }> {
  const db = await getDb();
  const dayStart = startOfTodayMs();

  const terminalsTotal = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Terminals"))?.c ?? 0;
  const terminalsOnline =
    (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Terminals WHERE Status = 'Online'"))?.c ?? 0;
  const scansToday =
    (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE Timestamp >= ?", dayStart))?.c ?? 0;
  const clockedInToday =
    (await queryOne<{ c: number }>(
      db,
      `SELECT COUNT(DISTINCT Employee_ID) AS c FROM Attendance_Logs
        WHERE Timestamp >= ? AND Employee_ID IS NOT NULL AND Verify_Result = 'Verified'`,
      dayStart
    ))?.c ?? 0;
  const pendingSync =
    (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE ERP_Sync_Status = 'Pending'"))?.c ?? 0;
  const syncedToday =
    (await queryOne<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE ERP_Sync_Status = 'Success' AND Created_At >= ?",
      dayStart
    ))?.c ?? 0;

  const metrics: DashboardMetrics = {
    clockedInToday,
    scansToday,
    terminalsOnline,
    terminalsTotal,
    pendingSync,
    syncedToday,
  };

  const feedRows = await queryAll<FeedRow>(
    db,
    `SELECT l.Log_ID, l.Timestamp, l.ERP_Sync_Status, l.Verify_Result, l.Direction,
            e.Full_Name, e.ERP_User_ID, t.Location_Name, t.IP_Address, t.Branch_Name,
            CASE WHEN l.Employee_ID IS NULL THEN NULL ELSE (
              SELECT COUNT(*) FROM Attendance_Logs l2
               WHERE l2.Employee_ID = l.Employee_ID
                 AND l2.Timestamp >= ?
                 AND l2.Timestamp <= l.Timestamp
            ) END AS Day_Seq
       FROM Attendance_Logs l
       LEFT JOIN Employees e ON e.Employee_ID = l.Employee_ID
       LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
      ORDER BY l.Log_ID DESC
      LIMIT ?`,
    dayStart,
    FEED_LIMIT
  );

  const feed: FeedEntry[] = feedRows.map((r) => ({
    logId: r.Log_ID,
    employeeName: r.Full_Name ?? "Unregistered ID",
    erpUserId: r.ERP_User_ID,
    timestamp: r.Timestamp,
    location: r.Location_Name ?? "Unregistered device",
    branchName: r.Branch_Name,
    daySeq: r.Day_Seq,
    verifyResult: r.Verify_Result,
    syncStatus: r.ERP_Sync_Status,
    direction: r.Direction,
    registered: r.Full_Name !== null,
  }));

  return { metrics, summary: await getAttendanceSummary(), feed };
}

/** Shift start times after midnight, in milliseconds (used by getAttendanceSummary). */
const SHIFT_STARTS: Record<number, number> = {
  1: 6 * 3_600_000, // Morning 06:00
  2: 8 * 3_600_000, // Day 08:00
  3: 14 * 3_600_000, // Evening 14:00
  4: 22 * 3_600_000, // Night 22:00
};

/**
 * Headline split for the four summary cards + the attendance doughnut.
 * Each employee's shift start (from Shifts table / Shift_ID) decides
 * Present (first punch ≤ shift start) vs Late (first punch > shift start);
 * nobody punched → Absent. Buckets always sum to the roster size.
 */
export async function getAttendanceSummary(): Promise<AttendanceSummary> {
  const dayStart = startOfTodayMs();
  const rows = await queryAll<{
    Employee_ID: number;
    Shift_ID: number | null;
    firstPunch: number | null;
  }>(
    await getDb(),
    `SELECT e.Employee_ID, e.Shift_ID,
            (SELECT MIN(l.Timestamp) FROM Attendance_Logs l
              WHERE l.Employee_ID = e.Employee_ID
                AND l.Timestamp >= ? AND l.Verify_Result = 'Verified') AS firstPunch
       FROM Employees e`,
    dayStart
  );

  let present = 0;
  let late = 0;
  let absent = 0;
  for (const r of rows) {
    if (r.firstPunch === null || r.firstPunch === undefined) {
      absent++;
    } else {
      const shiftStart = SHIFT_STARTS[r.Shift_ID ?? 2]; // default to Day 08:00
      if (r.firstPunch <= shiftStart) present++;
      else late++;
    }
  }
  return { total: rows.length, present, late, absent };
}

/* ------------------------------------------------------------------ */
/* Exceptions (Phase 4 drill-down)                                     */
/* ------------------------------------------------------------------ */

interface TodayPunch {
  Employee_ID: number;
  ERP_User_ID: string;
  Full_Name: string;
  Department: string;
  Timestamp: number;
  Direction: PunchDirection;
  Branch_Name: string | null;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** Whole minutes of variance against a baseline (negative = early). */
const minutesFrom = (timestamp: number, baseline: number) =>
  Math.round((timestamp - baseline) / MINUTE_MS);

/**
 * Six-bucket exception engine.
 *
 *   type = null  → summary: `counts` for every widget box, `rows` = []
 *   type given   → that bucket's employees (+ refreshed counts)
 *
 * Baselines: arrival 08:00 · departure window 17:00 → 18:00 ·
 * no_show = enrolled with no verified punch (from 08:00) ·
 * missing_punch = an unpairable IN/OUT sequence.
 */
export async function getExceptions(type: ExceptionType | null): Promise<ExceptionsResponse> {
  const db = await getDb();
  const dayStart = startOfTodayMs();
  const now = Date.now();
  const at08 = dayStart + 8 * HOUR_MS;
  const at17 = dayStart + 17 * HOUR_MS;
  const at18 = dayStart + 18 * HOUR_MS;

  const punches = await queryAll<TodayPunch>(
    db,
    `SELECT l.Employee_ID, l.Timestamp, l.Direction,
            e.ERP_User_ID, e.Full_Name, e.Department, t.Branch_Name
       FROM Attendance_Logs l
       JOIN Employees e ON e.Employee_ID = l.Employee_ID
       LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
      WHERE l.Timestamp >= ? AND l.Verify_Result = 'Verified'
      ORDER BY l.Employee_ID, l.Timestamp, l.Log_ID`,
    dayStart
  );

  const byEmployee = new Map<number, TodayPunch[]>();
  for (const p of punches) {
    const list = byEmployee.get(p.Employee_ID);
    if (list) list.push(p);
    else byEmployee.set(p.Employee_ID, [p]);
  }

  const bucket: Record<ExceptionType, ExceptionRow[]> = {
    arrived_early: [],
    arrived_late: [],
    left_early: [],
    left_late: [],
    no_show: [],
    missing_punch: [],
  };

  const toRow = (p: TodayPunch, varianceMin: number | null, note?: ExceptionRow["note"]) => ({
    employeeId: p.Employee_ID,
    erpUserId: p.ERP_User_ID,
    fullName: p.Full_Name,
    department: p.Department,
    branchName: p.Branch_Name,
    timestamp: p.Timestamp,
    varianceMin,
    ...(note ? { note } : {}),
  });

  for (const list of byEmployee.values()) {
    const first = list[0];
    const last = list[list.length - 1];

    // Arrival -------------------------------------------------------
    if (first.Timestamp < at08) {
      bucket.arrived_early.push(toRow(first, minutesFrom(first.Timestamp, at08)));
    } else if (first.Timestamp > at08) {
      bucket.arrived_late.push(toRow(first, minutesFrom(first.Timestamp, at08)));
    }

    // Departure -----------------------------------------------------
    if (last.Direction === "OUT") {
      if (last.Timestamp < at17) {
        bucket.left_early.push(toRow(last, minutesFrom(last.Timestamp, at17)));
      } else if (last.Timestamp > at18) {
        bucket.left_late.push(toRow(last, minutesFrom(last.Timestamp, at18)));
      }
    }

    // Structural gaps -----------------------------------------------
    if (first.Direction === "OUT") {
      bucket.missing_punch.push(toRow(first, null, "missing_in"));
    } else if (list.length % 2 === 1) {
      bucket.missing_punch.push(toRow(last, null, "missing_out"));
    }
  }

  // No show: enrolled employees with no verified punch today (from 08:00).
  if (now >= at08) {
    const attended = byEmployee;
    const roster = await queryAll<{
      Employee_ID: number;
      ERP_User_ID: string;
      Full_Name: string;
      Department: string;
    }>(
      db,
      "SELECT Employee_ID, ERP_User_ID, Full_Name, Department FROM Employees WHERE Fingerprint_Enrolled = 1 ORDER BY Full_Name"
    );
    for (const e of roster) {
      if (attended.has(e.Employee_ID)) continue;
      bucket.no_show.push({
        employeeId: e.Employee_ID,
        erpUserId: e.ERP_User_ID,
        fullName: e.Full_Name,
        department: e.Department,
        branchName: null,
        timestamp: null,
        varianceMin: null,
        note: "no_punch",
      });
    }
  }

  // Consistent ordering: biggest deviation first, names A→Z otherwise.
  for (const t of ["arrived_early", "arrived_late", "left_early", "left_late"] as ExceptionType[]) {
    bucket[t].sort((a, b) => Math.abs(b.varianceMin ?? 0) - Math.abs(a.varianceMin ?? 0));
  }
  bucket.no_show.sort((a, b) => a.fullName.localeCompare(b.fullName));
  bucket.missing_punch.sort((a, b) => a.fullName.localeCompare(b.fullName));

  const counts = Object.fromEntries(
    EXCEPTION_TYPES.map((t) => [t, bucket[t].length])
  ) as Record<ExceptionType, number>;

  return {
    type,
    label: type ? EXCEPTION_LABELS[type] : null,
    rule: type ? EXCEPTION_RULES[type] : null,
    rows: type ? bucket[type] : [],
    counts,
    generatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Reports & Analytics (Phase 9 — live data)                           */
/* ------------------------------------------------------------------ */

const REPORT_DAYS_DEFAULT = 7;
const REPORT_DAYS_MAX = 31;
/** Cap on table rows; CSV exports still use the full attendance set. */
const REPORT_EVENT_LIMIT = 250;
const DAY_CODES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

interface ReportEmployee {
  Employee_ID: number;
  ERP_User_ID: string;
  Full_Name: string;
  Department: string;
  Branch_Name: string;
  Shift_ID: number | null;
  Status: string;
  Created_At: number;
}

interface ReportPunch {
  Log_ID: number;
  Employee_ID: number;
  Timestamp: number;
  Direction: PunchDirection;
  Log_Branch: string | null;
  Terminal_Branch: string | null;
}

interface ReportShift {
  startMin: number;
  endMin: number;
  days: Set<string>;
}

/** Fallback when an employee has no shift assigned: Mon–Fri, 08:00–17:00. */
const DEFAULT_REPORT_SHIFT: ReportShift = {
  startMin: 8 * 60,
  endMin: 17 * 60,
  days: new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]),
};

/** "08:30" → 510 minutes; malformed input falls back. */
function clockMinutes(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})/.exec((value ?? "").trim());
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "+45 mins" / "-32 mins" / "—". */
function varianceText(minutes: number | null): string {
  if (minutes === null) return "—";
  return `${minutes > 0 ? "+" : ""}${minutes} mins`;
}

const TREND_FIELDS: Record<ReportsExceptionKind, keyof Omit<ReportsTrendPoint, "date">> = {
  arrived_early: "arrivedEarly",
  arrived_late: "arrivedLate",
  left_early: "leftEarly",
  left_late: "leftLate",
  missing_punch: "missingPunch",
  no_show: "noShow",
};

/**
 * Live Reports & Analytics aggregate over a rolling window of calendar days.
 *
 * Baselines come from the roster's own shift (Shifts.Start_Time / End_Time /
 * Days) with an 08:00–17:00 Mon–Fri fallback, so a "late arrival" means late
 * for that employee rather than late for the day shift. Departures get the
 * same one-hour grace the exception widget uses (end → end + 60 min).
 *
 * No-shows are scheduled employee-days with no verified punch. Today only
 * starts counting once the employee's shift has begun, and an employee is
 * never counted before their Created_At. Everything is derived from
 * Attendance_Logs + Employees + Terminals; there are no demo rows here.
 */
export async function getReports(days: number = REPORT_DAYS_DEFAULT): Promise<ReportsResponse> {
  const windowDays = Math.min(REPORT_DAYS_MAX, Math.max(1, Math.floor(days)));
  const db = await getDb();
  const now = Date.now();

  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const todayStart = base.getTime();

  const dayList = Array.from({ length: windowDays }, (_, index) => {
    const date = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() - (windowDays - 1 - index)
    );
    const startMs = date.getTime();
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    return { key: dateKeyOf(startMs), date, startMs, endMs: next.getTime() };
  });

  const fromMs = dayList[0].startMs;
  const toMs = dayList[dayList.length - 1].endMs;

  const employees = await queryAll<ReportEmployee>(
    db,
    `SELECT Employee_ID, ERP_User_ID, Full_Name, Department, Branch_Name, Shift_ID, Status, Created_At
       FROM Employees`
  );
  const punches = await queryAll<ReportPunch>(
    db,
    `SELECT l.Log_ID, l.Employee_ID, l.Timestamp, l.Direction,
            l.Branch_Name AS Log_Branch, t.Branch_Name AS Terminal_Branch
       FROM Attendance_Logs l
       LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
      WHERE l.Timestamp >= ? AND l.Timestamp < ?
        AND l.Employee_ID IS NOT NULL
        AND l.Verify_Result = 'Verified'
      ORDER BY l.Employee_ID, l.Timestamp, l.Log_ID`,
    fromMs,
    toMs
  );
  const shifts = await listShifts();

  const shiftById = new Map<number, ReportShift>();
  for (const shift of shifts) {
    shiftById.set(shift.Shift_ID, {
      startMin: clockMinutes(shift.Start_Time, DEFAULT_REPORT_SHIFT.startMin),
      endMin: clockMinutes(shift.End_Time, DEFAULT_REPORT_SHIFT.endMin),
      days: new Set(
        (shift.Days ?? "")
          .split(",")
          .map((day) => day.trim())
          .filter(Boolean)
      ),
    });
  }

  const employeeById = new Map(employees.map((employee) => [employee.Employee_ID, employee]));
  const dayByKey = new Map(dayList.map((day) => [day.key, day]));
  const trendByKey = new Map<string, ReportsTrendPoint>(
    dayList.map((day) => [
      day.key,
      {
        date: day.key,
        arrivedEarly: 0,
        arrivedLate: 0,
        leftEarly: 0,
        leftLate: 0,
        missingPunch: 0,
        noShow: 0,
      },
    ])
  );

  // Group verified punches by employee × local calendar day.
  const groups = new Map<string, ReportPunch[]>();
  for (const punch of punches) {
    if (!employeeById.has(punch.Employee_ID)) continue;
    const key = `${punch.Employee_ID}:${dateKeyOf(punch.Timestamp)}`;
    const list = groups.get(key);
    if (list) list.push(punch);
    else groups.set(key, [punch]);
  }

  type PendingEvent = Omit<ReportsEvent, "id">;
  const pendingEvents: PendingEvent[] = [];
  const branchCounts = new Map<string, number>();
  const lateEmployees = new Set<number>();
  const counts: Record<ReportsExceptionKind, number> = {
    arrived_early: 0,
    arrived_late: 0,
    left_early: 0,
    left_late: 0,
    missing_punch: 0,
    no_show: 0,
  };
  const attendance: ReportsAttendanceRow[] = [];
  let expectedDays = 0;
  let attendedDays = 0;

  const shiftFor = (employee: ReportEmployee): ReportShift =>
    employee.Shift_ID !== null
      ? shiftById.get(employee.Shift_ID) ?? DEFAULT_REPORT_SHIFT
      : DEFAULT_REPORT_SHIFT;

  const branchOf = (list: ReportPunch[], employee: ReportEmployee): string => {
    for (const punch of list) {
      const branch =
        (punch.Log_Branch ?? "").trim() || (punch.Terminal_Branch ?? "").trim();
      if (branch) return branch;
    }
    return (employee.Branch_Name ?? "").trim() || "Unassigned";
  };

  const recordException = (
    kind: ReportsExceptionKind,
    employee: ReportEmployee,
    dayKey: string,
    branch: string,
    timestamp: number | null,
    varianceMin: number | null
  ): void => {
    const trend = trendByKey.get(dayKey);
    if (!trend) return;

    trend[TREND_FIELDS[kind]] += 1;
    counts[kind] += 1;
    if (kind === "arrived_late") lateEmployees.add(employee.Employee_ID);
    branchCounts.set(branch, (branchCounts.get(branch) ?? 0) + 1);
    pendingEvents.push({
      date: dayKey,
      employeeId: employee.Employee_ID,
      employeeName: employee.Full_Name,
      department: employee.Department,
      branch,
      exceptionType: EXCEPTION_LABELS[kind] as ReportsEvent["exceptionType"],
      variance: varianceText(varianceMin),
      varianceMin,
      timestamp,
    });
  };

  for (const [key, list] of groups) {
    const [employeeRaw, dayKey] = key.split(":");
    const employee = employeeById.get(Number(employeeRaw));
    const day = dayByKey.get(dayKey);
    if (!employee || !day) continue;

    const shift = shiftFor(employee);
    const scheduled = shift.days.has(DAY_CODES[day.date.getDay()]);
    if (scheduled && employee.Created_At <= day.endMs) {
      expectedDays += 1;
      attendedDays += 1;
    }

    const first = list[0];
    const last = list[list.length - 1];
    const branch = branchOf(list, employee);
    const shiftStartMs = day.startMs + shift.startMin * MINUTE_MS;
    // Overnight shifts (end ≤ start) finish on the following day.
    const endMin = shift.endMin <= shift.startMin ? shift.endMin + 24 * 60 : shift.endMin;
    const shiftEndMs = day.startMs + endMin * MINUTE_MS;

    let workedMs = 0;
    let openSince: number | null = null;
    for (const punch of list) {
      if (punch.Direction === "IN") {
        if (openSince === null) openSince = punch.Timestamp;
      } else if (openSince !== null) {
        workedMs += punch.Timestamp - openSince;
        openSince = null;
      }
    }

    if (first.Timestamp < shiftStartMs) {
      recordException(
        "arrived_early",
        employee,
        dayKey,
        branch,
        first.Timestamp,
        minutesFrom(first.Timestamp, shiftStartMs)
      );
    } else if (first.Timestamp > shiftStartMs) {
      recordException(
        "arrived_late",
        employee,
        dayKey,
        branch,
        first.Timestamp,
        minutesFrom(first.Timestamp, shiftStartMs)
      );
    }

    if (last.Direction === "OUT") {
      if (last.Timestamp < shiftEndMs) {
        recordException(
          "left_early",
          employee,
          dayKey,
          branch,
          last.Timestamp,
          minutesFrom(last.Timestamp, shiftEndMs)
        );
      } else if (last.Timestamp > shiftEndMs + HOUR_MS) {
        recordException(
          "left_late",
          employee,
          dayKey,
          branch,
          last.Timestamp,
          minutesFrom(last.Timestamp, shiftEndMs + HOUR_MS)
        );
      }
    }

    if (first.Direction === "OUT") {
      recordException("missing_punch", employee, dayKey, branch, first.Timestamp, null);
    } else if (list.length % 2 === 1) {
      recordException("missing_punch", employee, dayKey, branch, last.Timestamp, null);
    }

    attendance.push({
      date: dayKey,
      employeeId: employee.Employee_ID,
      employeeName: employee.Full_Name,
      department: employee.Department,
      branch,
      clockIn: first.Timestamp,
      clockOut: last.Direction === "OUT" ? last.Timestamp : null,
      workedMs,
      status:
        first.Direction === "OUT"
          ? "Missing Punch"
          : last.Direction === "IN"
          ? "In Progress"
          : "Present",
    });
  }

  // No-shows: scheduled employee-days with no verified punch.
  for (const employee of employees) {
    if ((employee.Status ?? "").trim().toLowerCase() === "inactive") continue;
    const shift = shiftFor(employee);

    for (const day of dayList) {
      if (employee.Created_At >= day.endMs) continue;
      if (!shift.days.has(DAY_CODES[day.date.getDay()])) continue;
      if (groups.has(`${employee.Employee_ID}:${day.key}`)) continue;

      const shiftStartMs = day.startMs + shift.startMin * MINUTE_MS;
      // Today is not a no-show until the shift has actually started.
      if (day.startMs === todayStart && now < shiftStartMs) continue;

      expectedDays += 1;
      const branch = (employee.Branch_Name ?? "").trim() || "Unassigned";
      recordException("no_show", employee, day.key, branch, shiftStartMs, null);
      attendance.push({
        date: day.key,
        employeeId: employee.Employee_ID,
        employeeName: employee.Full_Name,
        department: employee.Department,
        branch,
        clockIn: null,
        clockOut: null,
        workedMs: 0,
        status: "Absent",
      });
    }
  }

  attendance.sort(
    (a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName)
  );

  pendingEvents.sort(
    (a, b) =>
      (b.timestamp ?? 0) - (a.timestamp ?? 0) ||
      a.employeeName.localeCompare(b.employeeName)
  );
  const events = pendingEvents.slice(0, REPORT_EVENT_LIMIT).map((event, index) => ({
    ...event,
    id: `EXC-${String(index + 1).padStart(4, "0")}`,
  }));

  const trends = dayList.map(
    (day) => trendByKey.get(day.key) as ReportsTrendPoint
  );

  const branches: ReportsBranchRow[] = [...branchCounts.entries()]
    .map(([branchName, totalExceptions]) => ({ branchName, totalExceptions }))
    .sort(
      (a, b) =>
        b.totalExceptions - a.totalExceptions ||
        a.branchName.localeCompare(b.branchName)
    );

  const totalExceptions = (Object.values(counts) as number[]).reduce(
    (sum, value) => sum + value,
    0
  );
  const peak = trends.reduce(
    (best, point) => {
      const total =
        point.arrivedEarly +
        point.arrivedLate +
        point.leftEarly +
        point.leftLate +
        point.missingPunch +
        point.noShow;
      return total > best.total ? { date: point.date, total } : best;
    },
    { date: trends[trends.length - 1]?.date ?? "", total: 0 }
  );
  const rosterSize = employees.length;
  const onTimeRate =
    rosterSize > 0
      ? Math.round(((rosterSize - lateEmployees.size) / rosterSize) * 100)
      : 100;
  const attendanceRate =
    expectedDays > 0 ? Math.round((attendedDays / expectedDays) * 100) : 100;

  const summary: ReportsSummary = {
    windowDays,
    windowFrom: dayList[0].key,
    windowTo: dayList[dayList.length - 1].key,
    rosterSize,
    totalExceptions,
    counts,
    branchesCovered: branchCounts.size,
    onTimeRate,
    attendanceRate,
    averagePerDay: Number((totalExceptions / windowDays).toFixed(1)),
    peakDay: peak.date,
    peakDayTotal: peak.total,
  };

  return {
    trends,
    branches,
    events,
    attendance,
    summary,
    generatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Attendance records (Phase 11 — /attendance-records)                 */
/* ------------------------------------------------------------------ */

export interface AttendanceRecordsQuery {
  fromMs: number;
  toMs: number;
  department?: string;
  shiftId?: number | null;
  page?: number;
  pageSize?: number;
}

interface JoinedPunch {
  Employee_ID: number;
  ERP_User_ID: string;
  Full_Name: string;
  Department: string;
  Position: string;
  Shift_ID: number | null;
  Log_ID: number;
  Timestamp: number;
  Direction: PunchDirection;
}

/**
 * Day-grouped attendance rows with pagination + filter metadata.
 * Worked time = sum of completed IN → OUT pairs (breaks excluded).
 */
export async function listAttendanceRecords(
  opts: AttendanceRecordsQuery
): Promise<{ rows: AttendanceRecord[]; total: number; page: number; pageSize: number; pages: number }> {
  const db = await getDb();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 25));

  const rows = await queryAll<JoinedPunch>(
    db,
    `SELECT e.Employee_ID, e.ERP_User_ID, e.Full_Name, e.Department, e.Position, e.Shift_ID,
            l.Log_ID, l.Timestamp, l.Direction
       FROM Attendance_Logs l
       JOIN Employees e ON e.Employee_ID = l.Employee_ID
      WHERE l.Timestamp >= ? AND l.Timestamp < ?
      ORDER BY l.Timestamp ASC, l.Log_ID ASC`,
    opts.fromMs,
    opts.toMs
  );

  // Group by employee × local day.
  const groups = new Map<string, { head: JoinedPunch; punches: JoinedPunch[] }>();
  for (const r of rows) {
    const key = `${r.Employee_ID}:${dateKeyOf(r.Timestamp)}`;
    const existing = groups.get(key);
    if (existing) existing.punches.push(r);
    else groups.set(key, { head: r, punches: [r] });
  }

  const shiftNames = new Map((await listShifts()).map((s) => [s.Shift_ID, s.Name]));

  const records: AttendanceRecord[] = [];
  for (const [key, group] of groups) {
    const list = group.punches;
    const head = group.head;
    const first = list[0];
    const last = list[list.length - 1];
    const startsWrong = first.Direction === "OUT";
    const openShift = list.length % 2 === 1;

    let workedMs = 0;
    let openSince: number | null = null;
    for (const p of list) {
      if (p.Direction === "IN") {
        if (openSince === null) openSince = p.Timestamp;
      } else if (openSince !== null) {
        workedMs += p.Timestamp - openSince;
        openSince = null;
      }
    }

    records.push({
      key,
      dateMs: first.Timestamp,
      employeeId: head.Employee_ID,
      erpUserId: head.ERP_User_ID,
      fullName: head.Full_Name,
      department: head.Department,
      position: head.Position,
      shiftId: head.Shift_ID,
      shiftName: head.Shift_ID !== null ? (shiftNames.get(head.Shift_ID) ?? null) : null,
      clockIn: first.Timestamp,
      clockOut: last.Direction === "OUT" ? last.Timestamp : null,
      workedMs,
      status: startsWrong ? "Missing Punch" : openShift ? "In Progress" : "Present",
    });
  }

  records.sort((a, b) => b.dateMs - a.dateMs || a.fullName.localeCompare(b.fullName));

  const filtered = records.filter((r) => {
    if (opts.department && r.department !== opts.department) return false;
    if (opts.shiftId != null && r.shiftId !== opts.shiftId) return false;
    return true;
  });

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;

  return {
    rows: filtered.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    pages,
  };
}

/* ------------------------------------------------------------------ */
/* ERP sync engine data                                                */
/* ------------------------------------------------------------------ */

/** Oldest Pending records waiting in the offline buffer (max 200). */
export async function getPendingLogs(limit: number): Promise<ErpLogRow[]> {
  return await queryAll<ErpLogRow>(
    await getDb(),
    `SELECT l.Log_ID, l.Timestamp, l.Direction, l.Verify_Method,
            e.ERP_User_ID, e.Full_Name,
            t.Terminal_MAC, t.IP_Address, t.Location_Name, t.Branch_Name
       FROM Attendance_Logs l
       LEFT JOIN Employees e ON e.Employee_ID = l.Employee_ID
       LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
      WHERE l.ERP_Sync_Status = 'Pending'
      ORDER BY l.Log_ID ASC
      LIMIT ?`,
    Math.max(1, limit)
  );
}

/** Pack the given log ids into the exact JSON envelope pushed to the ERP. */
export async function buildErpPayload(logIds: number[], batchRef: string): Promise<ErpBatchPayload> {
  if (logIds.length === 0) {
    return {
      batch_ref: batchRef,
      source: "TA-BRIDGE",
      pushed_at: new Date().toISOString(),
      record_count: 0,
      records: [],
    };
  }

  const rows = await queryAll<ErpLogRow>(
    await getDb(),
    `SELECT l.Log_ID, l.Timestamp, l.Direction, l.Verify_Method,
            e.ERP_User_ID, e.Full_Name,
            t.Terminal_MAC, t.IP_Address, t.Location_Name, t.Branch_Name
       FROM Attendance_Logs l
       LEFT JOIN Employees e ON e.Employee_ID = l.Employee_ID
       LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
      WHERE l.Log_ID IN (${placeholders(logIds.length)})
      ORDER BY l.Log_ID ASC`,
    ...logIds
  );

  return {
    batch_ref: batchRef,
    source: "TA-BRIDGE",
    pushed_at: new Date().toISOString(),
    record_count: rows.length,
    records: rows.map((r) => ({
      log_id: r.Log_ID,
      employee_ref: r.ERP_User_ID,
      employee_name: r.Full_Name,
      direction: r.Direction,
      punch_time: formatPunchTime(r.Timestamp),
      timestamp_ms: r.Timestamp,
      verify_method: r.Verify_Method,
      terminal: {
        mac: r.Terminal_MAC,
        ip: r.IP_Address,
        location: r.Location_Name,
        branch: r.Branch_Name,
      },
    })),
  };
}

/** Mark a batch delivered — ERP answered 200. */
export async function markLogsSynced(logIds: number[]): Promise<void> {
  if (logIds.length === 0) return;
  await exec(
    await getDb(),
    `UPDATE Attendance_Logs SET ERP_Sync_Status = 'Success' WHERE Log_ID IN (${placeholders(logIds.length)})`,
    ...logIds
  );
}

/** Quarantine a batch — ERP rejected the records (4xx). */
export async function markLogsFailed(logIds: number[]): Promise<void> {
  if (logIds.length === 0) return;
  await exec(
    await getDb(),
    `UPDATE Attendance_Logs SET ERP_Sync_Status = 'Failed' WHERE Log_ID IN (${placeholders(logIds.length)})`,
    ...logIds
  );
}

export async function countSyncBatches(): Promise<number> {
  return (await queryOne<{ c: number }>(await getDb(), "SELECT COUNT(*) AS c FROM Erp_Sync_Batches"))?.c ?? 0;
}

export interface SyncBatchInput {
  recordCount: number;
  status: "Success" | "Failed";
  responseCode: number | null;
  errorMessage: string | null;
  durationMs: number | null;
  trigger: "Manual" | "Auto";
  payload: ErpBatchPayload;
}

/** Record one push attempt (payload retained verbatim for diagnostics). */
export async function insertSyncBatch(input: SyncBatchInput): Promise<SyncBatchRow> {
  const db = await getDb();
  const { lastId } = await run(
    db,
    `INSERT INTO Erp_Sync_Batches
       (Created_At, Record_Count, Status, Response_Code, Error_Message, Duration_MS, Trigger_Source, Payload_JSON)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    Date.now(),
    input.recordCount,
    input.status,
    input.responseCode,
    input.errorMessage,
    input.durationMs,
    input.trigger,
    JSON.stringify(input.payload)
  );
  const row = await queryOne<SyncBatchRow>(
    db,
    "SELECT * FROM Erp_Sync_Batches WHERE Batch_ID = ?",
    lastId
  );
  if (!row) throw new Error("Failed to record the ERP sync batch");
  return row;
}

/** Snapshot behind /sync + the dashboard's sync panels. */
export async function getSyncOverview(): Promise<Pick<ErpSyncGetResponse, "stats" | "batches" | "backlog">> {
  const db = await getDb();
  const dayStart = startOfTodayMs();

  const stats: SyncStats = {
    pendingLogs:
      (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE ERP_Sync_Status = 'Pending'"))?.c ?? 0,
    syncedToday:
      (await queryOne<{ c: number }>(
        db,
        "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE ERP_Sync_Status = 'Success' AND Created_At >= ?",
        dayStart
      ))?.c ?? 0,
    successBatches:
      (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Erp_Sync_Batches WHERE Status = 'Success'"))?.c ?? 0,
    failedBatches:
      (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Erp_Sync_Batches WHERE Status = 'Failed'"))?.c ?? 0,
    lastBatchAt:
      (await queryOne<{ v: number | null }>(db, "SELECT MAX(Created_At) AS v FROM Erp_Sync_Batches"))?.v ?? null,
    lastSuccessAt:
      (await queryOne<{ v: number | null }>(
        db,
        "SELECT MAX(Created_At) AS v FROM Erp_Sync_Batches WHERE Status = 'Success'"
      ))?.v ?? null,
  };

  const batchRows = await queryAll<SyncBatchRow>(
    db,
    "SELECT * FROM Erp_Sync_Batches ORDER BY Batch_ID DESC LIMIT 25"
  );
  const batches: SyncBatchDto[] = batchRows.map((b) => {
    let payload: ErpBatchPayload | null = null;
    try {
      payload = JSON.parse(b.Payload_JSON) as ErpBatchPayload;
    } catch {
      payload = null;
    }
    return {
      batchId: b.Batch_ID,
      createdAt: b.Created_At,
      recordCount: b.Record_Count,
      status: b.Status,
      responseCode: b.Response_Code,
      errorMessage: b.Error_Message,
      durationMs: b.Duration_MS,
      trigger: b.Trigger_Source === "Manual" ? "Manual" : "Auto",
      payload,
    };
  });

  const backlogRows = await queryAll<{
    Log_ID: number;
    Timestamp: number;
    Full_Name: string | null;
    ERP_User_ID: string | null;
    Location_Name: string | null;
    Branch_Name: string | null;
  }>(
    db,
    `SELECT l.Log_ID, l.Timestamp, e.Full_Name, e.ERP_User_ID, t.Location_Name, t.Branch_Name
       FROM Attendance_Logs l
       LEFT JOIN Employees e ON e.Employee_ID = l.Employee_ID
       LEFT JOIN Terminals t ON t.Terminal_ID = l.Terminal_ID
      WHERE l.ERP_Sync_Status = 'Pending'
      ORDER BY l.Log_ID ASC
      LIMIT 20`
  );
  const now = Date.now();
  const backlog: BacklogEntry[] = backlogRows.map((r) => ({
    logId: r.Log_ID,
    employeeName: r.Full_Name ?? "Unregistered ID",
    erpUserId: r.ERP_User_ID,
    timestamp: r.Timestamp,
    location: r.Location_Name ?? "Unregistered device",
    branchName: r.Branch_Name,
    ageMs: Math.max(0, now - r.Timestamp),
  }));

  return { stats, batches, backlog };
}

/* ------------------------------------------------------------------ */
/* Phase 18 — Geofence activity report                                 */
/* ------------------------------------------------------------------ */

/** One mobile GPS punch, joined to its employee, for the activity report. */
export interface GeoActivityRowDto {
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
  /** Verified (inside the fence) vs Denied (an auditable exception). */
  insideGeofence: boolean;
}

export interface GeoActivityFilters {
  fromMs?: number;
  toMs?: number;
  /** Governing site (Attendance_Logs.Branch_Name). */
  branch?: string;
  /** "accepted" = Verified, "rejected" = Denied. Omit for both. */
  verdict?: "accepted" | "rejected";
  employeeId?: number;
  page?: number;
  pageSize?: number;
}

export interface GeoActivityResult {
  rows: GeoActivityRowDto[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  accepted: number;
  rejected: number;
  /** Non-geofence punches in the same window, for a source comparison. */
  totalBiometric: number;
  totalGeofence: number;
  /** Distinct governing sites seen in the window (filter dropdown). */
  branches: string[];
  generatedAt: number;
}

interface GeoActivityJoinedRow {
  Log_ID: number;
  Employee_ID: number | null;
  Timestamp: number;
  Direction: PunchDirection;
  Verify_Result: VerifyResult;
  ERP_Sync_Status: ErpSyncStatus;
  Verify_Method: string;
  Branch_Name: string | null;
  Latitude: number | null;
  Longitude: number | null;
  Location_Accuracy_Meters: number | null;
  Geofence_Distance_Meters: number | null;
  Full_Name: string | null;
  ERP_User_ID: string | null;
}

/**
 * Every GPS-validated punch in a window, newest first, with the filters the
 * Phase 9 reporting surface needs: date range, branch, verdict and employee.
 * Read-only — this never writes and never touches the ERP sync state.
 */
export async function listGeofenceActivity(filters: GeoActivityFilters): Promise<GeoActivityResult> {
  const db = await getDb();
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.max(1, Math.min(200, Math.floor(filters.pageSize ?? 50)));

  const from = filters.fromMs ?? 0;
  const to = filters.toMs ?? Date.now() + 7_200_000;

  const params: (string | number)[] = [from, to];
  let where = "WHERE l.Timestamp >= ? AND l.Timestamp < ? AND l.Verify_Method = 'Geofence'";

  if (filters.employeeId != null) {
    where += " AND l.Employee_ID = ?";
    params.push(filters.employeeId);
  }
  if (filters.branch) {
    where += " AND l.Branch_Name = ?";
    params.push(filters.branch);
  }
  if (filters.verdict === "accepted") {
    where += " AND l.Verify_Result = 'Verified'";
  } else if (filters.verdict === "rejected") {
    where += " AND l.Verify_Result = 'Denied'";
  }

  const rows = await queryAll<GeoActivityJoinedRow>(
    db,
    `SELECT l.Log_ID, l.Employee_ID, l.Timestamp, l.Direction, l.Verify_Result, l.ERP_Sync_Status,
            l.Verify_Method, l.Branch_Name, l.Latitude, l.Longitude,
            l.Location_Accuracy_Meters, l.Geofence_Distance_Meters,
            e.Full_Name, e.ERP_User_ID
       FROM Attendance_Logs l
       LEFT JOIN Employees e ON e.Employee_ID = l.Employee_ID
       ${where}
      ORDER BY l.Timestamp DESC, l.Log_ID DESC`,
    ...params
  );

  const dto: GeoActivityRowDto[] = rows.map((r) => ({
    logId: r.Log_ID,
    employeeId: r.Employee_ID,
    employeeName: r.Full_Name ?? "Unregistered ID",
    erpUserId: r.ERP_User_ID,
    branch: r.Branch_Name,
    timestamp: r.Timestamp,
    direction: r.Direction,
    verifyResult: r.Verify_Result,
    syncStatus: r.ERP_Sync_Status,
    distanceMeters: r.Geofence_Distance_Meters,
    accuracyMeters: r.Location_Accuracy_Meters,
    latitude: r.Latitude,
    longitude: r.Longitude,
    insideGeofence: r.Verify_Result === "Verified",
  }));

  const accepted = dto.filter((r) => r.insideGeofence).length;
  const rejected = dto.length - accepted;

  const branches = [
    ...new Set(
      (await queryAll<{ b: string | null }>(
        db,
        `SELECT DISTINCT l.Branch_Name AS b
           FROM Attendance_Logs l
          WHERE l.Timestamp >= ? AND l.Timestamp < ?
            AND l.Verify_Method = 'Geofence' AND l.Branch_Name IS NOT NULL
          ORDER BY b ASC`,
        from,
        to
      ))
        .map((b) => b.b)
        .filter((b): b is string => typeof b === "string" && b.length > 0)
    ),
  ];

  const total = dto.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;

  const totalGeofence = total;
  const nonGeofence =
    (await queryOne<{ c: number }>(
      db,
      `SELECT COUNT(*) AS c
         FROM Attendance_Logs
        WHERE Timestamp >= ? AND Timestamp < ? AND Verify_Method <> 'Geofence'`,
      from,
      to
    ))?.c ?? 0;
  const totalBiometric = nonGeofence;

  return {
    rows: dto.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    pages,
    accepted,
    rejected,
    totalBiometric,
    totalGeofence,
    branches,
    generatedAt: Date.now(),
  };
}
