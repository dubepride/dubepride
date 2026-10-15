// Seed branch geofences for the Branches table (Phase 17/18 — "clock in at any
// registered site").
//
//   node scripts/seed-branch-geofences.js             fill unset branches only
//   node scripts/seed-branch-geofences.js --force     overwrite every branch
//   node scripts/seed-branch-geofences.js --dry-run   report, change nothing
//
// WHY: the mobile app may clock an employee in at ANY branch whose Clocking
// Method permits mobile clocking (Geofence/Both) and which has a centre +
// radius. Two kinds of site are configured here:
//
//   • The 17 "Branch N" demo sites — plausible Harare-CBD coordinates, DEMO
//     DATA placed ~1.4-2 km apart with a 500 m radius. Re-centre each on its
//     true position from Settings → Branches before anyone relies on them.
//
//   • The real field sites (Belmont, Gwanda, Gweru, …) — their true
//     coordinates, added automatically when missing so a fresh checkout can
//     demo mobile clocking at a real location. Each gets a 150 m radius
//     (Junkshop 100 m — its neighbours are close together).
//
// Every site is set to "Both" (fingerprint terminal AND phone — biometric is
// never disabled). Safe to re-run: by default a branch that already has a
// centre is left alone. Back up data/ta-bridge.db before running with --force.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEMO_RADIUS_METERS = 500;
const DEFAULT_RADIUS_METERS = 150;
const SEED_CREATED_AT = 1791365078189; // 2026-10-06, matches src/lib/db.ts

// Branch_Name → [latitude, longitude, radius?]. Demo sites are spaced so no two
// fences overlap.
const DEMO_FENCES = {
  'Branch 1': [-17.8277, 31.0534], // HQ — pre-existing, the original demo fence
  'Branch 2': [-17.815, 31.0534],
  'Branch 3': [-17.8404, 31.0534],
  'Branch 4': [-17.8277, 31.0729],
  'Branch 5': [-17.8277, 31.0339],
  'Branch 6': [-17.81, 31.073],
  'Branch 7': [-17.845, 31.034],
  'Branch 8': [-17.81, 31.034],
  'Branch 9': [-17.845, 31.073],
  'Branch 10': [-17.8, 31.053],
  'Branch 11': [-17.856, 31.053],
  'Branch 12': [-17.828, 31.092],
  'Branch 13': [-17.828, 31.014],
  'Branch 14': [-17.795, 31.076],
  'Branch 15': [-17.86, 31.03],
  'Branch 16': [-17.795, 31.03],
  'Branch 17': [-17.86, 31.076],
};

// The real field sites — true coordinates. Missing rows are created.
const REAL_FENCES = {
  Belmont: [-20.1725, 28.5752],
  Tongogara: [-20.1503, 28.5898],
  Junkshop: [-20.1486, 28.587, 100],
  Maphisa: [-21.0648, 28.4586],
  'Esigodini 2': [-20.2932, 28.9385],
  Habane: [-20.3123, 28.9426],
  Mthwakazi: [-20.5455, 29.2762],
  Mswela: [-20.5337, 29.2889],
  'Filabusi Mainshop': [-20.5264, 29.2981],
  'Gwanda VID': [-20.9378, 29.0092],
  Thobelani: [-20.9431, 29.0057],
  'Gweru MMS': [-19.4468, 29.8142],
  'Gweru EazyTools': [-19.4484, 29.8103],
};

const FENCES = { ...DEMO_FENCES, ...REAL_FENCES };

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));
}

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const dryRun = args.has('--dry-run');

const dbPath = path.join(__dirname, '..', 'data', 'ta-bridge.db');
const db = new DatabaseSync(dbPath);

const findByName = db.prepare('SELECT Branch_ID FROM Branches WHERE Branch_Name = ?');
const insert = db.prepare(
  `INSERT INTO Branches
     (Branch_Name, Created_At, Clocking_Method, Latitude, Longitude, Geofence_Radius_Meters)
   VALUES (?, ?, ?, ?, ?, ?)`
);

