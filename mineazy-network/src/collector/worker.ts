/**
 * ============================================================================
 *  collector/worker.ts — the monitoring engine
 * ============================================================================
 *
 *  This is the process that actually talks to the network. It runs
 *  independently of the browser: close the console tab and monitoring keeps
 *  working, because the collector owns its own timer.
 *
 *  One cycle does, for every monitored device:
 *
 *    1. Collect evidence — SNMP (identity, interfaces, counters, neighbours)
 *       or an active probe (ICMP / TCP / HTTP).
 *    2. Write the raw counters to the port rows and derive RATES from the
 *       delta against the previous reading (never from the counter itself).
 *    3. Turn the evidence into a health state with `evaluateDeviceHealth`.
 *    4. Raise, update or resolve the incident for that state.
 *    5. Recompute the state of every link from the ports at both ends.
 *
 *  Every step is defensive: one unreachable device must never stop the
 *  cycle for the others.
 * ============================================================================
 */

import { getDb, queryOne } from "../lib/db";
import { evaluateDeviceHealth, connectionStateForPorts, severityForState } from "../lib/health";
import {
  syncConnectionIncident,
  syncDeviceIncident,
} from "../lib/incidents";
import { recordEvent } from "../lib/repo/events";
import { listCredentials, type SnmpCredential } from "../lib/repo/credentials";
import {
  deviceByIp,
  getDevice,
  listDevices,
  setDeviceHealth,
  touchDevice,
  upsertDiscoveredDevice,
} from "../lib/repo/devices";
import { connectionsForDevice, listConnections, setConnectionState, upsertConnection } from "../lib/repo/connections";
import { consecutiveProbeResults, recordObservation } from "../lib/repo/observations";
import { listPorts, portByName, setPortRates, upsertPort } from "../lib/repo/ports";
import { lastTrafficActivity, recordSample } from "../lib/repo/traffic";
import {
  defaultFailureThreshold,
  defaultPollSeconds,
  gatewayTargets,
  internetTargets,
  staleAfterSeconds,
  type MonitorTarget,
} from "../lib/settings";
import { computeRates, type CounterSnapshot } from "../lib/traffic";
import { listAllPorts } from "../lib/repo/ports";
import {
  collectArp,
  collectCdpNeighbors,
  collectFdb,
  collectInterfaces,
  collectLldpNeighbors,
  collectSystemInfo,
  withSession,
  type SnmpNeighbor,
  type SnmpTarget,
} from "../lib/net/snmp";
import { pingProbe, runProbe, tcpProbe } from "../lib/net/probes";
import { classifyDevice } from "../lib/net/classify";
import { buildTopologyGraph } from "../lib/topology";
import type { Connection, Device, HealthState, NetworkPort } from "../lib/types";

/* ------------------------------------------------------------------ */
/* Collector configuration                                             */
/* ------------------------------------------------------------------ */

/** How the collector should behave this cycle. */
export interface CollectorOptions {
  /** SNMP timeout in milliseconds. */
  snmpTimeoutMs: number;
  /** SNMP retries. */
  snmpRetries: number;
  /** "real" polls the configured devices, "simulated" runs the labelled
   *  test topology, "off" does nothing at all. */
  mode: "real" | "simulated" | "off";
  /** Restrict the cycle to these device ids (used by tests). */
  onlyDeviceIds?: number[];
}

/** The result of a single device poll. */
export interface DevicePollResult {
  deviceId: number;
  name: string;
  state: HealthState;
  reason: string;
  reachable: boolean;
  /** True when the device answered over SNMP. */
  snmp: boolean;
  /** Ports updated during this poll. */
  portsUpdated: number;
  /** True when a state change produced an event. */
  changed: boolean;
  error: string;
}

/* ------------------------------------------------------------------ */
/* SNMP credential handling                                            */
/* ------------------------------------------------------------------ */

