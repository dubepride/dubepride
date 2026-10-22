/**
 * ============================================================================
 *  incidents.ts — the alerting engine
 * ============================================================================
 *
 *  Rules that keep the notification centre useful instead of noisy:
 *
 *    • One open incident per dedupe key. A device that keeps failing updates
 *      the incident it already has.
 *    • Failures need the configured number of consecutive attempts before an
 *      incident is raised.
 *    • Downstream symptoms are CORRELATED to the upstream fault: when an
 *      uplink fails, the devices behind it are listed as "potentially
 *      affected" on the uplink incident instead of generating a flood of
 *      duplicate notifications.
 *    • Recovery is recorded: the incident is resolved and a recovery event
 *      is written.
 *    • A collector outage never becomes "every device is offline" — stale
 *      data is reported as stale.
 */

import { recordEvent } from "./repo/events";
import {
  createIncident,
  listIncidents,
  openIncidentByKey,
  resolveIncident,
  updateIncident,
} from "./repo/incidents";
import { getDevice } from "./repo/devices";
import { getConnection, listConnections } from "./repo/connections";
import { getDb, queryAll } from "./db";
import { isInternetBoundary } from "./health";
import { buildTopologyGraph, descendantsOf, traceUpstreamPath } from "./topology";
import type { Connection, Device, HealthState, Incident, Severity } from "./types";

/** The dedupe key for a device state incident. */
export function deviceIncidentKey(deviceId: number, state: HealthState): string {
  switch (state) {
    case "OFFLINE":
      return `device:${deviceId}:offline`;
    case "LINK_DOWN":
      return `device:${deviceId}:link_down`;
    case "NO_INTERNET":
      return `device:${deviceId}:no_internet`;
    case "DEGRADED":
      return `device:${deviceId}:degraded`;
    case "STALE":
      return `device:${deviceId}:stale`;
    default:
      return `device:${deviceId}:${state.toLowerCase()}`;
  }
}

/** The dedupe key for a connection incident. */
export function connectionIncidentKey(connectionId: number): string {
  return `connection:${connectionId}:down`;
}

/** The dedupe key for the internet-connectivity incident. */
export const INTERNET_INCIDENT_KEY = "network:internet:down";

/** Create an incident or refresh the existing one with the same key. */
export async function raiseOrUpdateIncident(input: {
  key: string;
  category: string;
  severity: Severity;
  title: string;
  deviceId?: number | null;
  connectionId?: number | null;
  evidence: string;
  affected?: number[];
  faultLocation?: string;
  confidence?: number;
}): Promise<{ id: number; created: boolean }> {
  const existing = await openIncidentByKey(input.key);
  if (existing) {
    await updateIncident(existing.id, {
      severity: input.severity,
      title: input.title,
      evidence: input.evidence,
      affected: input.affected ?? existing.affected,
      faultLocation: input.faultLocation ?? existing.faultLocation,
      confidence: input.confidence ?? existing.confidence,
    });
    return { id: existing.id, created: false };
  }

  const id = await createIncident({
    key: input.key,
    category: input.category,
    severity: input.severity,
    title: input.title,
    deviceId: input.deviceId ?? null,
    connectionId: input.connectionId ?? null,
    evidence: input.evidence,
    affected: input.affected ?? [],
    faultLocation: input.faultLocation ?? "",
    confidence: input.confidence ?? 0.5,
  });
  await recordEvent({
    type: "incident_raised",
    severity: input.severity,
    title: input.title,
    detail: input.evidence,
    subjectType: input.connectionId ? "connection" : input.deviceId ? "device" : "system",
    subjectId: input.connectionId ?? input.deviceId ?? null,
    source: "monitoring",
  });
  return { id, created: true };
}

/** Resolve an open incident (if any) and write a recovery event. */
export async function resolveIncidentByKey(key: string, note?: string): Promise<boolean> {
  const existing = await openIncidentByKey(key);
  if (!existing) return false;
  await resolveIncident(existing.id, note);
  await recordEvent({
    type: "incident_recovered",
    severity: "info",
    title: `Recovered: ${existing.title}`,
    detail: note ?? "The condition that raised this incident is no longer present.",
    subjectType: existing.connectionId ? "connection" : existing.deviceId ? "device" : "system",
    subjectId: existing.connectionId ?? existing.deviceId ?? null,
    source: "monitoring",
  });
  return true;
}

/**
 * Find an open incident on the upstream path of a device.
 *
 * Used to correlate a downstream symptom with the fault that actually
 * caused it.
 */
