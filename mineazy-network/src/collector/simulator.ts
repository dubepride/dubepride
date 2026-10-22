/**
 * ============================================================================
 *  collector/simulator.ts — the labelled demo estate
 * ============================================================================
 *
 *  The simulator exists so that the console can be demonstrated, developed
 *  and tested without any hardware at all. It is HONEST about what it is:
 *
 *    • Every device it creates is flagged `Simulated = 1`.
 *    • Every connection it creates has `Source = 'simulated'`.
 *    • The map, the device list and the overview all show a "SIMULATED"
 *      banner while it is active.
 *    • The simulated data is never presented as a measurement of real
 *      hardware.
 *
 *  The simulator runs through the SAME health evaluation and the SAME
 *  incident engine as the real collector, so what you see in demo mode is
 *  what the product does with real evidence.
 * ============================================================================
 */

import { evaluateDeviceHealth, severityForState } from "../lib/health";
import { syncConnectionIncident, syncDeviceIncident } from "../lib/incidents";
import { recordEvent } from "../lib/repo/events";
import { listDevices, setDeviceHealth, touchDevice, upsertDiscoveredDevice } from "../lib/repo/devices";
import { listPorts, upsertPort } from "../lib/repo/ports";
import { connectionsForDevice, setConnectionState, upsertConnection } from "../lib/repo/connections";
import { recordObservation } from "../lib/repo/observations";
import { getJsonSetting, setSetting } from "../lib/settings";
import { createLocation, createSite, listLocations, listSites } from "../lib/repo/sites";
import { buildTopologyGraph } from "../lib/topology";
import type { DeviceCategory, HealthState } from "../lib/types";
import { updatePortTraffic, writeCollectorHeartbeat } from "./worker";

/* ------------------------------------------------------------------ */
/* Fault injection                                                     */
/* ------------------------------------------------------------------ */

/** The faults the demo can inject. */
export interface DemoFaults {
  /** The uplink between the edge router and the admin switch is down. */
  uplinkDown: boolean;
  /** The link between the admin switch and the white house switch is down. */
  whiteHouseDown: boolean;
  /** Names of devices that stop answering. */
  deviceOffline: string[];
  /** The external connectivity checks fail (local network still fine). */
  noInternet: boolean;
  /** Every simulated port stops showing traffic. */
  noTraffic: boolean;
}

export const DEFAULT_FAULTS: DemoFaults = {
  uplinkDown: false,
  whiteHouseDown: false,
  deviceOffline: [],
  noInternet: false,
  noTraffic: false,
};

const FAULTS_KEY = "demo.faults";

/** Read the current fault configuration. */
export async function readFaults(): Promise<DemoFaults> {
  const stored = await getJsonSetting<Partial<DemoFaults>>(FAULTS_KEY, {});
  return { ...DEFAULT_FAULTS, ...stored };
}

/** Write the fault configuration. */
export async function writeFaults(faults: Partial<DemoFaults>): Promise<DemoFaults> {
  const next = { ...(await readFaults()), ...faults };
  await setSetting(FAULTS_KEY, JSON.stringify(next));
  return next;
}

/** Clear every injected fault. */
export async function clearFaults(): Promise<DemoFaults> {
  await setSetting(FAULTS_KEY, JSON.stringify(DEFAULT_FAULTS));
  return { ...DEFAULT_FAULTS };
}

/* ------------------------------------------------------------------ */
/* Seeding                                                             */
/* ------------------------------------------------------------------ */

/** One device of the demo estate. */
interface SeedDevice {
  name: string;
  hostname: string;
  category: DeviceCategory;
  ip: string;
  mac: string;
  model: string;
  manufacturer: string;
  location: string;
  /** Interface names of the device. */
  ports: string[];
  /** Ports that carry traffic (the rest are spare). */
  activePorts: number;
  criticality?: "critical" | "important" | "standard";
}

