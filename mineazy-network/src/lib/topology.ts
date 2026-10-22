/**
 * ============================================================================
 *  topology.ts — the graph behind the map
 * ============================================================================
 *
 *  Responsibilities:
 *
 *    1. Build the node/edge graph the canvas renders.
 *    2. Decide which end of a link is "upstream" — the direction the data
 *       flows towards the internet source — even though the underlying
 *       records are stored undirected (a cable is a cable).
 *    3. Trace the known upstream path from any device back to the gateway
 *       or internet source, so an administrator can follow the exact chain
 *       of switches and ports.
 *    4. Work out which devices sit downstream of a failed link.
 *
 *  The graph is derived from the stored connections only — it never invents
 *  a link. Where the physical truth is unknown (an unmanaged switch between
 *  two managed ones), the edge is simply missing and the UI says so.
 */

import { listConnections } from "./repo/connections";
import { listDevices } from "./repo/devices";
import { listLocations } from "./repo/sites";
import { listAllPorts } from "./repo/ports";
import type {
  Connection,
  Device,
  NetworkPort,
  TopologyEdge,
  TopologyNode,
  TopologySnapshot,
} from "./types";

/** A device with its resolved parent + depth in the tree. */
export interface PositionedDevice {
  device: Device;
  parentId: number | null;
  depth: number;
  /** The connection that links this device to its parent. */
  parentConnection: Connection | null;
  /** The port on THIS device that faces the parent. */
  parentPort: NetworkPort | null;
  /** The port on the PARENT device that faces this device. */
  parentSidePort: NetworkPort | null;
  children: number[];
}

/** The resolved topology of the whole network. */
export interface TopologyGraph {
  devices: Map<number, PositionedDevice>;
  connections: Connection[];
  ports: Map<number, NetworkPort>;
  /** Root devices (internet source / gateway) — the map's trunk. */
  roots: number[];
}

/**
 * Resolve the topology graph.
 *
 * The orientation algorithm:
 *   • Start from the internet source / gateway devices (the trunk).
 *   • Breadth-first walk the connection graph; every device is attached to
 *     the first neighbour that reaches it, which naturally puts switches
 *     above the endpoints that hang off them.
 *   • Components that are not connected to any trunk (isolated devices, or a
 *     loop of unmanaged equipment) are attached afterwards so no device is
 *     ever dropped from the map.
 */
export function buildTopologyGraph(): Promise<TopologyGraph> {
  return resolveTopologyGraph();
}

