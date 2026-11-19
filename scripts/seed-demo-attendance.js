#!/usr/bin/env node
/**
 * ============================================================================
 *  seed-demo-attendance.js — realistic demo attendance for acceptance testing
 * ============================================================================
 *
 *  Writes a believable few weeks of mobile clocking for the employees that
 *  already have a bound handset, so a supervisor can walk the live system and
 *  see reports, exceptions, who's-in and the field tracker populated.
 *
 *  USAGE
 *    node scripts/seed-demo-attendance.js                  preview (no writes)
 *    node scripts/seed-demo-attendance.js --apply          insert the rows
 *    node scripts/seed-demo-attendance.js --purge --apply  remove this batch
 *    node scripts/seed-demo-attendance.js --presence-only --apply
 *                                                          refresh live dots
 *    node scripts/seed-demo-attendance.js --list           show the plan
 *
 *  OPTIONS
 *    --batch <id>        marker written into Raw_Payload (default supervisor-demo-v1)
 *    --employee <text>   only seed employees whose name/number matches
 *    --db <file>         force a local SQLite file instead of Turso
 *    --out <dir>         where the manifest goes (default docs/)
 *    --json              machine-readable preview
 *    --purge-all         purge every supervisor-demo row, not just this batch
 *
 *  GROUND RULES
 *    • Only employees with a bound device are seeded. Unbound people are
 *      reported and left alone, exactly as they are in production.
 *    • Device_ID / Device_Name are copied from the binding — no invented kit.
 *    • Punches are placed inside the employee's own geofence, using the same
 *      Haversine maths as src/lib/geo-punch.ts, with a realistic accuracy.
 *    • Timestamps are built in Africa/Harare (UTC+2), never server-local, so
 *      a punch lands on the calendar day a supervisor expects.
 *    • Every row carries Raw_Payload {"seed":"supervisor-demo","batch":…},
 *      which makes it visible in the UI payload viewer and trivial to purge.
 *    • Days that already hold a real (non-seeded) punch are skipped.
 *    • Default is a dry run. Nothing is written without --apply.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const ROOT = path.resolve(__dirname, "..");
const SEED_TAG = "supervisor-demo";
const DEFAULT_BATCH = "supervisor-demo-v1";
const CAT_OFFSET_MS = 2 * 60 * 60 * 1000; // Africa/Harare, no DST
const WEEKDAYS = [1, 2, 3, 4, 5]; // Mon–Fri

/* ------------------------------------------------------------------ */
/* argv / env                                                          */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = {
    apply: false,
    purge: false,
    purgeAll: false,
    presenceOnly: false,
    list: false,
    json: false,
    batch: DEFAULT_BATCH,
    employee: null,
    db: null,
    out: path.join(ROOT, "docs"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--purge") args.purge = true;
    else if (a === "--purge-all") args.purgeAll = true;
    else if (a === "--presence-only") args.presenceOnly = true;
    else if (a === "--list") args.list = true;
    else if (a === "--json") args.json = true;
    else if (a === "--batch") args.batch = String(argv[++i] || DEFAULT_BATCH);
    else if (a === "--employee") args.employee = String(argv[++i] || "").toLowerCase();
    else if (a === "--db") args.db = path.resolve(argv[++i]);
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/seed-demo-attendance.js [--apply] [--purge] [--presence-only] [--list] [--batch <id>] [--employee <text>] [--db <file>] [--out <dir>] [--json]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

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
  if (remoteUrl) return { url: remoteUrl, authToken: remoteToken, label: redactUrl(remoteUrl) };
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
/* Africa/Harare calendar helpers                                      */
/* ------------------------------------------------------------------ */

function catParts(ms) {
  const d = new Date(ms + CAT_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    d: d.getUTCDate(),
    dow: d.getUTCDay(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
  };
}

/** Epoch ms for a CAT wall-clock moment. */
function catMs(y, m, d, hh = 0, mm = 0, ss = 0) {
  return Date.UTC(y, m, d, hh, mm, ss) - CAT_OFFSET_MS;
}

function addDays(parts, n) {
  const t = new Date(Date.UTC(parts.y, parts.m, parts.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay() };
}

function dateKey(parts) {
  return `${parts.y}-${String(parts.m + 1).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
}

function dayStart(parts) {
  return catMs(parts.y, parts.m, parts.d, 0);
}

/** Monday of the week containing `parts`. */
function mondayOf(parts) {
  const offset = (parts.dow + 6) % 7; // Mon=0 … Sun=6
  return addDays(parts, -offset);
}

function parseHhMm(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  if (!match) return fallback;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) return fallback;
  return hh * 60 + mm;
}

/* ------------------------------------------------------------------ */
/* deterministic randomness                                            */
/* ------------------------------------------------------------------ */

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(rand, min, max) {
  return Math.round(min + rand() * (max - min));
}

/* ------------------------------------------------------------------ */
/* geo                                                                 */
/* ------------------------------------------------------------------ */

function haversineMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** A point `distance` metres from the site centre on `bearing` radians. */
function offsetPoint(lat, lng, distance, bearing) {
  const dLat = (distance * Math.cos(bearing)) / 111320;
  const dLng = (distance * Math.sin(bearing)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { latitude: lat + dLat, longitude: lng + dLng };
}

function hasCoords(site) {
  return (
    site &&
    Number.isFinite(Number(site.Latitude)) &&
    Number.isFinite(Number(site.Longitude)) &&
    Number(site.Latitude) !== 0 &&
    Number(site.Longitude) !== 0
  );
}

function allowsMobile(site) {
  const method = String(site.Clocking_Method || "").toLowerCase();
  return method === "geofence" || method === "both";
}

/* ------------------------------------------------------------------ */
/* demo plan                                                           */
/* ------------------------------------------------------------------ */

/**
 * `from` controls the window:
 *   "weeksBack3"  → Monday three weeks before this week (≈3 weeks of history)
 *   "created"     → the day the account was created (partial day allowed)
 *   "createdOr7"  → creation day, but never older than 7 days
 *
 * `skipPreviousWeek` removes the whole Mon–Fri before this week.
 * `extraSkips` removes additional working days counted back from today
 * (0 = today, 1 = yesterday, …). `lateOn` / `missingOutOn` do the same.
 */
const DEMO_PLAN = [
  {
    key: "tatenda",
    match: ["tatenda"],
    from: "weeksBack3",
    skipPreviousWeek: true,
    extraSkips: [2, 11],
    lateOn: 1,
    missingOutOn: 3,
  },
  { key: "farai", match: ["farai"], from: "created" },
  { key: "makonese", match: ["makonese"], from: "created" },
  { key: "nadine", match: ["nadine"], from: "created", missingOutOnCreatedDay: true, lateToday: 22 },
  { key: "ethan", match: ["ethan"], from: "created" },
  { key: "pride", match: ["pride"], from: "createdOr7" },
];

function findPlan(employee) {
  const name = `${employee.Full_Name || ""} ${employee.ERP_User_ID || ""}`.toLowerCase();
  return DEMO_PLAN.find((plan) => plan.match.some((needle) => name.includes(needle))) ?? null;
}

/* ------------------------------------------------------------------ */
/* database                                                            */
/* ------------------------------------------------------------------ */

async function queryAll(client, sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows.map((row) => ({ ...row }));
}

async function loadContext(client) {
  const [employees, branches, shifts] = await Promise.all([
    queryAll(
      client,
      `SELECT Employee_ID, ERP_User_ID, Full_Name, Department, Position, Shift_ID,
              Status, Created_At, Branch_Name,
              Bound_Device_ID, Bound_Device_Name, Bound_Device_At
         FROM Employees
        ORDER BY Employee_ID`
    ),
    queryAll(
      client,
      `SELECT Branch_ID, Branch_Name, Clocking_Method, Latitude, Longitude,
              Geofence_Radius_Meters
         FROM Branches
        ORDER BY Branch_Name`
    ),
    queryAll(client, `SELECT Shift_ID, Name, Start_Time, End_Time, Duration_Minutes, Days FROM Shifts`),
  ]);
  return { employees, branches, shifts };
}

/* ------------------------------------------------------------------ */
/* planning                                                            */
/* ------------------------------------------------------------------ */

function pickSite(employee, branches) {
  const home = branches.find((b) => b.Branch_Name === employee.Branch_Name);
  if (hasCoords(home)) return { site: home, note: allowsMobile(home) ? null : "home branch does not allow mobile clocking" };
  const mobile = branches.find((b) => hasCoords(b) && allowsMobile(b));
  if (mobile) {
    return { site: mobile, note: `no usable home branch; placed at ${mobile.Branch_Name}` };
  }
  return { site: null, note: "no branch with coordinates" };
}

function shiftWindow(employee, shifts) {
  const shift = shifts.find((s) => Number(s.Shift_ID) === Number(employee.Shift_ID));
  const startMin = parseHhMm(shift && shift.Start_Time, 8 * 60);
  let endMin = parseHhMm(shift && shift.End_Time, 17 * 60);
  if (endMin <= startMin) endMin += 24 * 60; // overnight
  return { shift, startMin, endMin };
}

function atMinutes(parts, minutes) {
  const dayOffset = Math.floor(minutes / 1440);
  const within = minutes - dayOffset * 1440;
  const base = addDays(parts, dayOffset);
  return catMs(base.y, base.m, base.d, Math.floor(within / 60), within % 60);
}

/** All calendar days for an employee, oldest first. */
function windowDays(employee, plan, today) {
  const created = catParts(Number(employee.Created_At) || Date.now());

  if (plan.from === "weeksBack3") {
    const start = addDays(mondayOf(today), -21);
    return daysBetween(start, today);
  }

  let start = created;
  if (plan.from === "createdOr7") {
    const sevenBack = addDays(today, -6);
    if (dayStart(sevenBack) > dayStart(created)) start = sevenBack;
  }
  // Never seed a future day.
  if (dayStart(start) > dayStart(today)) start = today;
  return daysBetween(start, today);
}

function daysBetween(start, end) {
  const out = [];
  let cursor = { y: start.y, m: start.m, d: start.d, dow: start.dow };
  const limit = dayStart(end);
  let guard = 0;
  while (dayStart(cursor) <= limit && guard++ < 400) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Working days counted backwards from today: index 0 = today. */
function workingDaysBack(today, maxBack = 40) {
  const out = [];
  let cursor = today;
  for (let i = 0; i < maxBack; i++) {
    if (WEEKDAYS.includes(cursor.dow)) out.push(cursor);
    cursor = addDays(cursor, -1);
  }
  return out;
}

function buildPlan(employee, plan, ctx, today, now) {
  const { site, note } = pickSite(employee, ctx.branches);
  if (!site) {
    return { employee, plan, site: null, note, punches: [], days: [], warnings: [note] };
  }

  const radius = Number(site.Geofence_Radius_Meters) || 150;
  const { shift, startMin, endMin } = shiftWindow(employee, ctx.shifts);
  const createdMs = Number(employee.Created_At) || 0;
  const created = catParts(createdMs || Date.now());
  const back = workingDaysBack(today);

  const skippedDays = new Set();
  if (plan.skipPreviousWeek) {
    for (let i = 4; i <= 8; i++) if (back[i]) skippedDays.add(dateKey(back[i]));
  }
  for (const i of plan.extraSkips ?? []) if (back[i]) skippedDays.add(dateKey(back[i]));

  const lateDay = plan.lateOn != null && back[plan.lateOn] ? dateKey(back[plan.lateOn]) : null;
  const missingOutDay =
    plan.missingOutOn != null && back[plan.missingOutOn] ? dateKey(back[plan.missingOutOn]) : null;

  const days = windowDays(employee, plan, today);
  const punches = [];
  const warnings = note ? [note] : [];

  for (const day of days) {
    const key = dateKey(day);
    if (!WEEKDAYS.includes(day.dow)) continue;
    if (skippedDays.has(key)) continue;

    const rand = mulberry32(hash32(`${employee.ERP_User_ID}:${key}`));

    let inMin = startMin + jitter(rand, -9, -1);
    let outMin = endMin + jitter(rand, -6, 11);
    let includeOut = true;

    // Account created mid-day: start after creation, and skip a partial day
    // that leaves no room for a believable shift.
    if (key === dateKey(created) && createdMs > dayStart(day) + 60_000) {
      const createdMin = Math.ceil((createdMs - dayStart(day)) / 60_000) + 20;
      if (createdMin >= endMin - 60) continue;
      inMin = Math.max(inMin, createdMin);
    }

    if (key === lateDay) inMin = startMin + 42;
    if (plan.lateToday && key === dateKey(today)) inMin = startMin + plan.lateToday;
    if (key === missingOutDay) includeOut = false;
    if (plan.missingOutOnCreatedDay && key === dateKey(created)) includeOut = false;

    const inMs = atMinutes(day, inMin);
    const outMs = atMinutes(day, outMin);

    if (inMs > now) continue; // hasn't happened yet
    punches.push(makePunch(employee, site, radius, inMs, "IN", rand));

    if (includeOut && outMs <= now) {
      punches.push(makePunch(employee, site, radius, outMs, "OUT", rand));
    }
  }

  return { employee, plan, site, shift, punches, days, warnings };
}

function makePunch(employee, site, radius, timestamp, direction, rand) {
  const centreLat = Number(site.Latitude);
  const centreLng = Number(site.Longitude);
  const distance = Math.max(8, Math.round(radius * (0.18 + rand() * 0.5)));
  const bearing = rand() * Math.PI * 2;
  const point = offsetPoint(centreLat, centreLng, distance, bearing);
  const accuracy = Math.round(6 + rand() * 16);

  return {
    employeeId: Number(employee.Employee_ID),
    employeeNumber: employee.ERP_User_ID,
    fullName: employee.Full_Name,
    timestamp,
    direction,
    siteName: site.Branch_Name,
    radiusMeters: radius,
    distanceMeters: Math.round(haversineMeters(centreLat, centreLng, point.latitude, point.longitude)),
    accuracyMeters: accuracy,
    latitude: Number(point.latitude.toFixed(6)),
    longitude: Number(point.longitude.toFixed(6)),
    deviceId: (employee.Bound_Device_ID || "").trim(),
    deviceName: (employee.Bound_Device_Name || "").trim() || null,
  };
}

/* ------------------------------------------------------------------ */
/* preview / write                                                     */
/* ------------------------------------------------------------------ */

function summarise(plans) {
  return plans.map((p) => {
    const dayKeys = new Set(p.punches.map((x) => dateKey(catParts(x.timestamp))));
    const inCount = p.punches.filter((x) => x.direction === "IN").length;
    const outCount = p.punches.filter((x) => x.direction === "OUT").length;
    const first = p.punches.length ? Math.min(...p.punches.map((x) => x.timestamp)) : null;
    const last = p.punches.length ? Math.max(...p.punches.map((x) => x.timestamp)) : null;
    return {
      employeeId: p.employee.Employee_ID,
      employeeNumber: p.employee.ERP_User_ID,
      fullName: p.employee.Full_Name,
      site: p.site ? p.site.Branch_Name : null,
      days: dayKeys.size,
      punches: p.punches.length,
      inCount,
      outCount,
      first,
      last,
      warnings: p.warnings,
    };
  });
}

function printPreview(rows, skipped, batch, applyMode) {
  console.log("");
  console.log(`Batch: ${batch}`);
  console.log(`Mode:  ${applyMode ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
  console.log("");
  console.log(
    ["Employee", "No.", "Days", "IN", "OUT", "Window", "Site"].join("  ")
  );
  console.log("-".repeat(110));
  for (const r of rows) {
    if (!r.punches) continue;
    const window =
      r.first && r.last
        ? `${dateKey(catParts(r.first))} → ${dateKey(catParts(r.last))}`
        : "—";
    console.log(
      [
        r.fullName.padEnd(22).slice(0, 22),
        String(r.employeeNumber).padEnd(10).slice(0, 10),
        String(r.days).padStart(4),
        String(r.inCount).padStart(3),
        String(r.outCount).padStart(4),
        window.padEnd(26),
        r.site ?? "—",
      ].join("  ")
    );
    for (const warning of r.warnings) console.log(`    ! ${warning}`);
  }

  console.log("");
  if (skipped.length) {
    console.log("Not seeded:");
    for (const s of skipped) console.log(`  - ${s.fullName} (${s.employeeNumber}): ${s.reason}`);
    console.log("");
  }

  const total = rows.reduce((n, r) => n + (r.punches ?? 0), 0);
  console.log(`Planned punches: ${total}`);
  if (!applyMode) console.log("Re-run with --apply to write these rows.");
}

async function applyPlan(client, plans, batch, manifestPath) {
  const tx = await client.transaction("write");
  const inserted = [];
  try {
    const totalPunches = plans.reduce((n, p) => n + p.punches.length, 0);
    let index = 0;

    for (const plan of plans) {
      for (const punch of plan.punches) {
        index += 1;
        const payload = JSON.stringify({
          seed: SEED_TAG,
          batch,
          employeeNumber: punch.employeeNumber,
          note: "Synthetic attendance for supervisor acceptance testing",
          site: punch.siteName,
          radiusMeters: punch.radiusMeters,
          distanceMeters: punch.distanceMeters,
          accuracyMeters: punch.accuracyMeters,
        });

        // Keep a small pending queue so the ERP sync screen has something to show.
        const pending = index > totalPunches - 2;

        const res = await tx.execute({
          sql: `INSERT INTO Attendance_Logs
                  (Employee_ID, Timestamp, Terminal_ID, ERP_Sync_Status,
                   Verify_Result, Direction, Verify_Method, Raw_Payload,
                   Latitude, Longitude, Location_Accuracy_Meters,
                   Geofence_Distance_Meters, Created_At, Branch_Name,
                   Device_ID, Device_Name)
                VALUES (?, ?, NULL, ?, 'Verified', ?, 'Geofence', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            punch.employeeId,
            punch.timestamp,
            pending ? "Pending" : "Success",
            punch.direction,
            payload,
            punch.latitude,
            punch.longitude,
            punch.accuracyMeters,
            punch.distanceMeters,
            punch.timestamp,
            punch.siteName,
            punch.deviceId || null,
            punch.deviceName,
          ],
        });

        inserted.push({
          logId: Number(res.lastInsertRowid ?? 0),
          employeeId: punch.employeeId,
          employeeNumber: punch.employeeNumber,
          fullName: punch.fullName,
          timestamp: punch.timestamp,
          direction: punch.direction,
          site: punch.siteName,
          deviceId: punch.deviceId || null,
        });
      }
    }

    await tx.commit();
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* already rolled back */
    }
    throw err;
  }

  const manifest = {
    batch,
    seed: SEED_TAG,
    createdAt: new Date().toISOString(),
    rowCount: inserted.length,
    rows: inserted,
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { inserted, manifestPath };
}

async function refreshPresence(client, plans, now) {
  const todayKey = dateKey(catParts(now));
  const tx = await client.transaction("write");
  const touched = [];
  try {
    for (const plan of plans) {
      if (!plan.site) continue;
      const todays = plan.punches.filter(
        (p) => dateKey(catParts(p.timestamp)) === todayKey
      );
      if (!todays.length) continue;
      const hasOut = todays.some((p) => p.direction === "OUT");
      if (hasOut) continue; // already left for the day

      const last = todays[todays.length - 1];
      const centreLat = Number(plan.site.Latitude);
      const centreLng = Number(plan.site.Longitude);
      const radius = Number(plan.site.Geofence_Radius_Meters) || 150;
      const point = offsetPoint(centreLat, centreLng, radius * 0.35, 0.7);
      const seen = now - 3 * 60_000;

      await tx.execute({
        sql: `INSERT INTO Employee_Presence
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
        args: [
          plan.employee.Employee_ID,
          Number(point.latitude.toFixed(6)),
          Number(point.longitude.toFixed(6)),
          12,
          plan.site.Branch_Name,
          last.deviceId || null,
          last.deviceName,
          seen,
          now,
        ],
      });
      touched.push({ employee: plan.employee.Full_Name, site: plan.site.Branch_Name });
    }
    await tx.commit();
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* already rolled back */
    }
    throw err;
  }
  return touched;
}

async function purgeBatch(client, batch, purgeAll) {
  const like = purgeAll ? `%"seed":"${SEED_TAG}"%` : `%"seed":"${SEED_TAG}","batch":"${batch}"%`;

  const rows = await queryAll(
    client,
    `SELECT Employee_ID, COUNT(*) AS n FROM Attendance_Logs
      WHERE Raw_Payload LIKE ? GROUP BY Employee_ID`,
    [like]
  );
  if (!rows.length) return { deleted: 0, employees: 0 };

  const tx = await client.transaction("write");
  try {
    const res = await tx.execute({
      sql: `DELETE FROM Attendance_Logs WHERE Raw_Payload LIKE ?`,
      args: [like],
    });
    const ids = rows.map((r) => Number(r.Employee_ID)).filter((n) => Number.isFinite(n));
    for (const id of ids) {
      await tx.execute({
        sql: `DELETE FROM Employee_Presence WHERE Employee_ID = ? AND Source = 'mobile'`,
        args: [id],
      });
    }
    await tx.commit();
    return { deleted: Number(res.rowsAffected ?? 0), employees: ids.length };
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvLocal();

  const target = resolveTarget(args);
  const client = createClient({ url: target.url, authToken: target.authToken });

  try {
    const now = Date.now();
    const today = catParts(now);
    const ctx = await loadContext(client);

    // ── purge ────────────────────────────────────────────────────
    if (args.purge) {
      if (!args.apply) {
        const like = args.purgeAll
          ? `%"seed":"${SEED_TAG}"%`
          : `%"seed":"${SEED_TAG}","batch":"${args.batch}"%`;
        const preview = await queryAll(
          client,
          `SELECT COUNT(*) AS n FROM Attendance_Logs WHERE Raw_Payload LIKE ?`,
          [like]
        );
        console.log(`Would purge ${preview[0]?.n ?? 0} row(s) (${args.purgeAll ? "all batches" : args.batch}).`);
        console.log("Re-run with --purge --apply to delete.");
        return;
      }
      const result = await purgeBatch(client, args.batch, args.purgeAll);
      console.log(
        `Purged ${result.deleted} row(s) across ${result.employees} employee(s) (${args.purgeAll ? "all batches" : args.batch}).`
      );
      return;
    }

    // ── choose employees ─────────────────────────────────────────
    const plans = [];
    const skipped = [];
    const matched = [];

    for (const employee of ctx.employees) {
      const plan = findPlan(employee);
      if (!plan) continue;
      matched.push(employee);

      if (args.employee) {
        const haystack = `${employee.Full_Name} ${employee.ERP_User_ID}`.toLowerCase();
        if (!haystack.includes(args.employee)) continue;
      }

      if (!(employee.Bound_Device_ID || "").trim()) {
        skipped.push({
          fullName: employee.Full_Name,
          employeeNumber: employee.ERP_User_ID,
          reason: "no bound device — left untouched",
        });
        continue;
      }

      if (String(employee.Status || "").toLowerCase() !== "active") {
        skipped.push({
          fullName: employee.Full_Name,
          employeeNumber: employee.ERP_User_ID,
          reason: `status is ${employee.Status}`,
        });
        continue;
      }

      plans.push(buildPlan(employee, plan, ctx, today, now));
    }

    if (args.list) {
      console.log(`Matched ${matched.length} employee(s) by name:`);
      for (const e of matched) console.log(`  - ${e.Full_Name} (${e.ERP_User_ID})`);
      const names = ctx.employees.filter((e) => !findPlan(e));
      console.log("");
      console.log("Not in the demo plan:");
      for (const e of names) {
        const bound = (e.Bound_Device_ID || "").trim() ? "bound" : "UNBOUND";
        console.log(`  - ${e.Full_Name} (${e.ERP_User_ID}) — ${bound}`);
      }
      return;
    }

    // ── presence only ────────────────────────────────────────────
    if (args.presenceOnly) {
      if (!args.apply) {
        console.log("Would refresh live presence for employees clocked in today.");
        console.log("Re-run with --presence-only --apply to write.");
        return;
      }
      const touched = await refreshPresence(client, plans, now);
      console.log(`Refreshed live presence for ${touched.length} employee(s):`);
      for (const t of touched) console.log(`  - ${t.employee} @ ${t.site}`);
      return;
    }

    const rows = summarise(plans);

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            batch: args.batch,
            mode: args.apply ? "apply" : "dry-run",
            source: target.label,
            generatedAt: new Date(now).toISOString(),
            employees: rows,
            skipped,
          },
          null,
          2
        ) + "\n"
      );
      if (!args.apply) return;
    }

    if (!args.apply) {
      printPreview(rows, skipped, args.batch, false);
      return;
    }

    // ── apply ────────────────────────────────────────────────────
    const nonEmpty = plans.filter((p) => p.punches.length);
    if (!nonEmpty.length) {
      console.log("Nothing to seed — no matched employee has both a bound device and a usable site.");
      return;
    }

    const manifestPath = path.join(args.out, "demo-data-manifest.json");
    const { inserted, manifestPath: written } = await applyPlan(client, nonEmpty, args.batch, manifestPath);
    const touched = await refreshPresence(client, nonEmpty, now);

    printPreview(rows, skipped, args.batch, true);
    console.log("");
    console.log(`Inserted ${inserted.length} punch(es).`);
    console.log(`Manifest: ${path.relative(ROOT, written)}`);
    console.log(`Live presence refreshed for ${touched.length} employee(s).`);
    console.log("");
    console.log("Remove with: node scripts/seed-demo-attendance.js --purge --apply");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