// ── 1. Create any real site that is missing from the table ──────────────────
let created = 0;
console.log('Creating any missing real field sites:');
for (const [name, fence] of Object.entries(REAL_FENCES)) {
  if (findByName.get(name)) continue;
  const [latitude, longitude, radius = DEFAULT_RADIUS_METERS] = fence;
  if (dryRun) {
    console.log(`  →  ${name.padEnd(18)} WOULD be created at ${latitude}, ${longitude} @ ${radius} m`);
  } else {
    insert.run(name, SEED_CREATED_AT, 'Both', latitude, longitude, radius);
    console.log(`  +  ${name.padEnd(18)} created at ${latitude}, ${longitude} @ ${radius} m`);
  }
  created += 1;
}
if (created === 0) console.log('  (all real field sites already present)');

// ── 2. Fill in / refresh centres on every existing branch ───────────────────
const rows = db
  .prepare(
    'SELECT Branch_ID, Branch_Name, Clocking_Method, Latitude, Longitude, Geofence_Radius_Meters FROM Branches ORDER BY Branch_ID'
  )
  .all();

const update = db.prepare(
  `UPDATE Branches
      SET Latitude = ?, Longitude = ?, Geofence_Radius_Meters = ?, Clocking_Method = ?
    WHERE Branch_ID = ?`
);

let changed = 0;
let skipped = 0;

for (const row of rows) {
  const fence = FENCES[row.Branch_Name];
  if (!fence) {
    console.log(`  ?  ${row.Branch_Name.padEnd(18)} no coordinate in this script — skipped`);
    skipped += 1;
    continue;
  }

  const alreadySet = row.Latitude !== null && row.Longitude !== null;
  if (alreadySet && !force) {
    console.log(
      `  =  ${row.Branch_Name.padEnd(18)} already at ${row.Latitude}, ${row.Longitude} @ ${row.Geofence_Radius_Meters} m — left alone`
    );
    skipped += 1;
    continue;
  }

  const [latitude, longitude, radius = DEMO_RADIUS_METERS] = fence;
  if (dryRun) {
    console.log(
      `  →  ${row.Branch_Name.padEnd(18)} WOULD be ${latitude}, ${longitude} @ ${radius} m, method=Both`
    );
    changed += 1;
    continue;
  }

  update.run(latitude, longitude, radius, 'Both', row.Branch_ID);
  console.log(
    `  ✓  ${row.Branch_Name.padEnd(18)} ${latitude}, ${longitude} @ ${radius} m, method=Both`
  );
  changed += 1;
}

// ── Sanity: no two fences should overlap, or the nearest-centre rule decides ──
const configured = db
  .prepare(
    `SELECT Branch_Name, Latitude, Longitude, Geofence_Radius_Meters
       FROM Branches
      WHERE Latitude IS NOT NULL AND Longitude IS NOT NULL AND Geofence_Radius_Meters IS NOT NULL
      ORDER BY Branch_ID`
  )
  .all();

console.log(`\n${configured.length} branch(es) now mobile-capable:`);
for (const row of configured) {
  console.log(
    `   · ${row.Branch_Name.padEnd(18)} (${row.Latitude}, ${row.Longitude}) @ ${row.Geofence_Radius_Meters} m`
  );
}

let overlapping = 0;
for (let i = 0; i < configured.length; i += 1) {
  for (let j = i + 1; j < configured.length; j += 1) {
    const a = configured[i];
    const b = configured[j];
    const metres = haversineMeters(a.Latitude, a.Longitude, b.Latitude, b.Longitude);
    const reach = (a.Geofence_Radius_Meters ?? 0) + (b.Geofence_Radius_Meters ?? 0);
    if (metres < reach) {
      overlapping += 1;
      console.log(
        `   ! ${a.Branch_Name} and ${b.Branch_Name} fences overlap — ${metres} m apart, reach ${reach} m`
      );
    }
  }
}
if (overlapping === 0) console.log('   (no two fences overlap)');

console.log(
  `\n${dryRun ? 'DRY RUN — nothing written.' : `Done. ${created} created, ${changed} branch(es) changed, ${skipped} left alone.`}`
);
if (!dryRun && (changed > 0 || created > 0)) {
  console.log(
    'Restart the bridge so the schema migration adds Attendance_Logs.Branch_Name, then sign in on the phone.'
  );
}

db.close();