const SEED_DEVICES: SeedDevice[] = [
  {
    name: "Starlink Terminal",
    hostname: "starlink-pop",
    category: "internet",
    ip: "10.10.0.1",
    mac: "00:1B:21:00:00:01",
    model: "Starlink Gen3",
    manufacturer: "SpaceX",
    location: "Admin Block",
    ports: ["eth0", "eth1"],
    activePorts: 2,
    criticality: "critical",
  },
  {
    name: "Edge Router",
    hostname: "edge-router",
    category: "router",
    ip: "10.10.0.2",
    mac: "24:4B:FE:00:00:02",
    model: "UDM Pro",
    manufacturer: "Ubiquiti Networks",
    location: "Admin Block",
    ports: ["wan0", "lan0", "lan1", "lan2"],
    activePorts: 2,
    criticality: "critical",
  },
  {
    name: "Admin Switch",
    hostname: "admin-switch",
    category: "switch",
    ip: "10.10.0.3",
    mac: "24:4B:FE:00:00:03",
    model: "USW-24-PoE",
    manufacturer: "Ubiquiti Networks",
    location: "Admin Block",
    ports: [
      "GigabitEthernet1/0/1",
      "GigabitEthernet1/0/2",
      "GigabitEthernet1/0/3",
      "GigabitEthernet1/0/4",
      "GigabitEthernet1/0/5",
      "GigabitEthernet1/0/6",
    ],
    activePorts: 4,
    criticality: "critical",
  },
  {
    name: "White House Switch",
    hostname: "whitehouse-switch",
    category: "switch",
    ip: "10.10.1.3",
    mac: "24:4B:FE:00:00:04",
    model: "USW-8-PoE",
    manufacturer: "Ubiquiti Networks",
    location: "White House",
    ports: [
      "GigabitEthernet1/0/1",
      "GigabitEthernet1/0/2",
      "GigabitEthernet1/0/3",
      "GigabitEthernet1/0/4",
    ],
    activePorts: 2,
    criticality: "important",
  },
  {
    name: "Workshop Switch",
    hostname: "workshop-switch",
    category: "switch",
    ip: "10.10.2.3",
    mac: "24:4B:FE:00:00:05",
    model: "USW-8-PoE",
    manufacturer: "Ubiquiti Networks",
    location: "Workshop",
    ports: [
      "GigabitEthernet1/0/1",
      "GigabitEthernet1/0/2",
      "GigabitEthernet1/0/3",
      "GigabitEthernet1/0/4",
    ],
    activePorts: 2,
    criticality: "important",
  },
  {
    name: "Office Workstation",
    hostname: "workstation-01",
    category: "desktop",
    ip: "10.10.0.51",
    mac: "A4:CF:12:00:00:51",
    model: "OptiPlex 7010",
    manufacturer: "Dell",
    location: "Admin Block",
    ports: ["eth0"],
    activePorts: 1,
  },
  {
    name: "Reception Printer",
    hostname: "printer-reception",
    category: "printer",
    ip: "10.10.0.52",
    mac: "00:1B:21:00:00:52",
    model: "LaserJet M428",
    manufacturer: "Hewlett Packard",
    location: "Admin Block",
    ports: ["eth0"],
    activePorts: 1,
  },
  {
    name: "Archive NAS",
    hostname: "archive-nas",
    category: "nas",
    ip: "10.10.0.53",
    mac: "00:11:32:00:00:53",
    model: "DS923+",
    manufacturer: "Synology",
    location: "Admin Block",
    ports: ["eth0", "eth1"],
    activePorts: 2,
    criticality: "important",
  },
  {
    name: "CCTV Recorder",
    hostname: "cctv-nvr",
    category: "nvr",
    ip: "10.10.1.53",
    mac: "00:11:32:00:01:53",
    model: "DS-7732NI",
    manufacturer: "Hikvision",
    location: "White House",
    ports: ["eth0"],
    activePorts: 1,
  },
  {
    name: "Workshop Laptop",
    hostname: "laptop-workshop",
    category: "laptop",
    ip: "10.10.2.51",
    mac: "3C:22:FB:00:02:51",
    model: "Latitude 5450",
    manufacturer: "Dell",
    location: "Workshop",
    ports: ["eth0", "wifi0"],
    activePorts: 1,
  },
  {
    name: "Yard Camera",
    hostname: "camera-yard",
    category: "camera",
    ip: "10.10.2.52",
    mac: "44:19:B6:00:02:52",
    model: "IPC-5442",
    manufacturer: "Dahua",
    location: "Workshop",
    ports: ["eth0"],
    activePorts: 1,
  },
];

/** One link of the demo estate. */
interface SeedConnection {
  local: string;
  localPort: string;
  remote: string;
  remotePort: string;
  type: "wan" | "uplink" | "access";
  cableId: string;
}

