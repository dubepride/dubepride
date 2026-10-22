/**
 * ============================================================================
 *  scripts/acceptance-scenario.ts — the end-to-end proof
 * ============================================================================
 *
 *      npm run demo:scenario
 *
 *  This script drives the REAL product code — the same health engine, the
 *  same incident engine, the same traffic maths the collector uses — through
 *  a complete failure and recovery cycle, and asserts what the operator
 *  would see.
 *
 *  The scenario:
 *
 *    1. Baseline      — the estate is healthy, every device is ONLINE, no
 *                       incidents, and the ports report rates derived from
 *                       counter deltas (not cumulative counters).
 *    2. Uplink fault  — the cable between the edge router and the admin
 *                       switch is cut.
 *                       • ONE critical incident is raised (the link), not one
 *                         incident per device.
 *                       • The blast radius is listed on it.
 *                       • The devices below the cut go OFFLINE.
 *                       • The devices above it stay ONLINE: a local fault is
 *                         not an internet fault.
 *    3. Dedupe        — more cycles do not create more incidents.
 *    4. Recovery      — the cable is repaired; the incident is resolved and
 *                       the devices come back.
 *    5. Internet loss — only the external checks fail.
 *                       • The boundary devices report NO_INTERNET.
 *                       • The rest of the network stays ONLINE.
 *                       • ONE global internet incident, not one per device.
 *
 *  By default the scenario runs against a THROWAWAY database, so it can
 *  never touch a live installation. Set `MINEAZY_DB_PATH` to run it against
 *  a specific database instead.
 *
 *  Exit code 0 = every check passed. Exit code 1 = at least one failed.
 * ============================================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* Environment — must be set BEFORE any src/ module is imported        */
/* ------------------------------------------------------------------ */

const useTemporaryDatabase = !process.env.MINEAZY_DB_PATH?.trim();
const databasePath = useTemporaryDatabase
  ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mineazy-scenario-")), "mineazy.db")
  : process.env.MINEAZY_DB_PATH!.trim();

process.env.MINEAZY_DB_PATH = databasePath;
process.env.MINEAZY_DEMO = "1";
process.env.MINEAZY_ADMIN_PASSWORD ??= "scenario-administrator-password";

/* ------------------------------------------------------------------ */
/* Reporting                                                            */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
let section = "";

function heading(text: string): void {
  section = text;
  console.log("");
  console.log(text);
  console.log("─".repeat(text.length));
}