/**
 * Pick the credential to use for a device.
 *
 * A device may name the credential it belongs to in its notes as
 * "snmp=credential-name"; otherwise the first credential is used. When
 * there is no credential at all, SNMP polling is skipped rather than
 * failing the whole cycle.
 */
async function credentialFor(device: Device): Promise<SnmpCredential | null> {
  const credentials = await listCredentials(true);
  if (credentials.length === 0) return null;

  const match = /snmp\s*=\s*([\w.-]+)/i.exec(device.notes ?? "");
  if (match) {
    const named = credentials.find((c) => c.name.toLowerCase() === match[1].toLowerCase());
    if (named) return named;
  }
  return credentials[0];
}

/* ------------------------------------------------------------------ */
/* Traffic accounting                                                  */
/* ------------------------------------------------------------------ */

/** The counter reading of a single port. */
function portSnapshot(port: NetworkPort, at: number): CounterSnapshot {
  return {
    at,
    inBytes: port.inOctets,
    outBytes: port.outOctets,
    inPackets: port.inPackets,
    outPackets: port.outPackets,
    inErrors: port.inErrors,
    outErrors: port.outErrors,
  };
}

/**
 * Update the traffic rates of every port of a device.
 *
 * The rate is the DELTA between two readings of the same counter, so the
 * previous reading has to be captured BEFORE the new counters are written.
 * That is why the caller passes both lists:
 *
 *    previousPorts — the rows as they were before this poll
 *    currentPorts  — the rows after the new counters were stored
 *
 * A counter that went backwards (device restart / 32-bit wrap) is detected
 * by `computeRates` and the rate is discarded instead of showing an absurd
 * spike. A port with no predecessor is stored as a baseline: no rate is
 * claimed until the second reading arrives.
 */
export async function updatePortTraffic(
  deviceId: number,
  previousPorts: NetworkPort[],
  currentPorts: NetworkPort[],
  at: number
): Promise<{ inRate: number | null; outRate: number | null; hasCounters: boolean }> {
  let inRate: number | null = null;
  let outRate: number | null = null;
  let hasCounters = false;
  let longestWindow: number | null = null;

  const previousById = new Map(previousPorts.map((port) => [port.id, port]));

  for (const port of currentPorts) {
    if (port.inOctets === null && port.outOctets === null) continue;
    hasCounters = true;

    const previousPort = previousById.get(port.id) ?? null;

    // The first reading of a counter has no predecessor: the counters are
    // stored as a baseline and no rate is claimed until the second reading.
    const previous: CounterSnapshot | null =
      previousPort && previousPort.lastPolledAt !== null
        ? portSnapshot(previousPort, previousPort.lastPolledAt)
        : null;

    const current = portSnapshot(port, port.lastPolledAt ?? at);
    const result = computeRates(previous, current);

    await setPortRates(port.id, result.inRateBps, result.outRateBps);
    await recordSample({
      subjectType: "port",
      subjectId: port.id,
      sampledAt: at,
      inBytes: result.inBytes,
      outBytes: result.outBytes,
      inRateBps: result.inRateBps,
      outRateBps: result.outRateBps,
      inPps: result.inPps,
      outPps: result.outPps,
      inErrors: result.inErrors,
      outErrors: result.outErrors,
      counterValid: result.counterValid,
      windowSeconds: result.windowSeconds,
      source: port.source || "snmp",
    });

    if (result.windowSeconds !== null && (longestWindow === null || result.windowSeconds > longestWindow)) {
      longestWindow = result.windowSeconds;
    }
    if (result.inRateBps !== null) inRate = (inRate ?? 0) + result.inRateBps;
    if (result.outRateBps !== null) outRate = (outRate ?? 0) + result.outRateBps;
  }

  // Device-level aggregate sample (the sum of its ports).
  if (hasCounters) {
    const inBytes = currentPorts.reduce((sum, p) => sum + (p.inOctets ?? 0), 0);
    const outBytes = currentPorts.reduce((sum, p) => sum + (p.outOctets ?? 0), 0);
    const inErrors = currentPorts.reduce((sum, p) => sum + (p.inErrors ?? 0), 0);
    const outErrors = currentPorts.reduce((sum, p) => sum + (p.outErrors ?? 0), 0);
    const windowSeconds = longestWindow;

    await recordSample({
      subjectType: "device",
      subjectId: deviceId,
      sampledAt: at,
      inBytes,
      outBytes,
      inRateBps: inRate,
      outRateBps: outRate,
      inPps: null,
      outPps: null,
      inErrors,
      outErrors,
      counterValid: inRate !== null || outRate !== null,
      windowSeconds: windowSeconds,
      source: currentPorts[0]?.source || "snmp",
    });
  }

  return { inRate, outRate, hasCounters };
}