const SEED_CONNECTIONS: SeedConnection[] = [
  { local: "Starlink Terminal", localPort: "eth0", remote: "Edge Router", remotePort: "wan0", type: "wan", cableId: "CBL-0001" },
  { local: "Edge Router", localPort: "lan0", remote: "Admin Switch", remotePort: "GigabitEthernet1/0/1", type: "uplink", cableId: "CBL-0002" },
  { local: "Admin Switch", localPort: "GigabitEthernet1/0/2", remote: "White House Switch", remotePort: "GigabitEthernet1/0/1", type: "uplink", cableId: "CBL-0003" },
  { local: "Admin Switch", localPort: "GigabitEthernet1/0/3", remote: "Workshop Switch", remotePort: "GigabitEthernet1/0/1", type: "uplink", cableId: "CBL-0004" },
  { local: "Admin Switch", localPort: "GigabitEthernet1/0/4", remote: "Office Workstation", remotePort: "eth0", type: "access", cableId: "CBL-0005" },
  { local: "Admin Switch", localPort: "GigabitEthernet1/0/5", remote: "Reception Printer", remotePort: "eth0", type: "access", cableId: "CBL-0006" },
  { local: "Admin Switch", localPort: "GigabitEthernet1/0/6", remote: "Archive NAS", remotePort: "eth0", type: "access", cableId: "CBL-0007" },
  { local: "White House Switch", localPort: "GigabitEthernet1/0/2", remote: "CCTV Recorder", remotePort: "eth0", type: "access", cableId: "CBL-0008" },
  { local: "Workshop Switch", localPort: "GigabitEthernet1/0/2", remote: "Workshop Laptop", remotePort: "eth0", type: "access", cableId: "CBL-0009" },
  { local: "Workshop Switch", localPort: "GigabitEthernet1/0/3", remote: "Yard Camera", remotePort: "eth0", type: "access", cableId: "CBL-0010" },
];

/**
 * Create the demo estate.
 *
 * Idempotent: running it twice does not duplicate the devices.
 */
export async function seedSimulatedTopology(): Promise<{ devices: number; connections: number }> {
  // Site + locations.
  const sites = await listSites();
  let siteId = sites.find((site) => site.name === "Mineazy Demo Estate")?.id;
  if (siteId === undefined) {
    siteId = await createSite("Mineazy Demo Estate", "Simulated estate used for demonstrations and tests.");
  }

  const locations = await listLocations();
  const locationIds = new Map<string, number>();
  for (const name of ["Admin Block", "White House", "Workshop"]) {
    const existing = locations.find((location) => location.name === name);
    locationIds.set(
      name,
      existing ? existing.id : await createLocation({ name, siteId, building: name === "Admin Block" ? "Main House" : "Outbuilding" })
    );
  }

  // Devices.
  const deviceIds = new Map<string, number>();
  const existingDevices = await listDevices();

  for (const seed of SEED_DEVICES) {
    const existing = existingDevices.find((device) => device.name === seed.name);
    if (existing) {
      deviceIds.set(seed.name, existing.id);
      continue;
    }
    const { id } = await upsertDiscoveredDevice({
      ip: seed.ip,
      mac: seed.mac,
      hostname: seed.hostname,
      displayName: seed.name,
      category: seed.category,
      manufacturer: seed.manufacturer,
      model: seed.model,
      source: "simulated",
      confidence: "confirmed",
      simulated: true,
    });
    deviceIds.set(seed.name, id);
  }

  // Ports.
  for (const seed of SEED_DEVICES) {
    const deviceId = deviceIds.get(seed.name)!;
    for (let index = 0; index < seed.ports.length; index += 1) {
      const ifName = seed.ports[index];
      await upsertPort(deviceId, {
        ifIndex: index + 1,
        ifName,
        portNumber: index + 1,
        description: `${seed.name} ${ifName}`,
        adminState: "up",
        operState: "up",
        speedBps: 1_000_000_000,
        duplex: "full",
        vlan: 10,
        lastStateChange: Date.now(),
        inOctets: 0,
        outOctets: 0,
        inPackets: 0,
        outPackets: 0,
        inErrors: 0,
        outErrors: 0,
        inDiscards: 0,
        outDiscards: 0,
        source: "simulated",
        managed: true,
      });
    }
  }

  // Connections.
  let connectionCount = 0;
  for (const seed of SEED_CONNECTIONS) {
    const localId = deviceIds.get(seed.local)!;
    const remoteId = deviceIds.get(seed.remote)!;
    const localPort = (await listPorts(localId)).find((port) => port.ifName === seed.localPort) ?? null;
    const remotePort = (await listPorts(remoteId)).find((port) => port.ifName === seed.remotePort) ?? null;

    const existing = (await connectionsForDevice(localId)).find(
      (connection) =>
        (connection.localDeviceId === localId && connection.remoteDeviceId === remoteId) ||
        (connection.localDeviceId === remoteId && connection.remoteDeviceId === localId)
    );

    await upsertConnection({
      localDeviceId: localId,
      localPortId: localPort?.id ?? null,
      remoteDeviceId: remoteId,
      remotePortId: remotePort?.id ?? null,
      type: seed.type,
      source: "simulated",
      confidence: 1,
      state: "unknown",
      evidence: "Simulated demo link (not a measurement of real hardware).",
    });
    if (!existing) connectionCount += 1;
  }

  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: "Simulated demo estate seeded",
    detail:
      "The labelled simulated topology was created. These devices are DEMO data — no real hardware was contacted.",
    subjectType: "system",
    subjectId: null,
    source: "simulator",
  });

  return { devices: deviceIds.size, connections: connectionCount };
}

