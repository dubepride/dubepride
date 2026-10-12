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
 *  one DatabaseSync handle (WAL mode, foreign keys off — the schema is
 *  maintained by this layer, not by triggers).
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  The database file lives at data/ta-bridge.db (override with TA_DB_PATH).
 *  Schema migrations are idempotent: every table/column/index is created
 *  with IF NOT EXISTS semantics, so the same code boots a fresh checkout
 *  and an existing data file alike.
 *  ─────────────────────────────────────────────────────────────────────
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EXCEPTION_LABELS, EXCEPTION_RULES, EXCEPTION_TYPES } from "@/lib/exception-meta";
import { dateKeyOf, formatPunchTime, startOfTodayMs } from "@/lib/format";
import {
  allPermissions,
  countEnabled,
  parsePermissions,
  PERMISSION_KEYS,
  serializePermissions,
} from "@/lib/rbac";
import { verifySessionToken } from "@/lib/session";
import type {
  AccessLevelDto,
  AccessLevelRow,
  AttendanceRecord,
  AttendanceSummary,
  BacklogEntry,
  BranchDto,
  BranchRow,
  DashboardMetrics,
  EmployeePunchRow,
  EmployeeRow,
  ErpBatchPayload,
  ErpLogRow,
  ErpSyncGetResponse,
  ExceptionRow,
  ExceptionsResponse,
  ExceptionType,
  FeedEntry,
  FeedRow,
  MyPortalPunch,
  PermissionKey,
  PermissionsMap,
  PunchDirection,
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

/** Values accepted by node:sqlite bound parameters. */
export type SQLInputValue = string | number | bigint | null | Uint8Array;

type GlobalWithDb = typeof globalThis & { __taBridgeDb?: DatabaseSync };

/** Run a statement for its side effects. */
function exec(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): void {
  db.prepare(sql).run(...params);
}

/** Run a SELECT and return every row. */
function queryAll<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Run a SELECT and return the first row (undefined when there is none). */
function queryOne<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** WHERE-clause placeholder list: [1,2] → "?,?". */
function placeholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

/** True when a column already exists on a table (idempotent migrations). */
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return queryAll<{ name: string }>(db, `PRAGMA table_info(${table})`).some(
    (c) => c.name === column
  );
}