export async function findUpstreamIncident(deviceId: number): Promise<Incident | null> {
  const trace = await traceUpstreamPath(deviceId);
  if (!trace) return null;
  for (const step of trace.steps) {
    if (!step.connection) continue;
    const key = connectionIncidentKey(step.connection.id);
    const incident = await openIncidentByKey(key);
    if (incident) return incident;
  }
  return null;
}

/** The boundary devices that are currently reporting NO_INTERNET. */
async function boundaryDevicesWithoutInternet(): Promise<number[]> {
  const rows = await queryAll<{ Device_ID: number }>(
    await getDb(),
    "SELECT Device_ID FROM Devices WHERE Health_State = 'NO_INTERNET' AND Category IN ('internet','gateway','router')"
  );
  return rows.map((row) => row.Device_ID);
}

/**
 * Raise or clear the incident for a device that changed state.
 *
 * Returns the incident id when one is open for the device.
 */
export async function syncDeviceIncident(input: {
  device: Device;
  state: HealthState;
  reason: string;
  evidence: string;
  severity: Severity;
  faultLocation?: string;
  confidence?: number;
}): Promise<{ incidentId: number | null; correlated: boolean }> {
  const { device, state, reason, evidence, severity } = input;

  // States that are not faults: clear any incident we may have raised.
  if (state === "ONLINE" || state === "UNKNOWN" || state === "UNMONITORED" || state === "NO_TRAFFIC") {
    const keys = [
      deviceIncidentKey(device.id, "OFFLINE"),
      deviceIncidentKey(device.id, "LINK_DOWN"),
      deviceIncidentKey(device.id, "DEGRADED"),
      deviceIncidentKey(device.id, "STALE"),
    ];
    // Each of these keys may hold an open incident for this device. They are
    // closed here; the caller only needs to know that the device is not in
    // trouble any more.
    for (const key of keys) {
      await resolveIncidentByKey(key);
    }

    // The internet incident is global: it is only closed once NO boundary
    // device reports the external checks as failing any more.
    if (isInternetBoundary(device.category)) {
      const stillDown = (await boundaryDevicesWithoutInternet()).filter((id) => id !== device.id);
      if (stillDown.length === 0) {
        await resolveIncidentByKey(INTERNET_INCIDENT_KEY, "External connectivity checks are passing again.");
      }
    }

    return { incidentId: null, correlated: false };
  }

  if (state === "NO_INTERNET") {
    // The internet incident is global, not per device.
    const { id } = await raiseOrUpdateIncident({
      key: INTERNET_INCIDENT_KEY,
      category: "internet",
      severity,
      title: "External internet connectivity lost",
      evidence,
      faultLocation: "Upstream internet provider / WAN boundary",
      confidence: 0.8,
    });
    return { incidentId: id, correlated: false };
  }

  const key = deviceIncidentKey(device.id, state);

  // A downstream symptom behind a known upstream fault is correlated, not
  // duplicated: add it to the parent's affected list instead.
  if (state === "OFFLINE" || state === "LINK_DOWN") {
    const upstream = await findUpstreamIncident(device.id);
    if (upstream && upstream.deviceId !== device.id) {
      const affected = new Set(upstream.affected);
      affected.add(device.id);
      await updateIncident(upstream.id, { affected: [...affected] });
      return { incidentId: upstream.id, correlated: true };
    }
  }

  const { id } = await raiseOrUpdateIncident({
    key,
    category: state.toLowerCase(),
    severity,
    title: incidentTitle(device, state),
    deviceId: device.id,
    evidence: `${reason}\n${evidence}`.trim(),
    faultLocation: input.faultLocation ?? defaultFaultLocation(device),
    confidence: input.confidence ?? 0.9,
  });
  return { incidentId: id, correlated: false };
}

/** The headline for a device incident. */
export function incidentTitle(device: Device, state: HealthState): string {
  switch (state) {
    case "OFFLINE":
      return `${device.name} is offline`;
    case "LINK_DOWN":
      return `${device.name} link is down`;
    case "NO_INTERNET":
      return `${device.name} cannot reach the internet`;
    case "DEGRADED":
      return `${device.name} is degraded`;
    case "STALE":
      return `${device.name} monitoring data is stale`;
    default:
      return `${device.name}: ${state}`;
  }
}

/** Where the fault most likely is, when nothing better is known. */
function defaultFaultLocation(device: Device): string {
  const parts: string[] = [];
  if (device.locationId !== null) parts.push("the device's recorded location");
  parts.push(device.name);
  return parts.join(" — ");
}