/* ------------------------------------------------------------------ */
/* The simulated cycle                                                 */
/* ------------------------------------------------------------------ */

/** A deterministic pseudo-random number in [0, 1). */
function noise(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/**
 * Advance the simulated estate by one tick.
 *
 * Counters increase, the injected faults take effect, health is evaluated
 * with the production rules and the incident engine raises and clears
 * incidents exactly as it does for real devices.
 */
export async function simulateCycle(): Promise<{ devices: number; states: Record<string, HealthState> }> {
  const faults = await readFaults();
  const now = Date.now();
  const devices = (await listDevices()).filter((device) => device.simulated);
  const states: Record<string, HealthState> = {};

  // ── Links ──────────────────────────────────────────────────────────
  //
  // The demo reproduces the real collector's behaviour exactly: the link
  // state is written first, then the SAME link incident is raised, so the
  // notification centre shows one root cause with a blast radius instead of
  // a flood of duplicates.
  const linkUpdates: {
    connectionId: number;
    state: "up" | "down";
    evidence: string;
    localDeviceId: number;
    remoteDeviceId: number;
    localPortName: string | null;
    remotePortName: string | null;
  }[] = [];

  const seenLinks = new Set<number>();

  for (const device of devices) {
    const connections = await connectionsForDevice(device.id);
    for (const connection of connections) {
      if (seenLinks.has(connection.id)) continue;
      seenLinks.add(connection.id);

      const other = devices.find(
        (candidate) =>
          candidate.id !== device.id &&
          ((connection.localDeviceId === device.id && candidate.id === connection.remoteDeviceId) ||
            (connection.remoteDeviceId === device.id && candidate.id === connection.localDeviceId))
      );
      if (!other) continue;

      const involvesUplink =
        (connection.type === "uplink" && other.name === "Edge Router" && device.name === "Admin Switch") ||
        (connection.type === "uplink" && other.name === "Admin Switch" && device.name === "Edge Router");
      const involvesWhiteHouse =
        connection.type === "uplink" &&
        ((other.name === "White House Switch" && device.name === "Admin Switch") ||
          (other.name === "Admin Switch" && device.name === "White House Switch"));

      const down = involvesUplink ? faults.uplinkDown : involvesWhiteHouse ? faults.whiteHouseDown : false;

      if (connection.state !== (down ? "down" : "up")) {
        await setConnectionState(
          connection.id,
          down ? "down" : "up",
          down
            ? "SIMULATED fault: the demo injected a link failure on this connection."
            : "SIMULATED: the link is up."
        );
        await recordEvent({
          type: down ? "uplink_failed" : "uplink_recovered",
          severity: down ? "critical" : "info",
          title: down ? "Link down (simulated)" : "Link recovered (simulated)",
          detail: `SIMULATED link ${connection.localDeviceId} ↔ ${connection.remoteDeviceId}.`,
          subjectType: "connection",
          subjectId: connection.id,
          source: "simulator",
        });
      }

      const localPort = (await listPorts(connection.localDeviceId)).find(
        (port) => port.id === connection.localPortId
      );
      const remotePort = (await listPorts(connection.remoteDeviceId)).find(
        (port) => port.id === connection.remotePortId
      );

      linkUpdates.push({
        connectionId: connection.id,
        state: down ? "down" : "up",
        evidence: down
          ? "SIMULATED fault: the demo injected a link failure on this connection."
          : "SIMULATED: the link is up.",
        localDeviceId: connection.localDeviceId,
        remoteDeviceId: connection.remoteDeviceId,
        localPortName: localPort?.ifName ?? null,
        remotePortName: remotePort?.ifName ?? null,
      });
    }
  }

  // Upstream links first, so the root cause of a cascade exists before the
  // symptom links are processed.
  const graph = await buildTopologyGraph();
  const depthOf = (deviceId: number): number => graph.devices.get(deviceId)?.depth ?? 0;
  linkUpdates.sort(
    (a, b) =>
      Math.min(depthOf(a.localDeviceId), depthOf(a.remoteDeviceId)) -
      Math.min(depthOf(b.localDeviceId), depthOf(b.remoteDeviceId))
  );

  for (const link of linkUpdates) {
    await syncConnectionIncident({
      connectionId: link.connectionId,
      state: link.state,
      evidence: link.evidence,
      localDeviceId: link.localDeviceId,
      remoteDeviceId: link.remoteDeviceId,
      localPortName: link.localPortName,
      remotePortName: link.remotePortName,
    });
  }

  // ── Devices ────────────────────────────────────────────────────────
  for (const device of devices) {
    const offline = faults.deviceOffline.some((name) => name.toLowerCase() === device.name.toLowerCase());

    // A device that sits behind a downed link is unreachable, exactly like
    // the real world: the cable is out, so nothing below it answers.
    const downstreamOfFailure = isDownstreamOfFailure(device, devices, faults);

    const reachable = !offline && !downstreamOfFailure;

    // Counters. The bytes added per cycle are proportional to the time
    // that actually elapsed, so the rate the console shows is the same
    // whether the demo runs a cycle every 30 seconds or every second.
    const ports = await listPorts(device.id);
    const tick = Math.floor(now / 5000);
    for (const port of ports) {
      const active = ports.indexOf(port) < 4;
      const base = (device.id * 31 + port.id * 17 + tick) % 1000;
      // The simulated byte rate: 1 MB/s … 181 MB/s, i.e. an in-rate of
      // roughly 5 … 870 Mbps on a 1 Gbps link — 60% in, 40% out.
      const bytesPerSecond = faults.noTraffic || !active ? 0 : 1_000_000 + base * 180_000;
      const elapsedSeconds = Math.max(
        0.001,
        port.lastPolledAt !== null ? (now - port.lastPolledAt) / 1000 : 1
      );
      const inOctets = (port.inOctets ?? 0) + Math.round(bytesPerSecond * elapsedSeconds * 0.6);
      const outOctets = (port.outOctets ?? 0) + Math.round(bytesPerSecond * elapsedSeconds * 0.4);
      const inPackets = (port.inPackets ?? 0) + Math.round((bytesPerSecond * elapsedSeconds * 0.6) / 1200);
      const outPackets = (port.outPackets ?? 0) + Math.round((bytesPerSecond * elapsedSeconds * 0.4) / 1200);

      await upsertPort(device.id, {
        ifIndex: port.ifIndex,
        ifName: port.ifName,
        portNumber: port.portNumber,
        description: port.description,
        adminState: "up",
        operState: reachable ? "up" : "down",
        speedBps: port.speedBps,
        duplex: port.duplex,
        vlan: port.vlan,
        lastStateChange: port.lastStateChange,
        inOctets,
        outOctets,
        inPackets,
        outPackets,
        inErrors: 0,
        outErrors: 0,
        inDiscards: 0,
        outDiscards: 0,
        source: "simulated",
        managed: true,
      });
    }

    // Real counter deltas → real rates (the same maths as real hardware).
    const refreshed = await listPorts(device.id);
    await updatePortTraffic(device.id, ports, refreshed, now);

    // Observation.
    await recordObservation({
      deviceId: device.id,
      portId: null,
      observedAt: now,
      probeType: "icmp",
      probeTarget: device.mgmtIp,
      result: reachable ? "success" : "failure",
      latencyMs: reachable ? Math.round(noise(device.id + tick) * 12 + 1) : null,
      reason: reachable
        ? "SIMULATED: the device answered the probe."
        : "SIMULATED: the device did not answer the probe.",
      source: "simulator",
    });

    // Health — identical rules to the real collector.
    const isBoundary = device.category === "internet" || device.category === "router" || device.category === "gateway";
    const internetUp = isBoundary ? !faults.noInternet : null;

    const verdict = evaluateDeviceHealth({
      monitoringEnabled: device.monitoringEnabled,
      category: device.category,
      consecutiveFailures: reachable ? 0 : device.failureThreshold,
      consecutiveSuccesses: reachable ? 1 : 0,
      lastSuccessAt: device.lastSeenAt,
      lastObservedAt: now,
      failureThreshold: device.failureThreshold || 3,
      staleAfterSeconds: 3600,
      pollIntervalSeconds: device.pollIntervalSeconds,
      now,
      managementLinkDown: null,
      downInterfaces: [],
      internetUp,
      hasTrafficCounters: true,
      noTrafficSeconds: faults.noTraffic ? 900 : null,
      probeEvidence: ["SIMULATED observation — this is demo data, not a measurement of real hardware."],
    });

    states[device.name] = verdict.state;

    if (device.healthState !== verdict.state) {
      await recordEvent({
        type: verdict.state === "ONLINE" ? "device_recovered" : "device_state_changed",
        severity: severityForState(verdict.state),
        title: `${device.name} → ${verdict.state} (simulated)`,
        detail: verdict.reason,
        subjectType: "device",
        subjectId: device.id,
        source: "simulator",
      });
    }

    await setDeviceHealth(device.id, verdict.state, verdict.reason);
    await touchDevice(device.id, { seen: reachable, observedAt: now });

    await syncDeviceIncident({
      device,
      state: verdict.state,
      reason: verdict.reason,
      evidence: "SIMULATED evidence produced by the demo simulator.",
      severity: severityForState(verdict.state),
      faultLocation: "Simulated demo fault (not a real network fault).",
      confidence: 1,
    });
  }

  // The rates were stored by `updatePortTraffic` together with the counters
  // they were derived from — nothing else to sync here.

  // The heartbeat. The console shows "the collector has not reported yet" when
  // it is missing, so the simulator has to write it too — otherwise a
  // perfectly healthy demo estate looks unconfirmed.
  await writeCollectorHeartbeat(
    `${devices.length} simulated device(s) advanced (demo data, no hardware polled).`
  );

  return { devices: devices.length, states };
}

/**
 * True when the device sits below a link that the demo has taken down.
 */
function isDownstreamOfFailure(
  device: { id: number; name: string },
  devices: { id: number; name: string }[],
  faults: DemoFaults
): boolean {
  if (!faults.uplinkDown && !faults.whiteHouseDown) return false;

  const adminSwitch = devices.find((candidate) => candidate.name === "Admin Switch");
  if (!adminSwitch) return false;

  // Which switch is the device attached to?
  const parent = findParentSwitch(device, devices);
  if (!parent) return false;

  if (parent.name === "Edge Router") {
    // Everything below the router is cut off when the uplink fails.
    return faults.uplinkDown;
  }
  if (parent.name === "Admin Switch") {
    return faults.uplinkDown;
  }
  if (parent.name === "White House Switch") {
    return faults.uplinkDown || faults.whiteHouseDown;
  }
  if (parent.name === "Workshop Switch") {
    return faults.uplinkDown;
  }
  void adminSwitch;
  return false;
}

/** The switch (or router) a device hangs off, by name. */
function findParentSwitch(
  device: { id: number; name: string },
  devices: { id: number; name: string }[]
): { id: number; name: string } | null {
  const mapping: Record<string, string> = {
    "Office Workstation": "Admin Switch",
    "Reception Printer": "Admin Switch",
    "Archive NAS": "Admin Switch",
    "CCTV Recorder": "White House Switch",
    "Workshop Laptop": "Workshop Switch",
    "Yard Camera": "Workshop Switch",
    "Admin Switch": "Edge Router",
    "White House Switch": "Admin Switch",
    "Workshop Switch": "Admin Switch",
    "Edge Router": "Starlink Terminal",
  };
  const parentName = mapping[device.name];
  if (!parentName) return null;
  return devices.find((candidate) => candidate.name === parentName) ?? null;
}
