#!/usr/bin/env node
/**
 * ============================================================================
 *  seed-demo-via-api.js — demo attendance through the live HTTP API
 * ============================================================================
 *
 *  For when the database credentials are not on this machine. Instead of
 *  writing rows directly, this signs in as an administrator and posts each
 *  punch to /api/attendance/geopunch — the exact endpoint the mobile app uses.
 *  Every row is therefore validated by the real geofence policy, lands inside
 *  the real fence, and carries the employee's real bound device.
 *
 *    node scripts/seed-demo-via-api.js --base-url https://… --email … --password …
 *    node scripts/seed-demo-via-api.js … --apply
 *
 *  WHY THE PLAN LOOKS LIKE THIS
 *    The roster's real binding times and real punches decide what can honestly
 *    be backdated:
 *      • Tatenda  — punch at 19 Nov 12:38 already exists, so history stops on
 *                   the 18th. Three weeks back, one whole week skipped.
 *      • Farai / Makonese / Pride — real punches on 18 Nov, so only today.
 *      • Nadine   — device bound 18 Nov 15:16, so her first day starts after
 *                   that; today she arrives 22 minutes late.
 *      • Ethan    — Huawei bound 19 Nov 10:12, so his only punch is today.
 *      • Patience / Mpereri / Testing1 — skipped (unbound or inactive).
 *
 *  REMOVAL
 *    The geofence engine writes its own Raw_Payload, so these rows carry no
 *    seed marker. The manifest records every Log_ID returned by the server;
 *    removing them later is `DELETE FROM Attendance_Logs WHERE Log_ID IN (…)`.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CAT_OFFSET_MS = 2 * 60 * 60 * 1000;
const WEEKDAYS = [1, 2, 3, 4, 5];

/* ------------------------------------------------------------------ */
/* args                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.BB_BASE_URL || "https://biobridge-attendance.vercel.app",
    email: process.env.BB_ADMIN_EMAIL || "admin@biobridge.com",
    password: process.env.BB_ADMIN_PASSWORD || "",
    apply: false,
    json: false,
    out: path.join(ROOT, "docs"),
    pauseMs: 1200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") args.baseUrl = String(argv[++i] || "").replace(/\/+$/, "");
    else if (a === "--email") args.email = String(argv[++i] || "");
    else if (a === "--password") args.password = String(argv[++i] || "");
    else if (a === "--apply") args.apply = true;
    else if (a === "--json") args.json = true;
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--pause-ms") args.pauseMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/seed-demo-via-api.js --base-url <url> --email <email> --password <password> [--apply] [--out <dir>] [--pause-ms <n>]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.password) {
    console.error("A password is required: --password <password> (or BB_ADMIN_PASSWORD).");
    process.exit(2);
  }
  return args;
}

/* ------------------------------------------------------------------ */
/* Africa/Harare calendar                                              */
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

function catMs(y, m, d, hh = 0, mm = 0) {
  return Date.UTC(y, m, d, hh, mm, 0) - CAT_OFFSET_MS;
}