/**
 * Find the broken link that is the ROOT CAUSE of a down connection.
 *
 * When a switch dies, every port below it reports "down" and the naive
 * behaviour would raise one critical incident per cable. The console should
 * show the FIRST broken link and list everything below it as affected, so
 * the administrator looks at one thing instead of twenty.
 *
 * The search walks the upstream chain of the connection's downstream end and
 * returns the first broken link above it. It uses the stored link states, so
 * it is independent of the order in which the links are processed.
 */
export async function findRootBrokenConnection(connection: Connection): Promise<Connection | null> {
  const graph = await buildTopologyGraph();
  const local = graph.devices.get(connection.localDeviceId);
  const remote = graph.devices.get(connection.remoteDeviceId);
  if (!local || !remote) return null;

  // The deeper end is the downstream end of the cable.
  const downstream = local.depth <= remote.depth ? remote : local;

  const trace = await traceUpstreamPath(downstream.device.id);
  if (!trace) return null;

  for (const step of trace.steps) {
    if (!step.connection) continue;
    if (step.connection.id === connection.id) continue;
    if (step.connection.state === "down") return step.connection;
  }
  return null;
}

/**
 * Raise an incident for a failed connection (a down uplink).
 *
 * The downstream devices are listed so the administrator immediately sees
 * the blast radius.
 */
export async function syncConnectionIncident(input: {
  connectionId: number;
  state: string;
  evidence: string;
  localDeviceId: number;
  remoteDeviceId: number;
  localPortName?: string | null;
  remotePortName?: string | null;
}): Promise<{ incidentId: number | null; affected: number[]; correlated: boolean }> {
  if (input.state !== "down") {
    // The call closes the incident; there is nothing else to report.
    await resolveIncidentByKey(connectionIncidentKey(input.connectionId));
    return { incidentId: null, affected: [], correlated: false };
  }

  const affected = await descendantsOf(input.localDeviceId);
  const affectedRemote = await descendantsOf(input.remoteDeviceId);
  const allAffected = [...new Set([...affected, ...affectedRemote])];

  // A link that is broken because something ABOVE it is broken is a symptom,
  // not a cause. It joins the root incident instead of creating a new one.
  const connection = await getConnection(input.connectionId);
  if (connection) {
    const rootCause = await findRootBrokenConnection(connection);
    if (rootCause) {
      const rootIncident = await openIncidentByKey(connectionIncidentKey(rootCause.id));
      if (rootIncident) {
        const merged = [...new Set([...rootIncident.affected, ...allAffected])];
        await updateIncident(rootIncident.id, { affected: merged });
        return { incidentId: rootIncident.id, affected: merged, correlated: true };
      }
    }
  }

  const local = await getDevice(input.localDeviceId);
  const remote = await getDevice(input.remoteDeviceId);
  const title = `Link down: ${local?.name ?? "device"} ↔ ${remote?.name ?? "device"}`;

  const portText = [
    input.localPortName ? `${local?.name ?? "local"} ${input.localPortName}` : null,
    input.remotePortName ? `${remote?.name ?? "remote"} ${input.remotePortName}` : null,
  ]
    .filter(Boolean)
    .join(" ↔ ");

  const { id } = await raiseOrUpdateIncident({
    key: connectionIncidentKey(input.connectionId),
    category: "link_down",
    severity: "critical",
    title,
    connectionId: input.connectionId,
    deviceId: input.localDeviceId,
    evidence: `${input.evidence}${portText ? `\nPorts: ${portText}` : ""}`,
    affected: allAffected,
    faultLocation: portText || "The connection between the two devices.",
    confidence: 0.85,
  });
  return { incidentId: id, affected: allAffected, correlated: false };
}

/** Count the open incidents per severity (overview tiles). */
export async function activeIncidentSummary(): Promise<{
  total: number;
  critical: number;
  major: number;
  minor: number;
  acknowledged: number;
}> {
  const incidents = await listIncidents({ state: "active" });
  return {
    total: incidents.length,
    critical: incidents.filter((i) => i.severity === "critical").length,
    major: incidents.filter((i) => i.severity === "major").length,
    minor: incidents.filter((i) => i.severity === "minor").length,
    acknowledged: incidents.filter((i) => i.acknowledged).length,
  };
}

/** Every connection that is currently recorded as down. */
export async function downConnections(): Promise<number[]> {
  const connections = await listConnections();
  return connections.filter((c) => c.state === "down").map((c) => c.id);
}
