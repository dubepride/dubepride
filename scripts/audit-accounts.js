#!/usr/bin/env node
/**
 * ============================================================================
 *  audit-accounts.js — READ-ONLY inventory of accounts, employees & devices
 * ============================================================================
 *
 *  Produces the "who exists in the system and what are they bound to" picture
 *  the supervisor pack needs, without touching a single row.
 *
 *    node scripts/audit-accounts.js                 write docs/ report + CSVs
 *    node scripts/audit-accounts.js --json          machine-readable stdout
 *    node scripts/audit-accounts.js --out <dir>     change the output folder
 *    node scripts/audit-accounts.js --days 60       attendance look-back window
 *    node scripts/audit-accounts.js --db <path>     force a local SQLite file
 *
 *  CONNECTION
 *    Same rules as src/lib/sqlite.ts:
 *      TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN)  → remote Turso
 *      LIBSQL_DATABASE_URL  (+ LIBSQL_AUTH_TOKEN) → remote libSQL
 *      otherwise TA_DB_PATH or data/ta-bridge.db  → local file
 *    `.env.local` is read automatically so this script behaves like the app.
 *
 *  SAFETY
 *    Every statement here is a SELECT. There is no write path in this file.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const ROOT = path.resolve(__dirname, "..");
const TZ = "Africa/Harare";

/* ------------------------------------------------------------------ */
/* argv                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { json: false, out: path.join(ROOT, "docs"), days: 30, db: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--days") args.days = Math.max(1, Number(argv[++i]) || 30);
    else if (a === "--db") args.db = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/audit-accounts.js [--json] [--out <dir>] [--days <n>] [--db <file>]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/* ------------------------------------------------------------------ */
/* env                                                                 */
/* ------------------------------------------------------------------ */

/** Minimal .env.local reader: KEY=VALUE, # comments, optional quotes. */
function loadEnvLocal() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveTarget(args) {
  if (args.db) return { url: `file:${args.db}`, authToken: undefined, label: args.db };

  const remoteUrl = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_DATABASE_URL;
  const remoteToken = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN;
  if (remoteUrl) {
    return {
      url: remoteUrl,
      authToken: remoteToken,
      label: redactUrl(remoteUrl),
    };
  }

  const file = path.resolve(ROOT, process.env.TA_DB_PATH || "data/ta-bridge.db");
  return { url: `file:${file}`, authToken: undefined, label: file };
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

const dtf = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtTs(ms) {
  if (ms === null || ms === undefined || ms === "") return "—";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return dtf.format(new Date(n)).replace(",", "");
}

function fmtDay(ms) {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Number(ms)));
}

function orDash(v) {
  if (v === null || v === undefined) return "—";
  const s = String(v).trim();
  return s === "" ? "—" : s;
}