async function resolveTopologyGraph(): Promise<TopologyGraph> {
  const [deviceList, connectionList, portList] = await Promise.all([
    listDevices(),
    listConnections(),
    listAllPorts(),
  ]);

  const ports = new Map<number, NetworkPort>();
  const portsByDevice = new Map<number, Map<string, NetworkPort>>();
  for (const port of portList) {
    ports.set(port.id, port);
    if (!portsByDevice.has(port.deviceId)) portsByDevice.set(port.deviceId, new Map());
    portsByDevice.get(port.deviceId)!.set(port.ifName.toLowerCase(), port);
  }

  const devices = new Map<number, Device>();
  for (const device of deviceList) devices.set(device.id, device);

  // Undirected adjacency.
  const adjacency = new Map<number, { other: number; connection: Connection }[]>();
  for (const connection of connectionList) {
    if (!devices.has(connection.localDeviceId) || !devices.has(connection.remoteDeviceId)) continue;
    if (!adjacency.has(connection.localDeviceId)) adjacency.set(connection.localDeviceId, []);
    if (!adjacency.has(connection.remoteDeviceId)) adjacency.set(connection.remoteDeviceId, []);
    adjacency.get(connection.localDeviceId)!.push({ other: connection.remoteDeviceId, connection });
    adjacency.get(connection.remoteDeviceId)!.push({ other: connection.localDeviceId, connection });
  }

  const positioned = new Map<number, PositionedDevice>();
  const visited = new Set<number>();

  const place = (
    device: Device,
    parentId: number | null,
    depth: number,
    parentConnection: Connection | null
  ): void => {
    if (visited.has(device.id)) return;
    visited.add(device.id);
    let parentPort: NetworkPort | null = null;
    let parentSidePort: NetworkPort | null = null;
    if (parentConnection) {
      const localIsChild = parentConnection.localDeviceId === device.id;
      const childPortId = localIsChild ? parentConnection.localPortId : parentConnection.remotePortId;
      const parentPortId = localIsChild ? parentConnection.remotePortId : parentConnection.localPortId;
      parentPort = childPortId ? ports.get(childPortId) ?? null : null;
      parentSidePort = parentPortId ? ports.get(parentPortId) ?? null : null;
    }
    positioned.set(device.id, {
      device,
      parentId,
      depth,
      parentConnection,
      parentPort,
      parentSidePort,
      children: [],
    });
    if (parentId !== null) positioned.get(parentId)?.children.push(device.id);
  };

  // 1. Roots: the internet source first, then the gateway, then the routers.
  //
  //    A trunk device that is directly cabled to an ALREADY placed trunk
  //    device is downstream of it — promoting it to a root as well would
  //    split the tree in two and break the upstream path of everything
  //    below it. Only genuinely top-level trunk devices become roots.
  const trunk = deviceList.filter((device) =>
    (["internet", "gateway", "router"] as const).includes(
      device.category as "internet" | "gateway" | "router"
    )
  );
  const trunkPriority: Record<string, number> = { internet: 0, gateway: 1, router: 2 };
  trunk.sort(
    (a, b) => (trunkPriority[a.category] ?? 9) - (trunkPriority[b.category] ?? 9)
  );

  const rootIds: number[] = [];
  for (const device of trunk) {
    if (visited.has(device.id)) continue;
    const neighbours = adjacency.get(device.id) ?? [];
    const attachedToTrunk = neighbours.some(
      (neighbour) =>
        visited.has(neighbour.other) &&
        trunk.some((candidate) => candidate.id === neighbour.other)
    );
    if (attachedToTrunk) continue; // the breadth-first walk places it below its parent
    rootIds.push(device.id);
    place(device, null, 0, null);
  }

  // 2. Breadth-first expansion from the roots.
  const queue: number[] = [...rootIds];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const current = positioned.get(currentId);
    if (!current) continue;
    const neighbours = adjacency.get(currentId) ?? [];
    for (const neighbour of neighbours) {
      if (visited.has(neighbour.other)) continue;
      const device = devices.get(neighbour.other);
      if (!device) continue;
      place(device, currentId, current.depth + 1, neighbour.connection);
      queue.push(neighbour.other);
    }
  }

  // 3. Anything left (isolated devices / unmanaged islands) is attached to
  //    the best neighbour it has, so nothing disappears from the map.
  for (const device of deviceList) {
    if (visited.has(device.id)) continue;
    const neighbours = adjacency.get(device.id) ?? [];
    const neighbour = neighbours.find((n) => visited.has(n.other));
    if (neighbour) {
      place(device, neighbour.other, (positioned.get(neighbour.other)?.depth ?? 0) + 1, neighbour.connection);
    } else {
      rootIds.push(device.id);
      place(device, null, 0, null);
    }
  }

  // 4. Propagate depths for the devices attached in step 3.
  const propagate = (id: number): void => {
    const node = positioned.get(id);
    if (!node) return;
    for (const childId of node.children) {
      const child = positioned.get(childId);
      if (!child) continue;
      child.depth = node.depth + 1;
      propagate(childId);
    }
  };
  for (const id of rootIds) propagate(id);

  return {
    devices: positioned,
    connections: connectionList,
    ports,
    roots: rootIds,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshot for the canvas                                             */
/* ------------------------------------------------------------------ */

const LAYOUT_X_SPACING = 260;
const LAYOUT_Y_SPACING = 170;

/**
 * Build the canvas payload.
 *
 * Manual positions (stored on the device) win over the automatic layout, so
 * an administrator can tidy the map without losing the structure.
 */
export async function buildTopologySnapshot(): Promise<TopologySnapshot> {
  const graph = await resolveTopologyGraph();
  const locations = await listLocations();
  const locationNames = new Map(locations.map((location) => [location.id, location.name]));

  // Group children of each parent so siblings sit side by side.
  const siblingIndex = new Map<number, number>();
  const nodes: TopologyNode[] = [];

  /**
   * Resolve the automatic position of every device.
   *
   * A device with a manual position keeps it. Otherwise it is placed one
   * level below its parent, spread horizontally across the parent's own
   * resolved position so the tree reads top-down on the canvas.
   */
  const resolved = new Map<number, { x: number; y: number }>();

  const resolve = (node: PositionedDevice): { x: number; y: number } => {
    const cached = resolved.get(node.device.id);
    if (cached) return cached;

    const y = node.device.layoutY ?? node.depth * LAYOUT_Y_SPACING;

    let x: number;
    if (node.device.layoutX !== null) {
      x = node.device.layoutX;
    } else if (node.parentId === null) {
      x = 0;
    } else {
      const parent = graph.devices.get(node.parentId);
      const siblings = parent?.children.length ?? 1;
      const index = siblingIndex.get(node.parentId) ?? 0;
      siblingIndex.set(node.parentId, index + 1);
      const parentPosition = parent ? resolve(parent) : { x: 0, y: 0 };
      x = parentPosition.x + (index - (siblings - 1) / 2) * LAYOUT_X_SPACING;
    }

    const position = { x, y };
    resolved.set(node.device.id, position);
    return position;
  };

  for (const node of graph.devices.values()) {
    const auto = resolve(node);

    nodes.push({
      id: `dev-${node.device.id}`,
      deviceId: node.device.id,
      name: node.device.name,
      category: node.device.category,
      state: node.device.healthState,
      reason: node.device.healthReason,
      parentId: node.parentId !== null ? `dev-${node.parentId}` : null,
      locationName:
        node.device.locationId !== null ? locationNames.get(node.device.locationId) ?? null : null,
      ip: node.device.mgmtIp || null,
      portLabel: node.parentPort
        ? node.parentPort.label || node.parentPort.ifName
        : null,
      childCount: node.children.length,
      x: auto.x,
      y: auto.y,
    });
  }

  const edges: TopologyEdge[] = [];
  for (const connection of graph.connections) {
    const local = graph.devices.get(connection.localDeviceId);
    const remote = graph.devices.get(connection.remoteDeviceId);
    if (!local || !remote) continue;

    // Orient the edge parent → child.
    const localIsParent = local.depth <= remote.depth;
    const parentNode = localIsParent ? local : remote;
    const childNode = localIsParent ? remote : local;

    // The two ends of THIS cable — not the parent's own uplink port. The
    // connection is the authority on which port faces which device.
    const parentPortId = connection.localDeviceId === parentNode.device.id
      ? connection.localPortId
      : connection.remotePortId;
    const childPortId = connection.localDeviceId === childNode.device.id
      ? connection.localPortId
      : connection.remotePortId;
    const parentPort = parentPortId ? graph.ports.get(parentPortId) ?? null : null;
    const childPort = childPortId ? graph.ports.get(childPortId) ?? null : null;

    const label = [
      parentPort ? `${parentNode.device.name} ${parentPort.label || parentPort.ifName}` : null,
      childPort ? `${childNode.device.name} ${childPort.label || childPort.ifName}` : null,
    ]
      .filter(Boolean)
      .join(" → ");

    edges.push({
      id: `conn-${connection.id}`,
      connectionId: connection.id,
      source: `dev-${parentNode.device.id}`,
      target: `dev-${childNode.device.id}`,
      state: connection.state,
      sourceType: connection.source,
      label,
      cableId: connection.cableId,
      speedBps: parentPort?.speedBps ?? childPort?.speedBps ?? null,
      inRateBps: parentPort?.inRateBps ?? childPort?.inRateBps ?? null,
      outRateBps: parentPort?.outRateBps ?? childPort?.outRateBps ?? null,
      verified: connection.verified,
      confidence: connection.confidence,
    });
  }

  const lastObservationAt = await newestObservationAt();

  return {
    nodes,
    edges,
    generatedAt: Date.now(),
    lastObservationAt,
    simulated: Array.from(graph.devices.values()).some((node) => node.device.simulated),
  };
}

async function newestObservationAt(): Promise<number | null> {
  const { queryOne } = await import("./db");
  const row = await queryOne<{ At: number }>(
    await (await import("./db")).getDb(),
    "SELECT MAX(Observed_At) AS At FROM Health_Observations"
  );
  return row?.At ?? null;
}

/* ------------------------------------------------------------------ */
/* Path tracing                                                        */
/* ------------------------------------------------------------------ */

/** One hop of an upstream path. */
export interface TraceStep {
  device: Device;
  /** The connection that links this device to its parent (the upstream hop). */
  connection: Connection | null;
  /** The port on THIS device that faces the parent. */
  port: NetworkPort | null;
  /** The state of that link. */
  state: string;
}

/** The result of tracing a device back to the network root. */
export interface TraceResult {
  /** Ordered from the root (internet source) down to the selected device. */
  steps: TraceStep[];
  /** A readable path: "Starlink → Router → Admin Switch Port 01 → …". */
  path: string;
  /** The first hop whose link is not confirmed up. */
  brokenSegment: { deviceId: number; connectionId: number | null; state: string } | null;
}

/**
 * Trace the known upstream path of a device back to the gateway / internet
 * source, listing the port at every hop.
 */
export async function traceUpstreamPath(deviceId: number): Promise<TraceResult | null> {
  const graph = await resolveTopologyGraph();
  const start = graph.devices.get(deviceId);
  if (!start) return null;

  const chain: PositionedDevice[] = [];
  let cursor: PositionedDevice | undefined = start;
  const guard = new Set<number>();
  while (cursor && !guard.has(cursor.device.id)) {
    guard.add(cursor.device.id);
    chain.push(cursor);
    cursor = cursor.parentId !== null ? graph.devices.get(cursor.parentId) : undefined;
  }
  chain.reverse(); // root → device

  // Each step describes the hop that ARRIVES at the device: the port on
  // this device that faces its parent, and the state of that cable. The root
  // has no parent, so it carries no port and is always "up" — reaching it
  // means the internet source is in the path.
  const steps: TraceStep[] = chain.map((node) => ({
    device: node.device,
    connection: node.parentConnection,
    port: node.parentPort,
    state: node.parentConnection?.state ?? "up",
  }));

  const path = chain
    .map((node) => {
      const port = node.parentPort;
      const portLabel = port ? ` (${port.label || port.ifName})` : "";
      return `${node.device.name}${portLabel}`;
    })
    .join(" → ");

  const broken = steps.find((step) => step.state === "down");
  return {
    steps,
    path,
    brokenSegment: broken
      ? {
          deviceId: broken.device.id,
          connectionId: broken.connection?.id ?? null,
          state: broken.state,
        }
      : null,
  };
}

/** Every device downstream of a device (through known connections). */
export async function descendantsOf(deviceId: number): Promise<number[]> {
  const graph = await resolveTopologyGraph();
  const out: number[] = [];
  const queue = [...(graph.devices.get(deviceId)?.children ?? [])];
  const seen = new Set<number>([deviceId]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(graph.devices.get(id)?.children ?? []));
  }
  return out;
}

/** The devices that are directly connected to a device. */
export async function neighboursOf(deviceId: number): Promise<number[]> {
  const graph = await resolveTopologyGraph();
  const out = new Set<number>();
  for (const connection of graph.connections) {
    if (connection.localDeviceId === deviceId) out.add(connection.remoteDeviceId);
    if (connection.remoteDeviceId === deviceId) out.add(connection.localDeviceId);
  }
  return [...out];
}

/** A flat list of every device with its resolved parent (used by the UI). */
export async function topologyIndex(): Promise<
  { device: Device; parentId: number | null; depth: number; childCount: number }[]
> {
  const graph = await resolveTopologyGraph();
  return [...graph.devices.values()].map((node) => ({
    device: node.device,
    parentId: node.parentId,
    depth: node.depth,
    childCount: node.children.length,
  }));
}
