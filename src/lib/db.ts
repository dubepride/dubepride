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
import { DatabaseSync } from "node:sqlite";
import { EXCEPTION_LABELS, EXCEPTION_RULES, EXCEPTION_TYPES } from "@/lib/exception-meta";
import { dateKeyOf, formatPunchTime, startOfTodayMs } from "@/lib/format";
import type {
  AttendanceRecord,
  AttendanceSummary,
  BacklogEntry,
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
  PunchDirection,
  ShiftRow,
  SyncBatchDto,
  SyncBatchRow,
  SyncStats,
  TerminalJoinedRow,
  TerminalRow,
  TerminalStatus,
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
  ensureBranchCoverage(db);
  backfillEmployeeMeta(db);
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

    CREATE INDEX IF NOT EXISTS idx_logs_emp  ON Attendance_Logs (Employee_ID, Timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_sync ON Attendance_Logs (ERP_Sync_Status, Log_ID);
    CREATE INDEX IF NOT EXISTS idx_logs_ts   ON Attendance_Logs (Timestamp DESC);
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