function addDays(parts, n) {
  const t = new Date(Date.UTC(parts.y, parts.m, parts.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay() };
}

function dateKey(parts) {
  return `${parts.y}-${String(parts.m + 1).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
}

function atMinutes(parts, minutes) {
  const dayOffset = Math.floor(minutes / 1440);
  const within = minutes - dayOffset * 1440;
  const base = addDays(parts, dayOffset);
  return catMs(base.y, base.m, base.d, Math.floor(within / 60), within % 60);
}

/* ------------------------------------------------------------------ */
/* deterministic jitter                                                */
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

function offsetPoint(lat, lng, distance, bearing) {
  const dLat = (distance * Math.cos(bearing)) / 111320;
  const dLng = (distance * Math.sin(bearing)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { latitude: lat + dLat, longitude: lng + dLng };
}

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */

function cookieFrom(response) {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  if (!raw.length) return null;
  return raw.map((line) => line.split(";")[0]).join("; ");
}

async function request(args, cookie, method, pathname, body) {
  const res = await fetch(`${args.baseUrl}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  return { status: res.status, data, cookie: cookieFrom(res) };
}

async function signIn(args) {
  const res = await request(args, null, "POST", "/api/auth/login", {
    email: args.email,
    password: args.password,
  });
  if (res.status !== 200 || !res.data?.ok) {
    throw new Error(`Login failed (${res.status}): ${res.data?.error || "unknown error"}`);
  }
  if (!res.cookie) throw new Error("Login succeeded but no session cookie was returned.");
  return { cookie: res.cookie, account: res.data.account };
}

/* ------------------------------------------------------------------ */
/* plan                                                                */
/* ------------------------------------------------------------------ */

function buildPlan({ employees, site, existingDays, now }) {
  const byNumber = new Map(employees.map((e) => [e.erpUserId, e]));
  const today = catParts(now);
  const plan = [];
  const skipped = [];

  const add = (employee, day, minutes, direction) => {
    if (!employee) return;
    if (!(employee.boundDeviceId || "").trim()) {
      skipped.push(`${employee.fullName}: no bound device`);
      return;
    }
    const timestamp = atMinutes(day, minutes);
    if (timestamp > now - 60_000) return; // never write the future

    const rand = mulberry32(hash32(`${employee.erpUserId}:${dateKey(day)}:${direction}`));
    const radius = Number(site.geofenceRadiusMeters) || 81;
    const distance = radius * (0.3 + rand() * 0.3);
    const point = offsetPoint(
      Number(site.latitude),
      Number(site.longitude),
      distance,
      rand() * Math.PI * 2
    );

    plan.push({
      employeeId: employee.id,
      employeeRef: employee.erpUserId,
      fullName: employee.fullName,
      direction,
      timestamp,
      dayKey: dateKey(day),
      latitude: Number(point.latitude.toFixed(6)),
      longitude: Number(point.longitude.toFixed(6)),
      accuracyMeters: Math.round(8 + rand() * 10),
      deviceId: employee.boundDeviceId,
      deviceName: employee.boundDeviceName,
      site: site.name,
    });
  };

  // ── Tatenda: three weeks of history, one week off, one late, one lost OUT ──
  const tatenda = byNumber.get("EMP1003");
  const skipDays = new Set();
  // Whole previous week (Mon 9 Nov → Fri 13 Nov for a 19 Nov run).
  for (let back = 10; back >= 6; back--) skipDays.add(dateKey(addDays(today, -back)));
  // One extra weekday off.
  skipDays.add(dateKey(addDays(today, -2)));

  const lateKey = dateKey(addDays(today, -3)); // Mon 16 Nov → 08:42
  const missingOutKey = dateKey(addDays(today, -15)); // Wed 4 Nov → no clock-out

  if (tatenda) {
    for (let back = 24; back >= 1; back--) {
      const day = addDays(today, -back);
      if (!WEEKDAYS.includes(day.dow)) continue;
      const key = dateKey(day);
      if (skipDays.has(key)) continue;
      if (tatenda.lastSeen && existingDays.has(`${tatenda.id}:${key}`)) continue;

      const rand = mulberry32(hash32(`EMP1003:${key}`));
      const inMinutes = key === lateKey ? 8 * 60 + 42 : 8 * 60 + jitter(rand, -9, -1);
      const outMinutes = 17 * 60 + jitter(rand, -6, 11);

      add(tatenda, day, inMinutes, "IN");
      if (key !== missingOutKey) add(tatenda, day, outMinutes, "OUT");
    }
  }

  // ── Today only: devices that were already punched yesterday ──────────
  const todayOnly = [
    ["EMP1008", 8 * 60 - 8], // Farai      07:52
    ["EMP1010", 8 * 60 - 7], // Makonese   07:53
    ["EMP1001", 8 * 60 - 5], // Pride      07:55
    ["EMP1006", 8 * 60 + 22], // Nadine     08:22 — the late arrival
    ["EMP1004", 10 * 60 + 15], // Ethan     10:15 — Huawei bound at 10:12
  ];
  for (const [number, minutes] of todayOnly) {
    const employee = byNumber.get(number);
    if (!employee) continue;
    const key = dateKey(today);
    if (employee.lastSeen && existingDays.has(`${employee.id}:${key}`)) continue;
    add(employee, today, minutes, "IN");
  }

  // ── Nadine: her first afternoon, after the 15:16 binding on 18 Nov ────
  const nadine = byNumber.get("EMP1006");
  if (nadine) {
    const yesterday = addDays(today, -1);
    const key = dateKey(yesterday);
    if (existingDays.has(`${nadine.id}:${key}`)) {
      skipped.push("Nadine: 18 Nov already has a punch");
    } else {
      add(nadine, yesterday, 15 * 60 + 20, "IN");
      add(nadine, yesterday, 17 * 60 + 5, "OUT");
    }
  }

  plan.sort((a, b) => a.timestamp - b.timestamp);
  return { plan, skipped };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = Date.now();

  const auth = await signIn(args);
  console.log(`Signed in as ${auth.account?.name || args.email} at ${args.baseUrl}`);

  const employeesRes = await request(args, auth.cookie, "GET", "/api/employees");
  if (employeesRes.status !== 200) throw new Error(`GET /api/employees → ${employeesRes.status}`);
  const employees = employeesRes.data.employees || [];

  const branchesRes = await request(args, auth.cookie, "GET", "/api/settings/branches");
  if (branchesRes.status !== 200) throw new Error(`GET /api/settings/branches → ${branchesRes.status}`);
  const site = (branchesRes.data.branches || []).find((b) => b.name === "Belmont");
  if (!site) throw new Error("Belmont site not found.");

  const today = catParts(now);
  const from = dateKey(addDays(today, -30));
  const to = dateKey(today);
  const recordsRes = await request(
    args,
    auth.cookie,
    "GET",
    `/api/attendance-records?from=${from}&to=${to}&pageSize=200`
  );
  if (recordsRes.status !== 200) throw new Error(`GET /api/attendance-records → ${recordsRes.status}`);

  const existingDays = new Set();
  for (const row of recordsRes.data.rows || []) {
    existingDays.add(`${row.employeeId}:${dateKey(catParts(row.dateMs))}`);
  }

  const { plan, skipped } = buildPlan({ employees, site, existingDays, now });

  if (!plan.length) {
    console.log("Nothing to seed.");
    return;
  }

  const summary = new Map();
  for (const p of plan) {
    const key = `${p.employeeRef} ${p.fullName}`;
    summary.set(key, (summary.get(key) || 0) + 1);
  }

  console.log("");
  console.log(`Site:  ${site.name} (${site.latitude}, ${site.longitude}) r=${site.geofenceRadiusMeters} m`);
  console.log(`Mode:  ${args.apply ? "APPLY" : "DRY RUN"}`);
  console.log("");
  for (const [who, count] of summary) console.log(`  ${who.padEnd(26)} ${count} punch(es)`);
  for (const s of skipped) console.log(`  ! ${s}`);
  console.log("");
  console.log(`Total: ${plan.length} punch(es)`);
  console.log(`First: ${plan[0].dayKey} · Last: ${plan[plan.length - 1].dayKey}`);

  if (!args.apply) {
    console.log("");
    console.log("Re-run with --apply to POST these to the live system.");
    return;
  }

  const results = [];
  let failures = 0;

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const res = await request(args, auth.cookie, "POST", "/api/attendance/geopunch", {
      employeeRef: p.employeeRef,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      latitude: p.latitude,
      longitude: p.longitude,
      accuracyMeters: p.accuracyMeters,
      direction: p.direction,
      timestamp: p.timestamp,
    });

    const ok = res.status === 200 && res.data?.ok === true;
    if (!ok) failures += 1;

    results.push({
      ok,
      status: res.status,
      logId: ok ? res.data?.punch?.logId ?? null : null,
      employeeRef: p.employeeRef,
      fullName: p.fullName,
      timestamp: p.timestamp,
      dayKey: p.dayKey,
      direction: p.direction,
      reason: ok ? null : res.data?.reason || res.data?.error || res.data?.message || null,
    });

    const mark = ok ? "ok  " : "FAIL";
    console.log(
      `[${String(i + 1).padStart(2)}/${plan.length}] ${mark} ${p.employeeRef} ${p.dayKey} ${p.direction}` +
        (ok ? "" : ` — ${res.status} ${res.data?.reason || res.data?.error || ""}`)
    );

    if (i < plan.length - 1 && args.pauseMs) {
      await new Promise((resolve) => setTimeout(resolve, args.pauseMs));
    }
  }

  const manifest = {
    generatedAt: new Date(now).toISOString(),
    baseUrl: args.baseUrl,
    site: site.name,
    total: plan.length,
    inserted: results.filter((r) => r.ok).length,
    failed: failures,
    rows: results,
  };
  fs.mkdirSync(args.out, { recursive: true });
  const manifestPath = path.join(args.out, "demo-data-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log("");
  console.log(`Inserted ${manifest.inserted} of ${plan.length}. Failures: ${failures}.`);
  console.log(`Manifest: ${path.relative(ROOT, manifestPath)}`);

  if (failures) {
    const reasons = new Map();
    for (const r of results.filter((x) => !x.ok)) {
      const key = `${r.status} ${r.reason}`;
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
    for (const [reason, count] of reasons) console.log(`  ${count} × ${reason}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Seed failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