function cell(v) {
  return String(orDash(v)).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(headers, rows) {
  const head = `| ${headers.map(cell).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

function csvValue(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvValue).join(",")).join("\r\n") + "\r\n";
}

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

async function safeAll(client, sql, params = []) {
  try {
    const res = await client.execute({ sql, args: params });
    return res.rows.map((row) => ({ ...row }));
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

async function collect(client, days) {
  const since = Date.now() - days * 86_400_000;

  const [accounts, employees, branches, shifts, logs, presence, levels] = await Promise.all([
    safeAll(
      client,
      `SELECT a.Account_ID, a.First_Name, a.Surname, a.Company_Email,
              a.Access_Level_ID, a.Branch_ID, a.Employee_ID, a.Created_At,
              l.Level_Name, b.Branch_Name AS Account_Branch,
              e.Full_Name AS Linked_Employee, e.ERP_User_ID AS Linked_Employee_No
         FROM System_Accounts a
         LEFT JOIN Access_Levels l ON l.Access_Level_ID = a.Access_Level_ID
         LEFT JOIN Branches      b ON b.Branch_ID       = a.Branch_ID
         LEFT JOIN Employees     e ON e.Employee_ID     = a.Employee_ID
        ORDER BY a.Account_ID`
    ),
    safeAll(
      client,
      `SELECT Employee_ID, ERP_User_ID, Full_Name, Department, Position,
              Shift_ID, Status, Created_At, Branch_Name,
              Bound_Device_ID, Bound_Device_Name, Bound_Device_At
         FROM Employees
        ORDER BY Employee_ID`
    ),
    safeAll(
      client,
      `SELECT Branch_ID, Branch_Name, Clocking_Method, Latitude, Longitude,
              Geofence_Radius_Meters, Created_At
         FROM Branches
        ORDER BY Branch_Name`
    ),
    safeAll(
      client,
      `SELECT Shift_ID, Name, Start_Time, End_Time, Duration_Minutes, Days
         FROM Shifts
        ORDER BY Shift_ID`
    ),
    safeAll(
      client,
      `SELECT Employee_ID, Timestamp, Direction, Verify_Result, Verify_Method,
              ERP_Sync_Status, Branch_Name, Device_ID, Device_Name,
              Latitude, Longitude, Location_Accuracy_Meters,
              Geofence_Distance_Meters, Raw_Payload
         FROM Attendance_Logs
        WHERE Timestamp >= ?
        ORDER BY Timestamp DESC`,
      [since]
    ),
    safeAll(
      client,
      `SELECT Employee_ID, Branch_Name, Device_ID, Device_Name, Source,
              Accuracy_Meters, Last_Seen
         FROM Employee_Presence
        ORDER BY Last_Seen DESC`
    ),
    safeAll(client, `SELECT Access_Level_ID, Level_Name, Permissions_JSON FROM Access_Levels ORDER BY Access_Level_ID`),
  ]);

  return { since, accounts, employees, branches, shifts, logs, presence, levels };
}

/* ------------------------------------------------------------------ */
/* derivation                                                          */
/* ------------------------------------------------------------------ */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function derive(data) {
  const accounts = asArray(data.accounts);
  const employees = asArray(data.employees);
  const logs = asArray(data.logs);
  const presence = asArray(data.presence);

  const logsByEmployee = new Map();
  for (const log of logs) {
    const key = log.Employee_ID;
    if (!logsByEmployee.has(key)) {
      logsByEmployee.set(key, []);
    }
    logsByEmployee.get(key).push(log);
  }

  const employeeRows = employees.map((e) => {
    const mine = logsByEmployee.get(e.Employee_ID) ?? [];
    const devices = [...new Set(mine.map((l) => l.Device_ID).filter(Boolean))];
    return {
      ...e,
      bound: Boolean((e.Bound_Device_ID || "").trim()),
      windowPunches: mine.length,
      firstPunch: mine.length ? Math.min(...mine.map((l) => Number(l.Timestamp))) : null,
      lastPunch: mine.length ? Math.max(...mine.map((l) => Number(l.Timestamp))) : null,
      punchDevices: devices,
      lastDevice: mine.length ? mine[0].Device_ID : null,
      presence: presence.find((p) => p.Employee_ID === e.Employee_ID) ?? null,
    };
  });

  // One physical device bound to more than one employee is a data smell:
  // either a shared handset or a re-used ID after a reinstall.
  const byDevice = new Map();
  for (const e of employees) {
    const id = (e.Bound_Device_ID || "").trim();
    if (!id) continue;
    if (!byDevice.has(id)) byDevice.set(id, []);
    byDevice.get(id).push(e);
  }
  const sharedDevices = [...byDevice.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([deviceId, list]) => ({
      deviceId,
      deviceName: list[0].Bound_Device_Name || "",
      employees: list.map((e) => `${e.Full_Name} (${e.ERP_User_ID})`),
    }));

  const flags = [];
  for (const e of employeeRows) {
    if (!e.bound) {
      flags.push({
        severity: "info",
        subject: `${e.Full_Name} (${e.ERP_User_ID})`,
        issue: "No bound device — mobile clocking will be refused until the first login binds a handset.",
      });
    }
    if (!(e.Branch_Name || "").trim()) {
      flags.push({
        severity: "warn",
        subject: `${e.Full_Name} (${e.ERP_User_ID})`,
        issue: "No home branch — geofence lookup falls back to any site that allows mobile clocking.",
      });
    }
    if (!e.Shift_ID) {
      flags.push({
        severity: "warn",
        subject: `${e.Full_Name} (${e.ERP_User_ID})`,
        issue: "No shift assigned — late/absent maths cannot be applied.",
      });
    }
    if (e.bound && e.lastDevice && e.lastDevice !== (e.Bound_Device_ID || "").trim()) {
      flags.push({
        severity: "warn",
        subject: `${e.Full_Name} (${e.ERP_User_ID})`,
        issue: `Last punch came from ${e.lastDevice}, which is not the bound device (${e.Bound_Device_ID}).`,
      });
    }
  }

  for (const branch of asArray(data.branches)) {
    const method = String(branch.Clocking_Method || "").toLowerCase();
    const mobile = method === "geofence" || method === "both";
    if (mobile && (branch.Latitude == null || branch.Longitude == null)) {
      flags.push({
        severity: "error",
        subject: `Branch ${branch.Branch_Name}`,
        issue: "Mobile clocking allowed but the site has no centre coordinates.",
      });
    }
    if (mobile && !branch.Geofence_Radius_Meters) {
      flags.push({
        severity: "error",
        subject: `Branch ${branch.Branch_Name}`,
        issue: "Mobile clocking allowed but no geofence radius is set.",
      });
    }
  }

  for (const shared of sharedDevices) {
    flags.push({
      severity: "warn",
      subject: shared.deviceName || shared.deviceId,
      issue: `One device is bound to ${shared.employees.length} employees: ${shared.employees.join(", ")}.`,
    });
  }

  for (const account of accounts) {
    if (account.Employee_ID == null) {
      flags.push({
        severity: "info",
        subject: `${account.First_Name} ${account.Surname} <${account.Company_Email}>`,
        issue: "Console account is not linked to an employee record (admin-only login).",
      });
    }
  }

  const counts = {
    consoleAccounts: accounts.length,
    employees: employees.length,
    boundEmployees: employeeRows.filter((e) => e.bound).length,
    unboundEmployees: employeeRows.filter((e) => !e.bound).length,
    branches: asArray(data.branches).length,
    shifts: asArray(data.shifts).length,
    punchesInWindow: logs.length,
    livePresence: presence.filter((p) => Number(p.Last_Seen) > Date.now() - 30 * 60_000).length,
  };

  return { employeeRows, sharedDevices, flags, counts };
}

/* ------------------------------------------------------------------ */
/* markdown                                                            */
/* ------------------------------------------------------------------ */

function buildMarkdown(target, days, data, derived, generatedAt) {
  const { accounts, branches, shifts, logs, levels } = data;
  const { employeeRows, flags, counts } = derived;
  const out = [];

  out.push("# BioBridge — Accounts & Device Inventory");
  out.push("");
  out.push(`- **Generated:** ${fmtTs(generatedAt)} (${TZ})`);
  out.push(`- **Source:** \`${target.label}\``);
  out.push(`- **Attendance window:** last ${days} days`);
  out.push("- **Mode:** read-only audit (no writes)");
  out.push("");

  out.push("## Summary");
  out.push("");
  out.push(
    table(
      ["Metric", "Count"],
      [
        ["Console accounts (System_Accounts)", counts.consoleAccounts],
        ["Employees (mobile roster)", counts.employees],
        ["Employees with a bound device", counts.boundEmployees],
        ["Employees without a bound device", counts.unboundEmployees],
        ["Branches", counts.branches],
        ["Shifts", counts.shifts],
        [`Punches in last ${days} days`, counts.punchesInWindow],
        ["Live presence (seen < 30 min)", counts.livePresence],
      ]
    )
  );
  out.push("");

  out.push("## Console accounts");
  out.push("");
  if (accounts.error) {
    out.push(`> Could not read System_Accounts: ${accounts.error}`);
  } else if (!accounts.length) {
    out.push("_No console accounts._");
  } else {
    out.push(
      table(
        ["#", "Name", "Email", "Access level", "Branch", "Linked employee", "Created"],
        accounts.map((a) => [
          a.Account_ID,
          `${a.First_Name} ${a.Surname}`,
          a.Company_Email,
          a.Level_Name,
          a.Account_Branch,
          a.Linked_Employee
            ? `${a.Linked_Employee} (${a.Linked_Employee_No})`
            : "— (admin only)",
          fmtTs(a.Created_At),
        ])
      )
    );
  }
  out.push("");

  out.push("## Employees & bound devices");
  out.push("");
  if (!employeeRows.length) {
    out.push("_No employee records._");
  } else {
    out.push(
      table(
        ["#", "Employee no.", "Name", "Dept", "Branch", "Shift", "Status", "Created", "Bound device", "Device ID", "Bound at"],
        employeeRows.map((e) => [
          e.Employee_ID,
          e.ERP_User_ID,
          e.Full_Name,
          e.Department,
          e.Branch_Name,
          e.Shift_ID,
          e.Status,
          fmtDay(e.Created_At),
          e.bound ? e.Bound_Device_Name || "(unnamed)" : "**UNBOUND**",
          e.Bound_Device_ID,
          fmtTs(e.Bound_Device_At),
        ])
      )
    );
  }
  out.push("");

  out.push("## Punch activity (last " + days + " days)");
  out.push("");
  if (!employeeRows.length) {
    out.push("_No employees._");
  } else {
    out.push(
      table(
        ["Employee", "Punches", "First punch", "Last punch", "Devices seen", "Presence"],
        employeeRows.map((e) => [
          `${e.Full_Name} (${e.ERP_User_ID})`,
          e.windowPunches,
          fmtTs(e.firstPunch),
          fmtTs(e.lastPunch),
          e.punchDevices.length ? e.punchDevices.join(", ") : "—",
          e.presence ? `${fmtTs(e.presence.Last_Seen)} · ${e.presence.Branch_Name || "no site"}` : "—",
        ])
      )
    );
  }
  out.push("");

  out.push("## Branches / clocking sites");
  out.push("");
  if (branches.error) {
    out.push(`> Could not read Branches: ${branches.error}`);
  } else if (!branches.length) {
    out.push("_No branches configured._");
  } else {
    out.push(
      table(
        ["Branch", "Method", "Latitude", "Longitude", "Radius (m)", "Mobile clocking"],
        branches.map((b) => {
          const method = String(b.Clocking_Method || "");
          const mobile = ["geofence", "both"].includes(method.toLowerCase());
          return [
            b.Branch_Name,
            method,
            b.Latitude,
            b.Longitude,
            b.Geofence_Radius_Meters,
            mobile ? "yes" : "no",
          ];
        })
      )
    );
  }
  out.push("");

  out.push("## Shifts");
  out.push("");
  if (!shifts.length) {
    out.push("_No shifts configured._");
  } else {
    out.push(
      table(
        ["#", "Name", "Start", "End", "Duration (min)", "Days"],
        shifts.map((s) => [s.Shift_ID, s.Name, s.Start_Time, s.End_Time, s.Duration_Minutes, s.Days])
      )
    );
  }
  out.push("");

  out.push("## Access levels");
  out.push("");
  if (!levels.length) {
    out.push("_No access levels._");
  } else {
    out.push(
      table(
        ["#", "Level", "Permissions"],
        levels.map((l) => [l.Access_Level_ID, l.Level_Name, l.Permissions_JSON])
      )
    );
  }
  out.push("");

  out.push("## Data quality flags");
  out.push("");
  if (!flags.length) {
    out.push("_No issues detected._");
  } else {
    const rank = { error: 0, warn: 1, info: 2 };
    out.push(
      table(
        ["Severity", "Subject", "Issue"],
        [...flags]
          .sort((a, b) => rank[a.severity] - rank[b.severity])
          .map((f) => [f.severity.toUpperCase(), f.subject, f.issue])
      )
    );
  }
  out.push("");

  out.push("## Recent punches (last 40)");
  out.push("");
  if (!logs.length) {
    out.push("_No punches in the window._");
  } else {
    out.push(
      table(
        ["When", "Employee", "Dir", "Method", "Result", "Sync", "Branch", "Device", "Dist (m)", "Acc (m)"],
        logs.slice(0, 40).map((l) => [
          fmtTs(l.Timestamp),
          l.Employee_ID,
          l.Direction,
          l.Verify_Method,
          l.Verify_Result,
          l.ERP_Sync_Status,
          l.Branch_Name,
          l.Device_Name || l.Device_ID,
          l.Geofence_Distance_Meters,
          l.Location_Accuracy_Meters,
        ])
      )
    );
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push("_Generated by `scripts/audit-accounts.js` (read-only)._");

  return out.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvLocal();

  const target = resolveTarget(args);
  const client = createClient({ url: target.url, authToken: target.authToken });

  let data;
  try {
    data = await collect(client, args.days);
  } finally {
    client.close();
  }

  const derived = derive(data);
  const generatedAt = Date.now();

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          generatedAt,
          timeZone: TZ,
          source: target.label,
          days: args.days,
          counts: derived.counts,
          accounts: asArray(data.accounts),
          employees: derived.employeeRows,
          branches: asArray(data.branches),
          shifts: asArray(data.shifts),
          flags: derived.flags,
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });

  const markdown = buildMarkdown(target, args.days, data, derived, generatedAt);
  const mdPath = path.join(args.out, "ACCOUNTS-AND-DEVICES.md");
  fs.writeFileSync(mdPath, markdown, "utf8");

  const accountsCsv = toCsv(
    ["Account_ID", "First_Name", "Surname", "Email", "Access_Level", "Branch", "Employee_ID", "Linked_Employee", "Created_At_ISO"],
    asArray(data.accounts).map((a) => [
      a.Account_ID,
      a.First_Name,
      a.Surname,
      a.Company_Email,
      a.Level_Name,
      a.Account_Branch,
      a.Employee_ID,
      a.Linked_Employee,
      a.Created_At ? new Date(Number(a.Created_At)).toISOString() : "",
    ])
  );
  fs.writeFileSync(path.join(args.out, "accounts.csv"), accountsCsv, "utf8");

  const employeesCsv = toCsv(
    [
      "Employee_ID",
      "Employee_Number",
      "Full_Name",
      "Department",
      "Position",
      "Branch",
      "Shift_ID",
      "Status",
      "Created_At_ISO",
      "Bound",
      "Bound_Device_ID",
      "Bound_Device_Name",
      "Bound_Device_At_ISO",
      "Punches_In_Window",
      "Last_Punch_ISO",
    ],
    derived.employeeRows.map((e) => [
      e.Employee_ID,
      e.ERP_User_ID,
      e.Full_Name,
      e.Department,
      e.Position,
      e.Branch_Name,
      e.Shift_ID,
      e.Status,
      e.Created_At ? new Date(Number(e.Created_At)).toISOString() : "",
      e.bound ? "yes" : "no",
      e.Bound_Device_ID,
      e.Bound_Device_Name,
      e.Bound_Device_At ? new Date(Number(e.Bound_Device_At)).toISOString() : "",
      e.windowPunches,
      e.lastPunch ? new Date(Number(e.lastPunch)).toISOString() : "",
    ])
  );
  fs.writeFileSync(path.join(args.out, "employees-devices.csv"), employeesCsv, "utf8");

  console.log(`Source:      ${target.label}`);
  console.log(`Accounts:    ${derived.counts.consoleAccounts}`);
  console.log(
    `Employees:   ${derived.counts.employees} (${derived.counts.boundEmployees} bound, ${derived.counts.unboundEmployees} unbound)`
  );
  console.log(`Branches:    ${derived.counts.branches}`);
  console.log(`Punches:     ${derived.counts.punchesInWindow} in the last ${args.days} days`);
  console.log(`Flags:       ${derived.flags.length}`);
  console.log("");
  console.log(`Wrote ${path.relative(ROOT, mdPath)}`);
  console.log(`Wrote ${path.relative(ROOT, path.join(args.out, "accounts.csv"))}`);
  console.log(`Wrote ${path.relative(ROOT, path.join(args.out, "employees-devices.csv"))}`);
}

main().catch((err) => {
  console.error("Audit failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