/** Add a column when an older data file predates it. */
function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string
): void {
  if (!columnExists(db, table, column)) {
    exec(db, `ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * Open (and lazily initialise) the process-wide connection.
 * Safe to call from any route / background service at any time.
 */
export function getDb(): DatabaseSync {
  const g = globalThis as GlobalWithDb;
  if (g.__taBridgeDb) return g.__taBridgeDb;

  const file =
    process.env.TA_DB_PATH?.trim() || path.join(process.cwd(), "data", "ta-bridge.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  db.exec("PRAGMA journal_mode = WAL;");

  migrate(db);
  seedShifts(db);
  seedRoster(db);
  seedTerminals(db);
  seedBranches(db);
  seedAccessLevels(db);
  ensureBranchCoverage(db);
  backfillEmployeeMeta(db);
  seedSystemAccounts(db);
  seedAttendanceHistory(db);

  g.__taBridgeDb = db;
  return db;
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

function migrate(db: DatabaseSync): void {
  db.exec(`
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
      Device_Name   TEXT
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
      Created_At  INTEGER NOT NULL
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

    CREATE INDEX IF NOT EXISTS idx_logs_emp  ON Attendance_Logs (Employee_ID, Timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_sync ON Attendance_Logs (ERP_Sync_Status, Log_ID);
    CREATE INDEX IF NOT EXISTS idx_logs_ts   ON Attendance_Logs (Timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_tor_emp   ON Time_Off_Requests (Employee_ID);
  `);

  // Columns introduced by later phases — upgrade older data files in place.
  ensureColumn(db, "Terminals", "Branch_Name", "Branch_Name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "Terminals", "Device_Name", "Device_Name TEXT");
  ensureColumn(db, "Employees", "Position", "Position TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "Employees", "Shift_ID", "Shift_ID INTEGER");
  ensureColumn(db, "Employees", "Status", "Status TEXT NOT NULL DEFAULT 'Active'");
  ensureColumn(db, "Employees", "Branch_Name", "Branch_Name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "Employees", "Fingers_Enrolled", "Fingers_Enrolled TEXT NOT NULL DEFAULT ''");
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
 * The 15-person demo roster (ids 1‥15, ERP-1001‥ERP-1015).
 * Names/departments mirror the dashboard mock so deep links line up.
 */
const SEED_EMPLOYEES: SeedEmployee[] = [
  { erp: "ERP-1001", name: "Amara Okafor",       enrolled: 1, department: "Operations",       position: "Operations Lead",       shiftId: 2, branch: "Branch 1",  fingers: 5 },
  { erp: "ERP-1002", name: "Daniel Whitfield",   enrolled: 1, department: "Logistics",        position: "Logistics Coordinator", shiftId: 1, branch: "Branch 17", fingers: 4 },
  { erp: "ERP-1003", name: "Priya Raghunathan",  enrolled: 1, department: "Engineering",      position: "Software Engineer",     shiftId: 2, branch: "Branch 4",  fingers: 5 },
  { erp: "ERP-1004", name: "Marcus Delaney",     enrolled: 1, department: "Engineering",      position: "Software Engineer",     shiftId: 2, branch: "Branch 4",  fingers: 3 },
  { erp: "ERP-1005", name: "Sofia Castellanos",  enrolled: 1, department: "Finance",          position: "Finance Analyst",       shiftId: 2, branch: "Branch 4",  fingers: 4 },
  { erp: "ERP-1006", name: "Kwame Mensah",       enrolled: 1, department: "Warehouse",        position: "Warehouse Associate",   shiftId: 1, branch: "Branch 3",  fingers: 5 },
  { erp: "ERP-1007", name: "Elena Petrova",      enrolled: 1, department: "Human Resources",  position: "HR Officer",            shiftId: 2, branch: "Branch 4",  fingers: 3 },
  { erp: "ERP-1008", name: "Jackson Rowe",       enrolled: 1, department: "Security",         position: "Security Officer",      shiftId: 4, branch: "Branch 1",  fingers: 4 },
  { erp: "ERP-1009", name: "Fatima Al-Sayed",    enrolled: 1, department: "Procurement",      position: "Procurement Officer",   shiftId: 2, branch: "Branch 6",  fingers: 5 },
  { erp: "ERP-1010", name: "Thomas Achebe",      enrolled: 1, department: "Maintenance",      position: "Maintenance Technician",shiftId: 4, branch: "Branch 2",  fingers: 4 },
  { erp: "ERP-1011", name: "Grace Lindqvist",    enrolled: 1, department: "Engineering",      position: "QA Engineer",           shiftId: 2, branch: "Branch 4",  fingers: 3 },
  { erp: "ERP-1012", name: "Rafael Moreno",      enrolled: 1, department: "Logistics",        position: "Fleet Dispatcher",      shiftId: 1, branch: "Branch 17", fingers: 5 },
  { erp: "ERP-1013", name: "Hannah Kim",         enrolled: 1, department: "Finance",          position: "Accountant",            shiftId: 2, branch: "Branch 4",  fingers: 4 },
  { erp: "ERP-1014", name: "Oliver Baptiste",    enrolled: 0, department: "Operations",       position: "Field Officer",         shiftId: 2, branch: "Branch 5",  fingers: 0 },
  { erp: "ERP-1015", name: "Nadia Volkova",      enrolled: 0, department: "Warehouse",        position: "Stores Clerk",          shiftId: 1, branch: "Branch 3",  fingers: 0 },
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
}

/** One registered terminal per branch — the bridge's 17 sites. */
const BRANCH_TERMINALS: SeedTerminal[] = [
  { branch: "Branch 1",  mac: "A4:1F:72:0C:9B:31", ip: "192.168.10.21", location: "Main Gate — North Entrance",     status: "Online"  },
  { branch: "Branch 2",  mac: "A4:1F:72:0C:9B:32", ip: "192.168.10.22", location: "Factory Floor — Line A",         status: "Online"  },
  { branch: "Branch 3",  mac: "A4:1F:72:0C:9B:33", ip: "192.168.10.23", location: "Warehouse — Bay 3",              status: "Online"  },
  { branch: "Branch 4",  mac: "A4:1F:72:0C:9B:34", ip: "192.168.10.24", location: "HQ — 2nd Floor Studio",          status: "Offline" },
  { branch: "Branch 5",  mac: "A4:1F:72:0C:9B:35", ip: "192.168.10.25", location: "West Perimeter Fence",           status: "Online"  },
  { branch: "Branch 6",  mac: "A4:1F:72:BC:06:01", ip: "192.168.17.26", location: "East Warehouse — Bay 1",         status: "Online"  },
  { branch: "Branch 7",  mac: "A4:1F:72:BC:07:01", ip: "192.168.17.27", location: "South Depot — Yard Entrance",    status: "Online"  },
  { branch: "Branch 8",  mac: "A4:1F:72:BC:08:01", ip: "192.168.17.28", location: "Airport Road — Service Desk",    status: "Online"  },
  { branch: "Branch 9",  mac: "A4:1F:72:BC:09:01", ip: "192.168.17.29", location: "Industrial Ave — Workshop",      status: "Online"  },
  { branch: "Branch 10", mac: "A4:1F:72:BC:10:01", ip: "192.168.17.30", location: "Harbour Site — Gate 2",          status: "Offline" },
  { branch: "Branch 11", mac: "A4:1F:72:BC:11:01", ip: "192.168.17.31", location: "Hillview — Reception",           status: "Online"  },
  { branch: "Branch 12", mac: "A4:1F:72:BC:12:01", ip: "192.168.17.32", location: "Riverside — Gate House",         status: "Offline" },
  { branch: "Branch 13", mac: "A4:1F:72:BC:13:01", ip: "192.168.17.33", location: "Eastlands — Shop Floor",         status: "Online"  },
  { branch: "Branch 14", mac: "A4:1F:72:BC:14:01", ip: "192.168.17.34", location: "Greenfield — Annex",             status: "Offline" },
  { branch: "Branch 15", mac: "A4:1F:72:BC:15:01", ip: "192.168.17.35", location: "Kivu Road — Store",              status: "Online"  },
  { branch: "Branch 16", mac: "A4:1F:72:BC:16:01", ip: "192.168.17.36", location: "Airport Terminal — Staff Gate",  status: "Online"  },
  { branch: "Branch 17", mac: "A4:1F:72:BC:17:01", ip: "192.168.17.37", location: "Distribution Centre — Dock 4",   status: "Online"  },
];

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

function seedShifts(db: DatabaseSync): void {
  const count = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Shifts")?.c ?? 0;
  if (count > 0) return;
  for (const s of SEED_SHIFTS) {
    exec(
      db,
      `INSERT INTO Shifts (Shift_ID, Name, Start_Time, End_Time, Duration_Minutes, Days, Created_At)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      s.id,
      s.name,
      s.start,
      s.end,
      s.duration,
      s.days,
      SEED_CREATED_AT
    );
  }
}

function seedRoster(db: DatabaseSync): void {
  const count = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Employees")?.c ?? 0;
  if (count > 0) return;
  for (const e of SEED_EMPLOYEES) {
    exec(
      db,
      `INSERT INTO Employees
         (ERP_User_ID, Full_Name, Fingerprint_Enrolled, Fingers_Enrolled,
          Department, Position, Branch_Name, Shift_ID, Status, Created_At)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`,
      e.erp,
      e.name,
      e.enrolled,
      e.enrolled ? serializeFingers(seedFingers(e.fingers)) : "",
      e.department,
      e.position,
      e.branch,
      e.shiftId,
      SEED_CREATED_AT
    );
  }
}

function seedTerminals(db: DatabaseSync): void {
  const count = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Terminals")?.c ?? 0;
  if (count > 0) return;
  const now = Date.now();
  for (const t of BRANCH_TERMINALS) {
    exec(
      db,
      `INSERT INTO Terminals
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
 * Every branch must expose at least one terminal (Phase 10 grouping).
 * Re-seeds any branch whose devices were all removed.
 */
function ensureBranchCoverage(db: DatabaseSync): void {
  const covered = new Set(
    queryAll<{ Branch_Name: string }>(
      db,
      "SELECT DISTINCT Branch_Name FROM Terminals WHERE Branch_Name <> ''"
    ).map((r) => r.Branch_Name)
  );
  const now = Date.now();
  for (const t of BRANCH_TERMINALS) {
    if (covered.has(t.branch)) continue;
    exec(
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
function backfillEmployeeMeta(db: DatabaseSync): void {
  for (const e of SEED_EMPLOYEES) {
    exec(
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
  // Roster rows outside the demo seed: give them a sensible department default.
  const orphans = queryAll<{ Employee_ID: number; Position: string }>(
    db,
    "SELECT Employee_ID, Position FROM Employees WHERE Shift_ID IS NULL OR Position = ''"
  );
  for (const o of orphans) {
    exec(db, "UPDATE Employees SET Position = ?, Shift_ID = 2 WHERE Employee_ID = ?", o.Position || "Team Member", o.Employee_ID);
  }

  // Branch + captured fingers for the demo roster (idempotent: only fills
  // blanks, so an admin's edits on the enrolment page survive restarts —
  // clearing all fingers drops Fingerprint_Enrolled to 0, which also stops
  // this backfill from resurrecting them).
  for (const e of SEED_EMPLOYEES) {
    if (e.branch) {
      exec(
        db,
        "UPDATE Employees SET Branch_Name = ? WHERE ERP_User_ID = ? AND (Branch_Name IS NULL OR Branch_Name = '')",
        e.branch,
        e.erp
      );
    }
    if (e.enrolled && e.fingers > 0) {
      exec(
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

/**
 * Deterministic 6-day punch history for a brand-new install so timesheets,
 * attendance records and reports are populated on the very first render.
 * Never runs against an existing data file (the simulator keeps it alive).
 */
function seedAttendanceHistory(db: DatabaseSync): void {
  const count = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Attendance_Logs")?.c ?? 0;
  if (count > 0) return;

  // Small LCG — identical sequence for every fresh install.
  let state = 0x2f6e2b1;
  const rnd = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const randInt = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

  const employees = queryAll<{ Employee_ID: number; ERP_User_ID: string; Fingerprint_Enrolled: number }>(
    db,
    "SELECT Employee_ID, ERP_User_ID, Fingerprint_Enrolled FROM Employees ORDER BY Employee_ID"
  );
  const terminals = queryAll<{ Terminal_ID: number; Terminal_MAC: string; IP_Address: string }>(
    db,
    "SELECT Terminal_ID, Terminal_MAC, IP_Address FROM Terminals ORDER BY Terminal_ID"
  );
  if (employees.length === 0 || terminals.length === 0) return;

  const HOUR = 3_600_000;
  const MINUTE = 60_000;
  const insert = (
    employeeId: number,
    ts: number,
    terminalId: number,
    direction: PunchDirection,
    method: string,
    sync: "Pending" | "Success",
    ip: string,
    mac: string
  ) => {
    exec(
      db,
      `INSERT INTO Attendance_Logs
         (Employee_ID, Timestamp, Terminal_ID, ERP_Sync_Status, Verify_Result, Direction, Verify_Method, Raw_Payload, Created_At)
       VALUES (?, ?, ?, ?, 'Verified', ?, ?, ?, ?)`,
      employeeId,
      ts,
      terminalId,
      sync,
      direction,
      method,
      `ID=${employeeId}&Time=${formatPunchTime(ts)}&Status=0&Verify=1&IP=${ip}&MAC=${mac}`,
      ts
    );
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
}

/* ------------------------------------------------------------------ */
/* Phase 13/14 — relational settings & access control                  */
/* ------------------------------------------------------------------ */

/** The 17 fixed branch sites — seeds the global Branches list. */
const SEED_BRANCH_NAMES = Array.from({ length: 17 }, (_, i) => `Branch ${i + 1}`);

/** Deterministic password digest for demo accounts (sha256, static salt). */
export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(`${password}::biobridge-salt`).digest("hex");
}

/** Constant behaviour comparison for the digest above. */
export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

function seedBranches(db: DatabaseSync): void {
  const count = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Branches")?.c ?? 0;
  if (count > 0) return;
  for (const name of SEED_BRANCH_NAMES) {
    exec(db, "INSERT INTO Branches (Branch_Name, Created_At) VALUES (?, ?)", name, SEED_CREATED_AT);
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
];

function seedAccessLevels(db: DatabaseSync): void {
  const count = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Access_Levels")?.c ?? 0;
  if (count > 0) return;
  for (const lvl of SEED_ACCESS_LEVELS) {
    exec(
      db,
      "INSERT INTO Access_Levels (Level_Name, Permissions_JSON, Created_At) VALUES (?, ?, ?)",
      lvl.name,
      serializePermissions(lvl.perms),
      SEED_CREATED_AT
    );
  }
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
 * The demo directory. `admin@biobridge.example / biobridge-admin` keeps the
 * app's long-standing default login working (empty email → this account),
 * while the worker account demonstrates the "My Portal only" view.
 */
const SEED_ACCOUNTS: SeedAccount[] = [
  {
    first: "Bridge",
    surname: "Admin",
    email: "admin@biobridge.example",
    password: "biobridge-admin",
    level: "IT Administrator",
    branch: "Branch 1",
    employeeErp: "ERP-1001", // Amara — the admin's My Portal demo profile
  },
  {
    first: "Grace",
    surname: "Mwangi",
    email: "hr@biobridge.example",
    password: "hr-manager-2026",
    level: "HR Manager",
    branch: "Branch 4",
    employeeErp: null,
  },
  {
    first: "Daniel",
    surname: "Otieno",
    email: "sales@biobridge.example",
    password: "sales-manager-2026",
    level: "Sales Manager",
    branch: "Branch 4",
    employeeErp: null,
  },
  {
    first: "Jayden",
    surname: "Osei",
    email: "worker@biobridge.example",
    password: "worker-pass-2026",
    level: "Worker",
    branch: "Branch 3",
    employeeErp: "ERP-1014", // Oliver — the worker portal demo profile
  },
];

function seedSystemAccounts(db: DatabaseSync): void {
  const count = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM System_Accounts")?.c ?? 0;
  if (count > 0) return;

  const levelId = (name: string): number | null =>
    queryOne<{ id: number }>(db, "SELECT Access_Level_ID AS id FROM Access_Levels WHERE Level_Name = ?", name)?.id ?? null;
  const branchId = (name: string): number | null =>
    queryOne<{ id: number }>(db, "SELECT Branch_ID AS id FROM Branches WHERE Branch_Name = ?", name)?.id ?? null;
  const employeeId = (erp: string | null): number | null =>
    erp ? (queryOne<{ id: number }>(db, "SELECT Employee_ID AS id FROM Employees WHERE ERP_User_ID = ?", erp)?.id ?? null) : null;

  for (const a of SEED_ACCOUNTS) {
    exec(
      db,
      `INSERT INTO System_Accounts
         (First_Name, Surname, Company_Email, Password_Hash, Access_Level_ID, Branch_ID, Employee_ID, Created_At)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      a.first,
      a.surname,
      a.email,
      hashPassword(a.password),
      levelId(a.level),
      branchId(a.branch),
      employeeId(a.employeeErp),
      SEED_CREATED_AT
    );
  }
}

/* ------------------------------------------------------------------ */
/* Branches (Phase 13 — Settings tab 1)                                */
/* ------------------------------------------------------------------ */

/** Branch list with live headcounts (employees + terminals) per site. */
export function listBranches(): BranchDto[] {
  const db = getDb();
  const rows = queryAll<BranchRow>(db, "SELECT * FROM Branches ORDER BY Branch_ID");
  const employees = queryAll<{ Branch_Name: string; c: number }>(
    db,
    "SELECT Branch_Name, COUNT(*) AS c FROM Employees WHERE Branch_Name <> '' GROUP BY Branch_Name"
  );
  const terminals = queryAll<{ Branch_Name: string; c: number }>(
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
  }));
}

