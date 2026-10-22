/**
 * ============================================================================
 *  scripts/seed-demo.ts — create the labelled demo estate
 * ============================================================================
 *
 *      npm run demo:seed
 *
 *  What it does:
 *
 *    1. Points the application at a DEMO database. By default that is
 *       `data/mineazy-demo.db` — a separate file, so the demo can never
 *       contaminate a live installation. Set `MINEAZY_DB_PATH` to use a
 *       specific database instead.
 *    2. Turns the collector into "simulated" mode.
 *    3. Creates the demo estate (Starlink → Edge Router → Admin Switch →
 *       White House / Workshop Switch → six endpoints).
 *    4. Runs a few collector cycles so the counters produce real RATES
 *       (a rate needs two readings — the first sample is a baseline).
 *    5. Prints a summary.
 *
 *  Everything it creates is flagged as simulated:
 *    • devices carry `Simulated = 1`
 *    • connections carry `Source = 'simulated'`
 *    • the console shows a "SIMULATED" banner while the demo estate exists
 *
 *  The script is IDEMPOTENT: running it twice does not duplicate anything.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* Environment — must be set BEFORE any src/ module is imported        */
/* ------------------------------------------------------------------ */

const DEFAULT_DEMO_DB = path.join(process.cwd(), "data", "mineazy-demo.db");

process.env.MINEAZY_DB_PATH = process.env.MINEAZY_DB_PATH?.trim() || DEFAULT_DEMO_DB;
process.env.MINEAZY_DEMO = "1";

/** How many collector cycles to run so that rates exist. */
const CYCLES = Number(process.env.MINEAZY_DEMO_CYCLES ?? "3");

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function heading(text: string): void {
  console.log("");
  console.log(text);
  console.log("─".repeat(text.length));
}

function table(rows: string[][]): void {
  if (rows.length === 0) {
    console.log("  (nothing)");
    return;
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    console.log(
      "  " + row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()
    );
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const dbPath = process.env.MINEAZY_DB_PATH!;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  console.log("╭──────────────────────────────────────────────────────────────╮");
  console.log("│  Mineazy Network — demo seed                                │");
  console.log("│  SIMULATED DATA. No real hardware is contacted.             │");
  console.log("╰──────────────────────────────────────────────────────────────╯");

  // Dynamic imports: the modules read the environment when they are loaded.
  const { setSetting, getSetting } = await import("../src/lib/settings");
  const { seedSimulatedTopology, simulateCycle, clearFaults } = await import(
    "../src/collector/simulator"
  );
  const { listDevices } = await import("../src/lib/repo/devices");
  const { listIncidents } = await import("../src/lib/repo/incidents");
  const { listEvents } = await import("../src/lib/repo/events");
  const { listPorts } = await import("../src/lib/repo/ports");

  heading("Database");
  console.log(`  path          ${dbPath}`);
  console.log(`  demo mode     ${process.env.MINEAZY_DEMO}`);

  // The collector must run the simulator for the demo to advance.
  await setSetting("collector.mode", "simulated");

  // Start from a clean fault state so the estate is healthy after seeding.
  await clearFaults();

  heading("Seeding the estate");
  const seeded = await seedSimulatedTopology();
  console.log(`  devices       ${seeded.devices}`);
  console.log(`  connections   ${seeded.connections}`);

  heading(`Running ${CYCLES} collector cycle${CYCLES === 1 ? "" : "s"}`);
  for (let index = 0; index < CYCLES; index += 1) {
    const result = await simulateCycle();
    console.log(`  cycle ${index + 1}/${CYCLES} — ${result.devices} device(s) evaluated`);
    // A real interval between the readings, so the rate is derived from a
    // realistic measurement window instead of a millisecond.
    if (index < CYCLES - 1) await sleep(1000);
  }

  heading("Devices");
  const devices = await listDevices();
  table(
    devices.map((device) => [
      device.name,
      device.category,
      device.healthState,
      device.simulated ? "yes" : "NO",
      device.mgmtIp ?? "—",
    ])
  );

  heading("Ports with a measured rate");
  const portRows: string[][] = [];
  for (const device of devices) {
    for (const port of await listPorts(device.id)) {
      if (port.inRateBps === null && port.outRateBps === null) continue;
      portRows.push([
        device.name,
        port.ifName,
        `${formatBps(port.inRateBps)} in`,
        `${formatBps(port.outRateBps)} out`,
      ]);
    }
  }
  table(portRows.slice(0, 12));
  if (portRows.length > 12) console.log(`  … and ${portRows.length - 12} more`);

  heading("Incidents");
  const open = await listIncidents({ state: "active" });
  table(
    open.length === 0
      ? []
      : open.map((incident) => [incident.severity, incident.title, incident.key])
  );

  heading("Event log");
  const recent = await listEvents({ limit: 5 });
  table(recent.map((event) => [event.type, event.severity, event.title]));

  heading("Next steps");
  console.log("  1. Start the console against this database:");
  console.log(`       MINEAZY_DB_PATH=${dbPath} MINEAZY_DEMO=1 npm run dev`);
  console.log("  2. Open http://localhost:3100 and sign in as admin.");
  console.log("  3. Open the Demo panel on the Overview page to inject a fault.");
  console.log(`  4. Run the end-to-end scenario: npm run demo:scenario`);
  console.log("");
  console.log(`  Collector mode is now "${await getSetting("collector.mode", "real")}".`);
  console.log("");
}

/** Format a bit rate for the summary table. */
function formatBps(bps: number | null): string {
  if (bps === null) return "—";
  if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(1)} Gbps`;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} kbps`;
  return `${Math.round(bps)} bps`;
}

/** Wait for a number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error("");
  console.error("The demo seed failed:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
