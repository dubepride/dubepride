/**
 * ============================================================================
 *  topology-layered.ts — the tidy, tiered view of a star network
 * ============================================================================
 *
 *  A hundred devices fanned out around one gateway is technically a spiderweb,
 *  but at that size it reads as noise. The layered view keeps the same truth
 *  and organises it:
 *
 *      Internet
 *          |
 *       Gateway
 *          |
 *    ┌─────┴─────┬──────────┐
 *  Cameras     Phones    Unclassified
 *  (45)        (2)       (59)
 *
 *  Each group is a single row until it is opened, at which point its devices
 *  are laid out in a neat grid underneath it. Nothing is invented: a device
 *  that is not on the network is not in a group, and the group's state is the
 *  worst state of its own members.
 */

import type { DeviceCategory, HealthState, TopologyNode } from "./types";

/** Where each equipment type sorts in the list. Unknowns go last. */
const CATEGORY_ORDER: DeviceCategory[] = [
  "router",
  "gateway",
  "switch",
  "access_point",
  "server",
  "nas",
  "nvr",
  "camera",
  "desktop",
  "laptop",
  "tablet",
  "phone",
  "voip_phone",
  "printer",
  "industrial",
  "internet",
  "unknown",
];

/**
 * Worst-state-wins. The order is the same severity the rest of the console
 * uses: a confirmed failure outranks an unavailable service, which outranks
 * staleness, which outranks a healthy device.
 */
const SEVERITY: Record<string, number> = {
  OFFLINE: 100,
  LINK_DOWN: 95,
  NO_INTERNET: 80,
  DEGRADED: 70,
  STALE: 60,
  NO_TRAFFIC: 50,
  UNKNOWN: 40,
  ONLINE: 10,
};

export function worstState(states: HealthState[]): HealthState {
  if (states.length === 0) return "UNKNOWN";
  let worst: HealthState = states[0];
  for (const state of states) {
    if ((SEVERITY[state] ?? 0) > (SEVERITY[worst] ?? 0)) worst = state;
  }
  return worst;
}

/* Geometry. The numbers mirror the CSS: a device node is 156 x 130. */
export const LAYERED = {
  /** Horizontal distance between device nodes in a group grid. */
  stepX: 158,
  /** Vertical distance between rows of devices. */
  stepY: 142,
  /** Maximum devices per row before wrapping. */
  columns: 10,
  /** Height of a closed group row. */
  closedHeight: 62,
  /** Height of the group header inside an open group. */
  headerHeight: 62,
  /** Vertical padding below the last device row. */
  bottomPadding: 18,
  /** Width of a closed group row. */
  closedWidth: 760,
  /** Minimum width of an open group. */
  minOpenWidth: 760,
  /** Vertical gap between group rows. */
  laneGap: 18,
  /** Y of the first group row. */
  firstLaneY: 250,
  /** Gateway and internet positions. */
  gatewayY: 0,
  internetY: -190,
};

export interface LayeredGroup {
  key: string;
  category: DeviceCategory;
  devices: TopologyNode[];
  /** Worst state of the members. */
  state: HealthState;
  /** Members that are ONLINE. */
  online: number;
  collapsed: boolean;
  /** Height reserved in the stack, including the device grid. */
  height: number;
  /** Height of the visible header bar (the click target). */
  visualHeight: number;
  /** Width of this row. */
  width: number;
  /** Top-left corner of the group header. */
  x: number;
  y: number;
}

export interface LayeredLayout {
  gateway: TopologyNode | null;
  /** Top-left corner of the gateway node. */
  gatewayPosition: { x: number; y: number };
  /** Top-left corner of the logical internet node. */
  internetPosition: { x: number; y: number };
  groups: LayeredGroup[];
  /** Device positions, keyed by topology node id. */
  positions: Map<string, { x: number; y: number }>;
  /** Total height of the group stack, for fitView padding. */
  height: number;
}

/** The nodes that are not the gateway itself. */
function isEndpoint(node: TopologyNode): boolean {
  return node.category !== "router" && node.category !== "gateway" && node.category !== "internet";
}

/**
 * Pick the gateway. The classified router wins; if classification has not
 * caught up, the node with the most children does, and only then the first
 * node with a default-route looking address.
 */
function findGateway(nodes: TopologyNode[]): TopologyNode | null {
  const classified = nodes.find((n) => n.category === "router" || n.category === "gateway");
  if (classified) return classified;
  const withChildren = [...nodes].sort((a, b) => b.childCount - a.childCount)[0];
  return withChildren ?? null;
}

/**
 * Place devices, groups and the gateway.
 *
 * `expanded` holds the category keys the operator has opened. Everything is
 * derived from the input; calling this twice with the same inputs produces the
 * same map, which is what lets the view keep its shape across refreshes.
 */
export function layoutLayered(
  nodes: TopologyNode[],
  expanded: ReadonlySet<string>
): LayeredLayout {
  const gateway = findGateway(nodes);
  const endpoints = nodes.filter((n) => n.id !== gateway?.id && isEndpoint(n));

  const byCategory = new Map<DeviceCategory, TopologyNode[]>();
  for (const node of endpoints) {
    const list = byCategory.get(node.category) ?? [];
    list.push(node);
    byCategory.set(node.category, list);
  }

  const categories = [...byCategory.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai !== bi) return ai - bi;
    return (byCategory.get(b)?.length ?? 0) - (byCategory.get(a)?.length ?? 0);
  });

  /*
   * Every row shares ONE left edge, so the connectors from the gateway form a
   * single clean trunk down the left instead of five crossing lines. `treeLeft`
   * is therefore fixed, not centred per row: opening a group makes that row
   * wider to the right, never shifts the trunk.
   */
  const treeLeft = -790;
  const gatewayCentreX = treeLeft - 90;

  const positions = new Map<string, { x: number; y: number }>();
  const groups: LayeredGroup[] = [];
  let y = LAYERED.firstLaneY;

  for (const category of categories) {
    const devices = [...(byCategory.get(category) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const collapsed = !expanded.has(category);
    const columns = Math.min(devices.length, LAYERED.columns);
    const rows = collapsed ? 0 : Math.ceil(devices.length / columns);
    const width = collapsed
      ? LAYERED.closedWidth
      : Math.max(LAYERED.minOpenWidth, columns * LAYERED.stepX + 60);
    const height = collapsed
      ? LAYERED.closedHeight
      : LAYERED.headerHeight + rows * LAYERED.stepY + LAYERED.bottomPadding;

    groups.push({
      key: category,
      category,
      devices,
      state: worstState(devices.map((d) => d.state)),
      online: devices.filter((d) => d.state === "ONLINE").length,
      collapsed,
      width,
      height,
      visualHeight: LAYERED.closedHeight,
      x: treeLeft,
      y,
    });

    if (!collapsed) {
      devices.forEach((device, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        positions.set(device.id, {
          x: treeLeft + 30 + column * LAYERED.stepX,
          y: y + LAYERED.headerHeight + row * LAYERED.stepY + 8,
        });
      });
    }

    y += height + LAYERED.laneGap;
  }

  return {
    gateway,
    gatewayPosition: { x: gatewayCentreX - 78, y: LAYERED.gatewayY },
    internetPosition: { x: gatewayCentreX - 85, y: LAYERED.internetY },
    groups,
    positions,
    height: y - LAYERED.firstLaneY,
  };
}