/** The flat site names ("Branch 1" …) — branch dropdowns merge this with "Unassigned". */
export function listBranchNames(): string[] {
  return queryAll<BranchRow>(getDb(), "SELECT * FROM Branches ORDER BY Branch_ID").map((r) => r.Branch_Name);
}

export function createBranch(name: string): number {
  const db = getDb();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Branch name is required.");
  exec(db, "INSERT INTO Branches (Branch_Name, Created_At) VALUES (?, ?)", trimmed, Date.now());
  return Number(queryOne<{ id: number }>(db, "SELECT last_insert_rowid() AS id")?.id ?? 0);
}

/** Rename a site and keep the denormalised Employees/Terminals in sync. */
export function renameBranch(branchId: number, name: string): void {
  const db = getDb();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Branch name is required.");
  const current = queryOne<BranchRow>(db, "SELECT * FROM Branches WHERE Branch_ID = ?", branchId);
  if (!current) throw new Error("That branch no longer exists.");
  exec(db, "UPDATE Employees SET Branch_Name = ? WHERE Branch_Name = ?", trimmed, current.Branch_Name);
  exec(db, "UPDATE Terminals SET Branch_Name = ? WHERE Branch_Name = ?", trimmed, current.Branch_Name);
  exec(db, "UPDATE Branches SET Branch_Name = ? WHERE Branch_ID = ?", trimmed, branchId);
}