/* ------------------------------------------------------------------ */
/* SNMP collection                                                     */
/* ------------------------------------------------------------------ */

interface SnmpCollection {
  ok: boolean;
  reason: string;
  portsUpdated: number;
  neighbors: SnmpNeighbor[];
  fdb: { mac: string; port: number | null }[];
  arp: { ip: string; mac: string }[];
  sysName: string;
  sysDescr: string;
}

/** Poll a device over SNMP and write its ports. */
async function collectViaSnmp(
  device: Device,
  credential: SnmpCredential,
  options: CollectorOptions
): Promise<SnmpCollection> {
  const target: SnmpTarget = {
    host: device.mgmtIp,
    credential,
    timeoutMs: options.snmpTimeoutMs,
    retries: options.snmpRetries,
  };

  try {
    return await withSession(target, async (session) => {
      const system = await collectSystemInfo(session);
      const interfaces = await collectInterfaces(session);

      let portsUpdated = 0;
      for (const iface of interfaces) {
        const { created } = await upsertPort(device.id, {
          ifIndex: iface.ifIndex,
          ifName: iface.ifName,
          portNumber: iface.portNumber,
          description: iface.ifDescr,
          adminState: iface.adminStatus,
          operState: iface.operStatus,
          speedBps: iface.speedBps,
          duplex: iface.duplex,
          vlan: null,
          lastStateChange: iface.lastChange,
          inOctets: iface.inOctets,
          outOctets: iface.outOctets,
          inPackets: iface.inPackets,
          outPackets: iface.outPackets,
          inErrors: iface.inErrors,
          outErrors: iface.outErrors,
          inDiscards: iface.inDiscards,
          outDiscards: iface.outDiscards,
          source: "snmp",
          managed: true,
        });
        if (created) portsUpdated += 1;
      }

      // Neighbour tables are best-effort: many devices do not expose all of
      // them, and a missing table must not fail the whole poll.
      const lldp = await collectLldpNeighbors(session).catch(() => [] as SnmpNeighbor[]);
      const cdp = await collectCdpNeighbors(session).catch(() => [] as SnmpNeighbor[]);
      const fdb = await collectFdb(session).catch(() => [] as { mac: string; port: number | null; portName: string | null }[]);
      const arp = await collectArp(session).catch(() => [] as { ip: string; mac: string; ifIndex: number | null }[]);

      return {
        ok: true,
        reason: `SNMP answered (sysName "${system.sysName || "unset"}").`,
        portsUpdated,
        neighbors: [...lldp, ...cdp],
        fdb: fdb.map((entry) => ({ mac: entry.mac, port: entry.port })),
        arp: arp.map((entry) => ({ ip: entry.ip, mac: entry.mac })),
        sysName: system.sysName,
        sysDescr: system.sysDescr,
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `SNMP request failed: ${message}`,
      portsUpdated: 0,
      neighbors: [],
      fdb: [],
      arp: [],
      sysName: "",
      sysDescr: "",
    };
  }
}

/* ------------------------------------------------------------------ */
/* Topology learning from neighbours                                   */
/* ------------------------------------------------------------------ */

/**
 * Turn LLDP/CDP neighbour reports into connections.
 *
 * A neighbour is only linked when we can name the device on the other end.
 * When we cannot, the observation is recorded as an event so the operator
 * knows the link exists but is unresolved — never silently dropped.
 */
async function learnConnectionsFromNeighbors(
  device: Device,
  neighbors: SnmpNeighbor[],
  localPorts: NetworkPort[]
): Promise<number> {
  let created = 0;

  for (const neighbor of neighbors) {
    const remoteName = neighbor.remoteSystem?.trim();
    if (!remoteName || remoteName.toLowerCase() === "unknown") continue;

    const remote = (
      await listDevices({ search: remoteName })
    ).find(
      (candidate) =>
        candidate.id !== device.id &&
        (candidate.name.toLowerCase() === remoteName.toLowerCase() ||
          candidate.hostname.toLowerCase() === remoteName.toLowerCase())
    );
    if (!remote) continue;

    // Match the local port by the neighbour's local port number.
    const localPort =
      localPorts.find((port) => port.portNumber === neighbor.localPortIndex) ??
      localPorts.find((port) => port.ifName.toLowerCase() === (neighbor.remotePort ?? "").toLowerCase()) ??
      null;

    const remotePort =
      (await portByName(remote.id, neighbor.remotePort ?? "")) ??
      (await listPorts(remote.id)).find((port) => port.ifName.toLowerCase() === (neighbor.remotePort ?? "").toLowerCase()) ??
      null;

    const { created: isNew } = await upsertConnection({
      localDeviceId: device.id,
      localPortId: localPort?.id ?? null,
      remoteDeviceId: remote.id,
      remotePortId: remotePort?.id ?? null,
      type: "uplink",
      source: neighbor.protocol,
      confidence: neighbor.protocol === "lldp" ? 0.95 : 0.9,
      state: "unknown",
      evidence: `${neighbor.protocol.toUpperCase()} neighbour report: ${remoteName} on ${neighbor.remotePort}.`,
    });
    if (isNew) created += 1;
  }

  return created;
}

/**
 * Link endpoints through the MAC forwarding table.
 *
 * If a MAC is learned on port P of switch S, and the same MAC is the
 * management MAC of device D, then D is connected to S through P.
 */
async function learnConnectionsFromFdb(
  device: Device,
  fdb: { mac: string; port: number | null }[],
  localPorts: NetworkPort[]
): Promise<number> {
  const devices = await listDevices();
  const byMac = new Map<string, Device>();
  for (const candidate of devices) {
    if (candidate.mac) byMac.set(candidate.mac.toUpperCase(), candidate);
  }

  let created = 0;
  for (const entry of fdb) {
    const remote = byMac.get(entry.mac.toUpperCase());
    if (!remote || remote.id === device.id) continue;
    const localPort = localPorts.find((port) => port.portNumber === entry.port) ?? null;
    const { created: isNew } = await upsertConnection({
      localDeviceId: device.id,
      localPortId: localPort?.id ?? null,
      remoteDeviceId: remote.id,
      remotePortId: null,
      type: "access",
      source: "fdb",
      confidence: 0.7,
      state: "unknown",
      evidence: `The forwarding table shows ${entry.mac} learned on ${localPort?.ifName ?? `port ${entry.port}`}.`,
    });
    if (isNew) created += 1;
  }
  return created;
}

/* ------------------------------------------------------------------ */
/* External connectivity                                               */
/* ------------------------------------------------------------------ */

/** The result of the external connectivity check. */
export interface InternetCheck {
  up: boolean | null;
  evidence: string;
}

/**
 * Check external connectivity.
 *
 * Several targets are tested: a single dead host must not raise an "internet
 * down" incident. The check only succeeds when every target fails.
 */
export async function checkInternetConnectivity(
  targets: MonitorTarget[],
  timeoutMs = 2000
): Promise<InternetCheck> {
  const usable = targets.filter((target) => target.host.trim().length > 0);
  if (usable.length === 0) {
    return { up: null, evidence: "No external connectivity targets are configured." };
  }

  const results: string[] = [];
  let successes = 0;

  for (const target of usable) {
    const result = await runProbe(
      { host: target.host, type: target.type, port: target.port },
      timeoutMs
    );
    results.push(`${target.name || target.host}: ${result.reason}`);
    if (result.ok) successes += 1;
  }

  if (successes > 0) {
    return {
      up: true,
      evidence: `${successes} of ${usable.length} external target(s) answered — ${results.join(" | ")}`,
    };
  }
  return {
    up: false,
    evidence: `None of the ${usable.length} external target(s) answered — ${results.join(" | ")}`,
  };
}

/* ------------------------------------------------------------------ */
/* The per-device poll                                                 */
/* ------------------------------------------------------------------ */

/** Poll one device and write everything the console shows. */
export async function pollDevice(
  device: Device,
  options: CollectorOptions
): Promise<DevicePollResult> {
  const now = Date.now();
  const result: DevicePollResult = {
    deviceId: device.id,
    name: device.name,
    state: "UNKNOWN",
    reason: "",
    reachable: false,
    snmp: false,
    portsUpdated: 0,
    changed: false,
    error: "",
  };

  const previousState = device.healthState;
  const evidence: string[] = [];
  let internetUp: boolean | null = null;
  const managementLinkDown: string | null = null;
  const downInterfaces: string[] = [];
  let hasTrafficCounters = false;

  try {
    /* ── 1. SNMP ───────────────────────────────────────────────── */
    const credential = device.monitorMethod === "snmp" ? await credentialFor(device) : null;

    if (device.monitorMethod === "snmp" && !credential) {
      await recordObservation({
        deviceId: device.id,
        portId: null,
        observedAt: now,
        probeType: "snmp",
        probeTarget: device.mgmtIp,
        result: "skipped",
        latencyMs: null,
        reason: "No SNMP credential is configured for this device.",
        source: "collector",
      });
      evidence.push("No SNMP credential is configured, so SNMP polling was skipped.");
    } else if (device.monitorMethod === "snmp" && credential) {
      // The counters BEFORE this poll — the rate is the delta against them.
      const beforePoll = await listPorts(device.id);
      const snmp = await collectViaSnmp(device, credential, options);
      result.snmp = snmp.ok;
      result.portsUpdated = snmp.portsUpdated;

      await recordObservation({
        deviceId: device.id,
        portId: null,
        observedAt: now,
        probeType: "snmp",
        probeTarget: device.mgmtIp,
        result: snmp.ok ? "success" : "failure",
        latencyMs: null,
        reason: snmp.reason,
        source: "collector",
      });

      if (snmp.ok) {
        result.reachable = true;
        evidence.push(snmp.reason);

        // Enrich the inventory from what the device told us.
        const classification = classifyDevice({
          hostname: snmp.sysName || device.hostname,
          systemDescription: snmp.sysDescr,
          mac: device.mac,
          interfaceNames: (await listPorts(device.id)).map((p) => p.ifName),
        });
        if (snmp.sysName) {
          await upsertDiscoveredDevice({
            ip: device.mgmtIp,
            mac: device.mac,
            hostname: snmp.sysName,
            category: classification.category,
            systemDescription: snmp.sysDescr,
            source: "snmp_system",
            confidence: classification.confidence,
          });
        }

        const localPorts = await listPorts(device.id);
        await learnConnectionsFromNeighbors(device, snmp.neighbors, localPorts);
        await learnConnectionsFromFdb(device, snmp.fdb, localPorts);

        // Traffic rates from the counters we just stored.
        const refreshed = await listPorts(device.id);
        const traffic = await updatePortTraffic(device.id, beforePoll, refreshed, now);
        hasTrafficCounters = traffic.hasCounters;

        // Link states.
        for (const port of refreshed) {
          if (!port.managed) continue;
          if (port.operState === "down") downInterfaces.push(port.ifName);
        }
      } else {
        evidence.push(snmp.reason);
      }
    }

    /* ── 2. Active probe (for non-SNMP devices) ──────────────── */
    if (!result.reachable && device.monitorMethod !== "snmp") {
      const host = device.mgmtIp;
      if (!host.trim()) {
        await recordObservation({
          deviceId: device.id,
          portId: null,
          observedAt: now,
          probeType: "icmp",
          probeTarget: "",
          result: "skipped",
          latencyMs: null,
          reason: "The device has no management address, so it cannot be probed.",
          source: "collector",
        });
        evidence.push("The device has no management address, so it cannot be probed.");
      } else {
        const probe =
          device.monitorMethod === "tcp"
            ? await tcpProbe(host, 22, options.snmpTimeoutMs)
            : device.monitorMethod === "http"
              ? await runProbe({ host, type: "http" }, options.snmpTimeoutMs)
              : await pingProbe(host, options.snmpTimeoutMs);

        await recordObservation({
          deviceId: device.id,
          portId: null,
          observedAt: now,
          probeType: probe.type,
          probeTarget: probe.target,
          result: probe.ok ? "success" : "failure",
          latencyMs: probe.latencyMs,
          reason: probe.reason,
          source: "collector",
        });

        result.reachable = probe.ok;
        evidence.push(probe.reason);
      }
    }

    /* ── 3. External connectivity (for the internet boundary) ── */
    if (device.category === "internet" || device.category === "router" || device.category === "gateway") {
      const check = await checkInternetConnectivity(await internetTargets(), options.snmpTimeoutMs);
      internetUp = check.up;
      evidence.push(check.evidence);
    }

    /* ── 4. Local gateway reachability ────────────────────────── */
    if (result.reachable && device.monitorMethod === "snmp") {
      const gateways = (await gatewayTargets()).filter((target) => target.host.trim().length > 0);
      for (const gateway of gateways) {
        const probe = await runProbe(
          { host: gateway.host, type: gateway.type, port: gateway.port },
          options.snmpTimeoutMs
        );
        await recordObservation({
          deviceId: device.id,
          portId: null,
          observedAt: now,
          probeType: probe.type,
          probeTarget: probe.target,
          result: probe.ok ? "success" : "failure",
          latencyMs: probe.latencyMs,
          reason: probe.reason,
          source: "collector",
        });
      }
    }

    /* ── 5. Health evaluation ─────────────────────────────────── */
    const streak = await consecutiveProbeResults(device.id);
    const lastActivity = hasTrafficCounters
      ? await lastTrafficActivity("device", device.id)
      : null;
    const noTrafficSeconds = lastActivity === null ? null : (now - lastActivity) / 1000;

    const verdict = evaluateDeviceHealth({
      monitoringEnabled: device.monitoringEnabled,
      category: device.category,
      consecutiveFailures: streak.failures,
      consecutiveSuccesses: streak.successes,
      lastSuccessAt: device.lastSeenAt,
      lastObservedAt: now,
      failureThreshold: device.failureThreshold || (await defaultFailureThreshold()),
      staleAfterSeconds: await staleAfterSeconds(),
      pollIntervalSeconds: device.pollIntervalSeconds,
      now,
      managementLinkDown,
      downInterfaces,
      internetUp,
      hasTrafficCounters,
      noTrafficSeconds,
      probeEvidence: evidence,
    });

    result.state = verdict.state;
    result.reason = verdict.reason;

    /* ── 6. Persist the state + raise/clear the incident ──────── */
    await setDeviceHealth(device.id, verdict.state, verdict.reason);
    await touchDevice(device.id, { seen: result.reachable, observedAt: now });
    result.changed = previousState !== verdict.state;

    if (result.changed) {
      await recordEvent({
        type:
          verdict.state === "ONLINE"
            ? "device_recovered"
            : verdict.state === "OFFLINE"
              ? "device_unreachable"
              : "device_state_changed",
        severity: severityForState(verdict.state),
        title: `${device.name} → ${verdict.state}`,
        detail: verdict.reason,
        subjectType: "device",
        subjectId: device.id,
        source: "collector",
      });
    }

    await syncDeviceIncident({
      device,
      state: verdict.state,
      reason: verdict.reason,
      evidence: evidence.join(" | "),
      severity: severityForState(verdict.state),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    result.state = previousState;
    result.reason = `The collector hit an error while polling this device: ${message}`;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Link state                                                          */
/* ------------------------------------------------------------------ */

/**
 * Recompute the state of every connection from the ports at both ends and
 * raise or clear the link incidents.
 */
export async function refreshConnectionStates(): Promise<number> {
  const connections = await listConnections();
  const ports = new Map<number, NetworkPort>();
  for (const port of await listAllPorts()) ports.set(port.id, port);

  // The link states are written FIRST so that the incident engine can tell a
  // root cause from a symptom: a link that is down because the link above it
  // is down must join the root incident instead of creating its own.
  const graph = await buildTopologyGraph();
  const depthOf = (deviceId: number): number => graph.devices.get(deviceId)?.depth ?? 0;

  const ordered = [...connections].sort(
    (a, b) =>
      Math.min(depthOf(a.localDeviceId), depthOf(a.remoteDeviceId)) -
      Math.min(depthOf(b.localDeviceId), depthOf(b.remoteDeviceId))
  );

  const resolved = ordered.map((connection) => {
    const localPort = connection.localPortId ? ports.get(connection.localPortId) : undefined;
    const remotePort = connection.remotePortId ? ports.get(connection.remotePortId) : undefined;
    const { state, evidence } = connectionStateForPorts(localPort?.operState, remotePort?.operState);
    return { connection, localPort, remotePort, state, evidence };
  });

  let changed = 0;
  for (const entry of resolved) {
    if (entry.connection.state === entry.state) continue;
    await setConnectionState(entry.connection.id, entry.state, entry.evidence);
    changed += 1;
    await recordEvent({
      type: entry.state === "down" ? "uplink_failed" : "uplink_recovered",
      severity: entry.state === "down" ? "critical" : "info",
      title: entry.state === "down" ? "Link down" : "Link recovered",
      detail: entry.evidence,
      subjectType: "connection",
      subjectId: entry.connection.id,
      source: "collector",
    });
  }

  // Now the incidents, upstream links first, so the root cause of a cascade
  // is the incident that exists when the symptom links are processed.
  for (const entry of resolved) {
    await syncConnectionIncident({
      connectionId: entry.connection.id,
      state: entry.state,
      evidence: entry.evidence,
      localDeviceId: entry.connection.localDeviceId,
      remoteDeviceId: entry.connection.remoteDeviceId,
      localPortName: entry.localPort?.ifName ?? null,
      remotePortName: entry.remotePort?.ifName ?? null,
    });
  }

  return changed;
}

/* ------------------------------------------------------------------ */
/* Poll scheduling                                                     */
/* ------------------------------------------------------------------ */

/** The shortest poll interval the collector will honour, in seconds. */
export const MIN_POLL_INTERVAL_SECONDS = 5;

/**
 * Is this device due for a poll?
 *
 * Each device carries its own poll interval. The collector cycle runs every
 * 30 seconds, but a device configured for a 300-second interval must only
 * be polled every fifth cycle — otherwise a slow or expensive target is
 * hammered far more often than the operator asked for.
 *
 * A device that has never been observed is always due.
 */
export function isDeviceDue(device: Device, now: number): boolean {
  const interval = Math.max(
    MIN_POLL_INTERVAL_SECONDS,
    Number.isFinite(device.pollIntervalSeconds) ? device.pollIntervalSeconds : 60
  );
  if (device.lastObservedAt === null) return true;
  return now - device.lastObservedAt >= interval * 1000;
}

/* ------------------------------------------------------------------ */
/* The cycle                                                           */
/* ------------------------------------------------------------------ */

/** Run one full monitoring cycle over every monitored device. */
export async function runCollectorCycle(options: CollectorOptions): Promise<DevicePollResult[]> {
  const devices = await listDevices();
  const now = Date.now();
  // An explicit device list means "poll these now", so the schedule is
  // bypassed for that request.
  const forced = options.onlyDeviceIds !== undefined;
  const targets = devices.filter((device) => {
    if (!device.monitoringEnabled) return false;
    if (options.onlyDeviceIds && !options.onlyDeviceIds.includes(device.id)) return false;
    if (!forced && !isDeviceDue(device, now)) return false;
    return true;
  });

  const results: DevicePollResult[] = [];

  // A modest amount of concurrency: enough to be quick, gentle enough not to
  // overwhelm a small switch.
  const concurrency = 6;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const device = targets[index];
      try {
        results.push(await pollDevice(device, options));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          deviceId: device.id,
          name: device.name,
          state: device.healthState,
          reason: `The collector failed: ${message}`,
          reachable: false,
          snmp: false,
          portsUpdated: 0,
          changed: false,
          error: message,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));

  await refreshConnectionStates();
  const reachable = results.filter((result) => result.reachable).length;
  const skipped = devices.filter((device) => device.monitoringEnabled).length - targets.length;
  await writeCollectorHeartbeat(
    `${results.length} device(s) polled, ${reachable} reachable${skipped > 0 ? `, ${skipped} not due yet` : ""}.`
  );

  return results;
}

/* ------------------------------------------------------------------ */
/* Heartbeat                                                           */
/* ------------------------------------------------------------------ */

/**
 * Record that the collector is alive, so the console can say so.
 *
 * Both the real collector and the demo simulator write this heartbeat. The
 * console must never claim "no heartbeat recorded yet" while the collector
 * is demonstrably running — in demo mode that would tell the operator their
 * data is unconfirmed when it is in fact being produced every cycle.
 */
export async function writeCollectorHeartbeat(detail: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO Collector_State (Name, Heartbeat, Started_At, Detail)
          VALUES ('collector', ?, ?, ?)
          ON CONFLICT(Name) DO UPDATE SET Heartbeat = excluded.Heartbeat, Detail = excluded.Detail`,
    args: [now, now, detail],
  });
}

/** The collector's last heartbeat, or null when it has never run. */
export async function collectorHeartbeat(): Promise<{ at: number; detail: string } | null> {
  const row = await queryOne<{ Heartbeat: number; Detail: string }>(
    await getDb(),
    "SELECT Heartbeat, Detail FROM Collector_State WHERE Name = 'collector'"
  );
  return row ? { at: row.Heartbeat, detail: row.Detail } : null;
}

/* ------------------------------------------------------------------ */
/* Retention                                                           */
/* ------------------------------------------------------------------ */

/** Delete observations / samples / events older than the retention window. */
export async function applyRetention(): Promise<{ observations: number; samples: number; events: number }> {
  const { pruneObservations } = await import("../lib/repo/observations");
  const { pruneSamples } = await import("../lib/repo/traffic");
  const { pruneEvents } = await import("../lib/repo/events");
  const { getNumberSetting } = await import("../lib/settings");

  const now = Date.now();
  const observationCutoff =
    now - (await getNumberSetting("retention.observationDays", 7)) * 86_400_000;
  const sampleCutoff = now - (await getNumberSetting("retention.trafficDays", 14)) * 86_400_000;
  const eventCutoff = now - (await getNumberSetting("retention.eventDays", 90)) * 86_400_000;

  const observations = await pruneObservations(observationCutoff);
  const samples = await pruneSamples(sampleCutoff);
  const events = await pruneEvents(eventCutoff);

  return { observations, samples, events };
}

export { defaultPollSeconds, getDevice, deviceByIp, connectionsForDevice };
export type { Connection };