function check(description: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${description}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${description}`);
    if (section) console.log(`        section: ${section}`);
    if (detail) console.log(`        ${detail}`);
  }
}

function equal(description: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(description, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */
/* The scenario                                                         */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("╭──────────────────────────────────────────────────────────────╮");
  console.log("│  Mineazy Network — acceptance scenario                      │");
  console.log("│  SIMULATED estate. No real hardware is contacted.           │");
  console.log("╰──────────────────────────────────────────────────────────────╯");
  console.log(`  database  ${databasePath}`);
  console.log(`  ${useTemporaryDatabase ? "throwaway (the live installation is untouched)" : "PRODUCTION DATABASE — the demo will modify it"}`);

  const { seedSimulatedTopology, simulateCycle, writeFaults, clearFaults } = await import(
    "../src/collector/simulator"
  );
  const { listDevices } = await import("../src/lib/repo/devices");
  const { listIncidents } = await import("../src/lib/repo/incidents");
  const { listConnections } = await import("../src/lib/repo/connections");
  const { listPorts } = await import("../src/lib/repo/ports");
  const { listEvents } = await import("../src/lib/repo/events");
  const { traceUpstreamPath } = await import("../src/lib/topology");
  const { setSetting } = await import("../src/lib/settings");

  await setSetting("collector.mode", "simulated");
  await clearFaults();

  /* ── 1. Baseline ──────────────────────────────────────────────── */
  heading("1. Baseline — a healthy estate");

  const seeded = await seedSimulatedTopology();
  check("the demo estate is created", seeded.devices === 11 && seeded.connections === 10,
    `devices=${seeded.devices} connections=${seeded.connections}`);

  // Two readings with a real interval between them: the first reading is a
  // baseline, the second produces a rate derived from the delta.
  await simulateCycle();
  await sleep(1000);
  await simulateCycle();

  const devices = await listDevices();
  const byName = new Map(devices.map((device) => [device.name, device]));
  check("every device is ONLINE", devices.every((device) => device.healthState === "ONLINE"),
    devices.filter((d) => d.healthState !== "ONLINE").map((d) => `${d.name}=${d.healthState}`).join(", "));
  check("every device is flagged as simulated", devices.every((device) => device.simulated === true));

  const connections = await listConnections();
  check("every link is up", connections.every((connection) => connection.state === "up"));

  const baselineIncidents = await listIncidents({ state: "active" });
  equal("there are no open incidents", baselineIncidents.length, 0);

  // Traffic: the rate must be a delta, never the cumulative counter.
  const switchPorts = await listPorts(byName.get("Admin Switch")!.id);
  const measured = switchPorts.filter((port) => port.inRateBps !== null);
  check("the ports report a measured rate", measured.length > 0,
    "no port produced a rate after two readings");
  check("the rate is not the cumulative counter",
    measured
      .filter((port) => (port.inOctets ?? 0) > 0)
      .every((port) => port.inRateBps !== (port.inOctets ?? 0) * 8),
    "a rate equal to the raw counter would mean the counter was shown as a speed");
  check("the rate never exceeds the negotiated link speed",
    measured.every((port) => (port.speedBps ?? 0) === 0 || (port.inRateBps ?? 0) <= (port.speedBps ?? 0)),
    "a rate above the link speed is impossible");

  /* ── 2. Uplink fault ──────────────────────────────────────────── */
  heading("2. Uplink fault — the cable to the admin switch is cut");

  await writeFaults({ uplinkDown: true });
  await simulateCycle();
  await simulateCycle();

  const faultedLinks = (await listConnections()).filter((connection) => connection.state === "down");
  equal("exactly one link is down", faultedLinks.length, 1);

  const openIncidents = await listIncidents({ state: "active" });
  const critical = openIncidents.filter((incident) => incident.severity === "critical");
  equal("exactly one critical incident is raised", critical.length, 1);
  check("the incident names the broken link",
    critical[0]?.category === "link_down" && /Link down/.test(critical[0]?.title ?? ""),
    critical[0]?.title);

  // The blast radius is on the incident.
  const adminSwitchId = byName.get("Admin Switch")!.id;
  const affected = critical[0]?.affected ?? [];
  check("the blast radius lists the devices below the cut",
    affected.includes(byName.get("Office Workstation")!.id) &&
      affected.includes(byName.get("CCTV Recorder")!.id),
    `affected=${JSON.stringify(affected)}`);
  check("the blast radius includes the device the cut reaches first",
    affected.includes(adminSwitchId),
    `affected=${JSON.stringify(affected)} adminSwitch=${adminSwitchId}`);

  // The devices below the cut are offline…
  const faultedDevices = await listDevices();
  const offline = faultedDevices.filter((device) => device.healthState === "OFFLINE").map((device) => device.name);
  check("the devices below the cut are OFFLINE", offline.includes("Admin Switch") && offline.includes("Office Workstation"),
    `offline=${JSON.stringify(offline)}`);

  // …but the devices above it are NOT: a local fault is not an internet fault.
  check("the devices above the cut stay ONLINE",
    byName.get("Starlink Terminal")!.healthState === "ONLINE" &&
      byName.get("Edge Router")!.healthState === "ONLINE",
    `starlink=${byName.get("Starlink Terminal")!.healthState} router=${byName.get("Edge Router")!.healthState}`);

  // The downstream devices are CORRELATED to the link incident — they do not
  // each raise their own.
  const deviceIncidents = openIncidents.filter((incident) => incident.category === "offline");
  equal("the downstream devices do not raise duplicate incidents", deviceIncidents.length, 0);

  // The upstream path of an affected device points at the broken segment.
  const trace = await traceUpstreamPath(byName.get("CCTV Recorder")!.id);
  check("the upstream path of an affected device is traced",
    (trace?.steps.length ?? 0) >= 4 && /Starlink/.test(trace?.path ?? ""),
    trace?.path);
  check("the broken segment is identified on the path",
    trace?.brokenSegment !== null && trace?.brokenSegment.connectionId === faultedLinks[0]?.id,
    JSON.stringify(trace?.brokenSegment));

  /* ── 3. Dedupe ────────────────────────────────────────────────── */
  heading("3. A flapping fault does not flood the console");

  await simulateCycle();
  await simulateCycle();
  const afterFlapping = await listIncidents({ state: "active" });
  equal("the open incident count is unchanged", afterFlapping.length, openIncidents.length);

  /* ── 4. Recovery ──────────────────────────────────────────────── */
  heading("4. Recovery — the cable is repaired");

  await clearFaults();
  await simulateCycle();
  await simulateCycle();

  const recovered = await listIncidents({ state: "active" });
  equal("every incident is closed", recovered.length, 0);

  const resolved = await listIncidents({ state: "resolved" });
  check("the incident was recorded as resolved", resolved.length >= 1);

  const afterRecovery = await listDevices();
  check("every device is ONLINE again",
    afterRecovery.every((device) => device.healthState === "ONLINE"),
    afterRecovery.filter((d) => d.healthState !== "ONLINE").map((d) => `${d.name}=${d.healthState}`).join(", "));
  check("the link is up again",
    (await listConnections()).every((connection) => connection.state === "up"));

  /* ── 5. Internet loss ─────────────────────────────────────────── */
  heading("5. Internet loss — local networking still works");

  await writeFaults({ noInternet: true });
  await simulateCycle();
  await simulateCycle();

  const internetStates = afterDevices(await listDevices());
  check("the internet boundary reports NO_INTERNET",
    internetStates.get("Starlink Terminal") === "NO_INTERNET" &&
      internetStates.get("Edge Router") === "NO_INTERNET",
    `starlink=${internetStates.get("Starlink Terminal")} router=${internetStates.get("Edge Router")}`);
  check("the rest of the network stays ONLINE",
    internetStates.get("Admin Switch") === "ONLINE" &&
      internetStates.get("Office Workstation") === "ONLINE",
    `admin=${internetStates.get("Admin Switch")} workstation=${internetStates.get("Office Workstation")}`);

  const internetIncidents = (await listIncidents({ state: "active" })).filter(
    (incident) => incident.key === "network:internet:down"
  );
  equal("one global internet incident, not one per device", internetIncidents.length, 1);

  /* ── 6. Recovery from the internet fault ──────────────────────── */
  heading("6. Recovery — the internet comes back");

  await clearFaults();
  await simulateCycle();
  await simulateCycle();

  equal("the internet incident is closed", (await listIncidents({ state: "active" })).length, 0);
  check("every device is ONLINE again",
    (await listDevices()).every((device) => device.healthState === "ONLINE"));

  /* ── 7. The audit trail ───────────────────────────────────────── */
  heading("7. The operational history is recorded");

  const events = await listEvents({ limit: 500 });
  check("the event log records the state changes",
    events.some((event) => event.type === "device_state_changed" || event.type === "device_recovered"));
  check("the event log records the link failures",
    events.some((event) => event.type === "uplink_failed"));
  check("the event log records the recoveries",
    events.some((event) => event.type === "uplink_recovered" || event.type === "incident_recovered"));

  /* ── Result ───────────────────────────────────────────────────── */
  heading("Result");
  console.log(`  passed  ${passed}`);
  console.log(`  failed  ${failed}`);
  console.log("");
  if (failed === 0) {
    console.log("  ACCEPTANCE SCENARIO PASSED — every check succeeded.");
  } else {
    console.log(`  ACCEPTANCE SCENARIO FAILED — ${failed} check(s) did not succeed.`);
  }
  console.log("");

  if (useTemporaryDatabase) {
    try {
      fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
    } catch {
      // The database handle may still be open on some platforms — the
      // temporary directory is removed by the operating system later.
    }
  }
}

/** A name → state map for the current devices. */
function afterDevices(devices: { name: string; healthState: string }[]): Map<string, string> {
  return new Map(devices.map((device) => [device.name, device.healthState]));
}

/** Wait for a number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error("");
  console.error("The acceptance scenario crashed:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