/** Remove a site; records that referenced it fall back to "Unassigned" (""). */
export function deleteBranch(branchId: number): boolean {
  const db = getDb();
  const current = queryOne<BranchRow>(db, "SELECT * FROM Branches WHERE Branch_ID = ?", branchId);
  if (!current) return false;
  exec(db, "UPDATE Employees SET Branch_Name = '' WHERE Branch_Name = ?", current.Branch_Name);
  exec(db, "UPDATE Terminals SET Branch_Name = '' WHERE Branch_Name = ?", current.Branch_Name);
  exec(db, "DELETE FROM Branches WHERE Branch_ID = ?", branchId);
  return true;
}

/* ------------------------------------------------------------------ */
/* Access Levels (Phase 13 — Settings tab 2 / the Matrix)              */
/* ------------------------------------------------------------------ */

/** Every level with its parsed matrix + how many accounts hold it. */
export function listAccessLevels(): AccessLevelDto[] {
  const db = getDb();
  const rows = queryAll<AccessLevelRow>(db, "SELECT * FROM Access_Levels ORDER BY Access_Level_ID");
  const counts = queryAll<{ Access_Level_ID: number; c: number }>(
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
export function accessLevelById(levelId: number): AccessLevelDto | null {
  const db = getDb();
  const row = queryOne<AccessLevelRow>(db, "SELECT * FROM Access_Levels WHERE Access_Level_ID = ?", levelId);
  if (!row) return null;
  const permissions = parsePermissions(row.Permissions_JSON);
  const accountCount =
    queryOne<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM System_Accounts WHERE Access_Level_ID = ?",
      levelId
    )?.c ?? 0;
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
export function createAccessLevel(name: string, permissions?: PermissionsMap): number {
  const db = getDb();
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Access level name is required.");
  const perms = parsePermissions(permissions);
  exec(
    db,
    "INSERT INTO Access_Levels (Level_Name, Permissions_JSON, Created_At) VALUES (?, ?, ?)",
    trimmed,
    serializePermissions(perms),
    Date.now()
  );
  return Number(queryOne<{ id: number }>(db, "SELECT last_insert_rowid() AS id")?.id ?? 0);
}

export interface AccessLevelPatch {
  name?: string;
  permissions?: PermissionsMap;
}

export function updateAccessLevel(levelId: number, patch: AccessLevelPatch): void {
  const db = getDb();
  const current = queryOne<AccessLevelRow>(db, "SELECT * FROM Access_Levels WHERE Access_Level_ID = ?", levelId);
  if (!current) throw new Error("That access level no longer exists.");
  const name = patch.name !== undefined ? patch.name.trim() : current.Level_Name;
  if (!name) throw new Error("Access level name is required.");
  const json =
    patch.permissions !== undefined
      ? serializePermissions(parsePermissions(patch.permissions))
      : current.Permissions_JSON;
  exec(db, "UPDATE Access_Levels SET Level_Name = ?, Permissions_JSON = ? WHERE Access_Level_ID = ?", name, json, levelId);
}

/** Levels still attached to accounts cannot be removed (avoid orphans). */
export function deleteAccessLevel(levelId: number): { ok: boolean; reason?: string } {
  const db = getDb();
  const current = queryOne<AccessLevelRow>(db, "SELECT * FROM Access_Levels WHERE Access_Level_ID = ?", levelId);
  if (!current) return { ok: false, reason: "That access level no longer exists." };
  const used = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM System_Accounts WHERE Access_Level_ID = ?", levelId)?.c ?? 0;
  if (used > 0) {
    return {
      ok: false,
      reason: `${used} system account${used === 1 ? "" : "s"} still use this level — reassign them first.`,
    };
  }
  exec(db, "DELETE FROM Access_Levels WHERE Access_Level_ID = ?", levelId);
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

export function listSystemAccounts(): SystemAccountDto[] {
  const db = getDb();
  const rows = queryAll<SystemAccountJoinedRow>(
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

export function createSystemAccount(input: SystemAccountInput): number {
  const db = getDb();
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
  const refError = checkAccountReferences(db, input.accessLevelId, input.branchId, input.employeeId);
  if (refError) {
    throw new Error(refError);
  }
  exec(
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
  return Number(queryOne<{ id: number }>(db, "SELECT last_insert_rowid() AS id")?.id ?? 0);
}

/** Remove an account (guarded: the built-in bridge administrator stays). */
export function deleteSystemAccount(accountId: number): { ok: boolean; reason?: string } {
  const db = getDb();
  const row = queryOne<SystemAccountRow>(db, "SELECT * FROM System_Accounts WHERE Account_ID = ?", accountId);
  if (!row) return { ok: false, reason: "That account no longer exists." };
  if (row.Company_Email.toLowerCase() === "admin@biobridge.example") {
    return { ok: false, reason: "The built-in bridge administrator cannot be removed." };
  }
  exec(db, "DELETE FROM Time_Off_Requests WHERE Account_ID = ?", accountId);
  exec(db, "DELETE FROM System_Accounts WHERE Account_ID = ?", accountId);
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
function checkAccountReferences(
  db: DatabaseSync,
  accessLevelId: number | null,
  branchId: number | null,
  employeeId: number | null
): string | null {
  if (
    accessLevelId != null &&
    !queryOne<{ ok: number }>(db, "SELECT 1 AS ok FROM Access_Levels WHERE Access_Level_ID = ?", accessLevelId)
  ) {
    return "That access level no longer exists.";
  }
  if (
    branchId != null &&
    !queryOne<{ ok: number }>(db, "SELECT 1 AS ok FROM Branches WHERE Branch_ID = ?", branchId)
  ) {
    return "That branch no longer exists.";
  }
  if (
    employeeId != null &&
    !queryOne<{ ok: number }>(db, "SELECT 1 AS ok FROM Employees WHERE Employee_ID = ?", employeeId)
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
export function updateSystemAccount(
  accountId: number,
  patch: SystemAccountPatch
): { ok: boolean; reason?: string } {
  const db = getDb();
  const row = systemAccountById(accountId);
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

  const clash = queryOne<{ Account_ID: number }>(
    db,
    "SELECT Account_ID FROM System_Accounts WHERE Company_Email = ? COLLATE NOCASE AND Account_ID <> ?",
    email,
    accountId
  );
  if (clash) return { ok: false, reason: "An account with that company email already exists." };

  const accessLevelId = patch.accessLevelId !== undefined ? patch.accessLevelId : row.Access_Level_ID;
  const branchId = patch.branchId !== undefined ? patch.branchId : row.Branch_ID;
  const employeeId = patch.employeeId !== undefined ? patch.employeeId : row.Employee_ID;

  const refError = checkAccountReferences(db, accessLevelId, branchId, employeeId);
  if (refError) return { ok: false, reason: refError };

  const password = patch.password ?? "";
  if (password.length > 0 && password.length < 6) {
    return { ok: false, reason: "Password must be at least 6 characters." };
  }

  if (password.length > 0) {
    exec(
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
    exec(
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

export function systemAccountById(accountId: number): SystemAccountRow | null {
  return queryOne<SystemAccountRow>(getDb(), "SELECT * FROM System_Accounts WHERE Account_ID = ?", accountId) ?? null;
}

/** Case-insensitive email lookup for the login handler. */
export function findAccountByEmail(email: string): SystemAccountRow | null {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return (
    queryOne<SystemAccountRow>(
      getDb(),
      "SELECT * FROM System_Accounts WHERE Company_Email COLLATE NOCASE = ?",
      normalized
    ) ?? null
  );
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

export function resolveAccount(account: SystemAccountRow): ResolvedAccount {
  const db = getDb();
  const level =
    account.Access_Level_ID != null
      ? queryOne<AccessLevelRow>(db, "SELECT * FROM Access_Levels WHERE Access_Level_ID = ?", account.Access_Level_ID)
      : undefined;
  const branch =
    account.Branch_ID != null
      ? queryOne<BranchRow>(db, "SELECT * FROM Branches WHERE Branch_ID = ?", account.Branch_ID)
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
    home: permissions.can_view_dashboard ? "/" : "/my-portal",
  };
}

/**
 * Resolve a session cookie to a full account — used by proxy.ts for page
 * permission gating and by every API handler for authorization. Returns
 * null when the token is missing/forged/expired OR the account was deleted.
 */
export function accountByToken(token: string | null | undefined): ResolvedAccount | null {
  const claims = verifySessionToken(token);
  if (!claims) return null;
  const id = Number(claims.sub);
  if (!Number.isInteger(id) || id <= 0) return null;
  const account = systemAccountById(id);
  if (!account) return null;
  return resolveAccount(account);
}

/* ------------------------------------------------------------------ */
/* Time-off requests (Phase 14 — My Portal widget)                     */
/* ------------------------------------------------------------------ */

export function listTimeOffRequests(employeeId: number | null): TimeOffRequestRow[] {
  if (employeeId === null) return [];
  return queryAll<TimeOffRequestRow>(
    getDb(),
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

export function createTimeOffRequest(input: TimeOffInput): TimeOffRequestRow {
  const db = getDb();
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
  exec(
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
  const id = Number(queryOne<{ id: number }>(db, "SELECT last_insert_rowid() AS id")?.id ?? 0);
  const row = queryOne<TimeOffRequestRow>(db, "SELECT * FROM Time_Off_Requests WHERE Request_ID = ?", id);
  if (!row) throw new Error("Could not store the request.");
  return row;
}

/* ------------------------------------------------------------------ */
/* My Portal data (Phase 14 — worker clocking hub)                     */
/* ------------------------------------------------------------------ */

/** Latest punch today for an employee → the "clocked in?" badge. */
export function employeeDayStatus(employeeId: number): {
  clockedIn: boolean;
  lastPunchAt: number | null;
  lastDirection: PunchDirection | null;
} {
  const row = queryOne<{ ts: number; dir: PunchDirection }>(
    getDb(),
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
export function getEmployeeRecentPunches(employeeId: number, limit: number): MyPortalPunch[] {
  return queryAll<MyPortalPunch>(
    getDb(),
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
export function allEmployees(): EmployeeRow[] {
  return queryAll<EmployeeRow>(
    getDb(),
    "SELECT * FROM Employees ORDER BY Employee_ID"
  );
}

/**
 * Resolve a device/ERP/route reference to an employee.
 * Accepts ERP_User_ID ("ERP-1001"), the bare numeric id ("1", "1001" →
 * "ERP-1001") or a route param in either form. Returns null when unknown.
 */
export function resolveEmployee(db: DatabaseSync, ref: string): EmployeeRow | null {
  const value = ref.trim();
  if (!value) return null;

  const direct = queryOne<EmployeeRow>(
    db,
    "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
    value
  );
  if (direct) return direct;

  if (/^\d+$/.test(value)) {
    const byId = queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE Employee_ID = ?",
      Number(value)
    );
    if (byId) return byId;

    const prefixed = queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
      `ERP-${value}`
    );
    if (prefixed) return prefixed;
  }

  const unprefixed = value.replace(/^ERP-/i, "");
  return (
    queryOne<EmployeeRow>(
      db,
      "SELECT * FROM Employees WHERE ERP_User_ID COLLATE NOCASE = ?",
      `ERP-${unprefixed}`
    ) ?? null
  );
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
export function listEmployees(q: string): EmployeeDirectoryRow[] {
  const like = `%${q.trim()}%`;
  return queryAll<EmployeeDirectoryRow>(
    getDb(),
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
export function searchEmployees(q: string, limit: number): EmployeeSearchRow[] {
  const like = `%${q.trim()}%`;
  const since = Date.now() - 30 * 86_400_000;
  return queryAll<EmployeeSearchRow>(
    getDb(),
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

export function listWhoIsIn(): WhoIsInRow[] {
  return queryAll<WhoIsInRow>(
    getDb(),
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
/* Employee CRUD (Phase 11 — /employees management)                    */
/* ------------------------------------------------------------------ */

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

export function createEmployee(input: EmployeeInput): number {
  const db = getDb();
  // "Enrolled on a terminal" without an explicit finger set ⇒ all five
  // templates already live on the device.
  const fingers =
    input.fingers ?? (input.enrolled ? [0, 1, 2, 3, 4] : []);
  exec(
    db,
    `INSERT INTO Employees
       (ERP_User_ID, Full_Name, Fingerprint_Enrolled, Fingers_Enrolled,
        Department, Position, Branch_Name, Shift_ID, Status, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.erpUserId.trim(),
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
  const id = queryOne<{ id: number }>(db, "SELECT last_insert_rowid() AS id");
  return Number(id?.id ?? 0);
}

export function updateEmployee(employeeId: number, patch: Partial<EmployeeInput>): void {
  const db = getDb();
  const current = queryOne<EmployeeRow>(db, "SELECT * FROM Employees WHERE Employee_ID = ?", employeeId);
  if (!current) return;

  const updates: string[] = [];
  const params: SQLInputValue[] = [];
  const push = (column: string, value: SQLInputValue) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.erpUserId !== undefined) push("ERP_User_ID", patch.erpUserId.trim() || current.ERP_User_ID);
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
  exec(db, `UPDATE Employees SET ${updates.join(", ")} WHERE Employee_ID = ?`, ...params);
}

/** Remove an employee and their punches (keeps the feed free of orphans). */
export function deleteEmployee(employeeId: number): void {
  const db = getDb();
  exec(db, "DELETE FROM Attendance_Logs WHERE Employee_ID = ?", employeeId);
  exec(db, "DELETE FROM Employees WHERE Employee_ID = ?", employeeId);
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

export function listShifts(): ShiftRow[] {
  return queryAll<ShiftRow>(
    getDb(),
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

export function createShift(input: ShiftInput): number {
  const db = getDb();
  exec(
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
  const id = queryOne<{ id: number }>(db, "SELECT last_insert_rowid() AS id");
  return Number(id?.id ?? 0);
}

export function updateShift(shiftId: number, patch: Partial<ShiftInput>): void {
  const db = getDb();
  const current = queryOne<ShiftRow>(db, "SELECT * FROM Shifts WHERE Shift_ID = ?", shiftId);
  if (!current) return;

  const name = patch.name !== undefined ? patch.name.trim() || current.Name : current.Name;
  const start = patch.startTime !== undefined ? patch.startTime : current.Start_Time;
  const end = patch.endTime !== undefined ? patch.endTime : current.End_Time;
  const days = patch.days !== undefined ? patch.days : current.Days;

  exec(
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
export function deleteShift(shiftId: number): void {
  const db = getDb();
  exec(db, "UPDATE Employees SET Shift_ID = NULL WHERE Shift_ID = ?", shiftId);
  exec(db, "DELETE FROM Shifts WHERE Shift_ID = ?", shiftId);
}

/* ------------------------------------------------------------------ */
/* Terminals                                                           */
/* ------------------------------------------------------------------ */

/** Every terminal row (used by the simulator + heartbeat). */
export function allTerminalRows(): TerminalRow[] {
  return queryAll<TerminalRow>(getDb(), "SELECT * FROM Terminals ORDER BY Terminal_ID");
}

/**
 * Device registry for /api/terminals — joined with today's capture count
 * so the Clocking Devices page can show live activity per device.
 */
export function listTerminals(): TerminalJoinedRow[] {
  return queryAll<TerminalJoinedRow>(
    getDb(),
    `SELECT t.*,
            (SELECT COUNT(*) FROM Attendance_Logs l
              WHERE l.Terminal_ID = t.Terminal_ID AND l.Timestamp >= ?) AS Scans_Today
       FROM Terminals t
      ORDER BY t.Terminal_ID`,
    startOfTodayMs()
  );
}

/** A random ONLINE terminal — where the next simulated punch comes from. */
export function randomTerminal(): TerminalRow | null {
  const rows = queryAll<TerminalRow>(
    getDb(),
    "SELECT * FROM Terminals WHERE Status = 'Online'"
  );
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

/**
 * Identify the sending device: serial (SN ≙ MAC) first, then source IP.
 * MAC comparison is case-insensitive — firmware often lowercases it.
 */
export function findTerminal(
  db: DatabaseSync,
  hint: { mac?: string | null; ip?: string | null }
): TerminalRow | null {
  const mac = hint.mac?.trim();
  if (mac) {
    const byMac = queryOne<TerminalRow>(
      db,
      "SELECT * FROM Terminals WHERE Terminal_MAC COLLATE NOCASE = ?",
      mac
    );
    if (byMac) return byMac;
  }
  const ip = hint.ip?.trim();
  if (ip) {
    const byIp = queryOne<TerminalRow>(db, "SELECT * FROM Terminals WHERE IP_Address = ?", ip);
    if (byIp) return byIp;
  }
  return null;
}

/** Keep-alive stamp: mark the device Online and refresh its heartbeat. */
export function touchTerminal(db: DatabaseSync, terminalId: number): void {
  exec(
    db,
    "UPDATE Terminals SET Status = 'Online', Last_Ping = ? WHERE Terminal_ID = ?",
    Date.now(),
    terminalId
  );
}

/** Simulator flap / manual status change. */
export function setTerminalStatus(terminalId: number, status: TerminalStatus): void {
  const db = getDb();
  if (status === "Online") {
    exec(
      db,
      "UPDATE Terminals SET Status = ?, Last_Ping = ? WHERE Terminal_ID = ?",
      status,
      Date.now(),
      terminalId
    );
  } else {
    exec(db, "UPDATE Terminals SET Status = ? WHERE Terminal_ID = ?", status, terminalId);
  }
}

/** Heartbeat: refresh Last_Ping on every device currently reporting Online. */
export function pingOnlineTerminals(): void {
  exec(getDb(), "UPDATE Terminals SET Last_Ping = ? WHERE Status = 'Online'", Date.now());
}

/* ------------------------------------------------------------------ */
/* Terminal CRUD (Phase 10 — /api/terminals)                           */
/* ------------------------------------------------------------------ */

export function createTerminal({
  mac,
  ip,
  location,
  branch,
  deviceName,
  status = "Offline",
}: {
  mac: string;
  ip?: string | null;
  location?: string | null;
  branch: string;
  deviceName?: string | null;
  status?: "Online" | "Offline";
}) {
  const db = getDb();
  const loc = (location && location.trim()) || deviceName?.trim() || `Device ${mac.slice(-6)}`;
  const devName = (deviceName && deviceName.trim()) || loc;
  exec(
    db,
    `INSERT INTO Terminals
       (Terminal_MAC, IP_Address, Location_Name, Branch_Name, Status, Last_Ping)
     VALUES (?, ?, ?, ?, ?, ?)`,
    mac.trim(),
    ip?.trim() || "",
    devName,
    branch.trim(),
    status,
    status === "Online" ? Date.now() : null
  );
  const id = queryOne<{ id: number }>(db, "SELECT last_insert_rowid() AS id");
  return Number(id?.id ?? 0);
}

export function updateTerminal(
  terminalId: number,
  patch: {
    mac?: string;
    ip?: string | null;
    location?: string | null;
    branch?: string;
    deviceName?: string | null;
    status?: "Online" | "Offline";
  }
) {
  const db = getDb();
  const current = queryOne<TerminalRow>(db, "SELECT * FROM Terminals WHERE Terminal_ID = ?", terminalId);
  if (!current) return;
  const updates: string[] = [];
  const params: SQLInputValue[] = [];
  if (patch.mac !== undefined) {
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
  if (updates.length === 0) return;
  params.push(terminalId);
  exec(db, `UPDATE Terminals SET ${updates.join(", ")} WHERE Terminal_ID = ?`, ...params);
}

export function deleteTerminal(terminalId: number) {
  exec(getDb(), "DELETE FROM Terminals WHERE Terminal_ID = ?", terminalId);
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
}

/**
 * Alternate IN → OUT → IN … across the employee's day, starting on IN.
 * Unregistered ids (Employee_ID IS NULL) always land as IN.
 */
export function inferDirection(employeeId: number | null, timestamp: number): PunchDirection {
  if (employeeId === null) return "IN";
  const last = queryOne<{ Direction: PunchDirection }>(
    getDb(),
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
 */
export function insertPunch(input: PunchInput): void {
  const db = getDb();
  const employee = input.employeeRef ? resolveEmployee(db, input.employeeRef) : null;
  const employeeId = employee?.Employee_ID ?? null;
  const direction = input.direction ?? inferDirection(employeeId, input.timestamp);

  exec(
    db,
    `INSERT INTO Attendance_Logs
       (Employee_ID, Timestamp, Terminal_ID, ERP_Sync_Status, Verify_Result, Direction, Verify_Method, Raw_Payload, Created_At)
     VALUES (?, ?, ?, 'Pending', ?, ?, ?, ?, ?)`,
    employeeId,
    input.timestamp,
    input.terminalId,
    input.verifyResult,
    direction,
    input.verifyMethod,
    input.rawPayload ?? null,
    Date.now()
  );
}

/** Latest punch today per employee (simulator's anti-repeat guard). */
export function todayPunchesByEmployee(): Map<number, { ts: number; terminalId: number | null }> {
  const rows = queryAll<{ Employee_ID: number; ts: number; terminalId: number | null }>(
    getDb(),
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
export function getEmployeeFirstLog(employeeId: number): number | null {
  const row = queryOne<{ ts: number | null }>(
    getDb(),
    "SELECT MIN(Timestamp) AS ts FROM Attendance_Logs WHERE Employee_ID = ?",
    employeeId
  );
  return row?.ts ?? null;
}

/** One employee's punches inside a window (timesheet builder input). */
export function getEmployeeLogs(
  employeeId: number,
  fromMs: number,
  toMs: number
): EmployeePunchRow[] {
  return queryAll<EmployeePunchRow>(
    getDb(),
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

export function getDashboard(): { metrics: DashboardMetrics; summary: AttendanceSummary; feed: FeedEntry[] } {
  const db = getDb();
  const dayStart = startOfTodayMs();

  const terminalsTotal = queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Terminals")?.c ?? 0;
  const terminalsOnline =
    queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Terminals WHERE Status = 'Online'")?.c ?? 0;
  const scansToday =
    queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE Timestamp >= ?", dayStart)?.c ?? 0;
  const clockedInToday =
    queryOne<{ c: number }>(
      db,
      `SELECT COUNT(DISTINCT Employee_ID) AS c FROM Attendance_Logs
        WHERE Timestamp >= ? AND Employee_ID IS NOT NULL AND Verify_Result = 'Verified'`,
      dayStart
    )?.c ?? 0;
  const pendingSync =
    queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE ERP_Sync_Status = 'Pending'")?.c ?? 0;
  const syncedToday =
    queryOne<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE ERP_Sync_Status = 'Success' AND Created_At >= ?",
      dayStart
    )?.c ?? 0;

  const metrics: DashboardMetrics = {
    clockedInToday,
    scansToday,
    terminalsOnline,
    terminalsTotal,
    pendingSync,
    syncedToday,
  };

  const feedRows = queryAll<FeedRow>(
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

  return { metrics, summary: getAttendanceSummary(), feed };
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
export function getAttendanceSummary(): AttendanceSummary {
  const dayStart = startOfTodayMs();
  const rows = queryAll<{
    Employee_ID: number;
    Shift_ID: number | null;
    firstPunch: number | null;
  }>(
    getDb(),
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
export function getExceptions(type: ExceptionType | null): ExceptionsResponse {
  const db = getDb();
  const dayStart = startOfTodayMs();
  const now = Date.now();
  const at08 = dayStart + 8 * HOUR_MS;
  const at17 = dayStart + 17 * HOUR_MS;
  const at18 = dayStart + 18 * HOUR_MS;

  const punches = queryAll<TodayPunch>(
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
    const roster = queryAll<{
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
export function listAttendanceRecords(
  opts: AttendanceRecordsQuery
): { rows: AttendanceRecord[]; total: number; page: number; pageSize: number; pages: number } {
  const db = getDb();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? 25));

  const rows = queryAll<JoinedPunch>(
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

  const shiftNames = new Map(listShifts().map((s) => [s.Shift_ID, s.Name]));

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
export function getPendingLogs(limit: number): ErpLogRow[] {
  return queryAll<ErpLogRow>(
    getDb(),
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
export function buildErpPayload(logIds: number[], batchRef: string): ErpBatchPayload {
  if (logIds.length === 0) {
    return {
      batch_ref: batchRef,
      source: "TA-BRIDGE",
      pushed_at: new Date().toISOString(),
      record_count: 0,
      records: [],
    };
  }

  const rows = queryAll<ErpLogRow>(
    getDb(),
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
export function markLogsSynced(logIds: number[]): void {
  if (logIds.length === 0) return;
  exec(
    getDb(),
    `UPDATE Attendance_Logs SET ERP_Sync_Status = 'Success' WHERE Log_ID IN (${placeholders(logIds.length)})`,
    ...logIds
  );
}

/** Quarantine a batch — ERP rejected the records (4xx). */
export function markLogsFailed(logIds: number[]): void {
  if (logIds.length === 0) return;
  exec(
    getDb(),
    `UPDATE Attendance_Logs SET ERP_Sync_Status = 'Failed' WHERE Log_ID IN (${placeholders(logIds.length)})`,
    ...logIds
  );
}

export function countSyncBatches(): number {
  return queryOne<{ c: number }>(getDb(), "SELECT COUNT(*) AS c FROM Erp_Sync_Batches")?.c ?? 0;
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
export function insertSyncBatch(input: SyncBatchInput): SyncBatchRow {
  const db = getDb();
  exec(
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
  const row = queryOne<SyncBatchRow>(
    db,
    "SELECT * FROM Erp_Sync_Batches WHERE Batch_ID = (SELECT last_insert_rowid())"
  );
  if (!row) throw new Error("Failed to record the ERP sync batch");
  return row;
}

/** Snapshot behind /sync + the dashboard's sync panels. */
export function getSyncOverview(): Pick<ErpSyncGetResponse, "stats" | "batches" | "backlog"> {
  const db = getDb();
  const dayStart = startOfTodayMs();

  const stats: SyncStats = {
    pendingLogs:
      queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE ERP_Sync_Status = 'Pending'")?.c ?? 0,
    syncedToday:
      queryOne<{ c: number }>(
        db,
        "SELECT COUNT(*) AS c FROM Attendance_Logs WHERE ERP_Sync_Status = 'Success' AND Created_At >= ?",
        dayStart
      )?.c ?? 0,
    successBatches:
      queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Erp_Sync_Batches WHERE Status = 'Success'")?.c ?? 0,
    failedBatches:
      queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Erp_Sync_Batches WHERE Status = 'Failed'")?.c ?? 0,
    lastBatchAt:
      queryOne<{ v: number | null }>(db, "SELECT MAX(Created_At) AS v FROM Erp_Sync_Batches")?.v ?? null,
    lastSuccessAt:
      queryOne<{ v: number | null }>(
        db,
        "SELECT MAX(Created_At) AS v FROM Erp_Sync_Batches WHERE Status = 'Success'"
      )?.v ?? null,
  };

  const batchRows = queryAll<SyncBatchRow>(
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

  const backlogRows = queryAll<{
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
