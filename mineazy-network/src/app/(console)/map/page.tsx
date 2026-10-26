/**
 * ============================================================================
 *  Map — the live topology canvas
 * ============================================================================
 *
 *  Individual device nodes only (never aggregates). Every node carries a
 *  RECOGNISABLE illustration of the equipment it represents — a switch looks
 *  like a switch, a camera looks like a camera — plus a name, category, IP and
 *  one state indicator.
 *
 *  Cables are clickable objects in their own right: selecting one opens the
 *  connection inspector (both ports, physical link, speed, rates, errors,
 *  provenance). Cables are coloured by the health of the PATH, while a
 *  separate marker shows the PHYSICAL link, because those are two different
 *  facts: a cable can be up and carrying local traffic while the internet
 *  beyond it is unreachable (purple, never red).
 * ============================================================================
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CableEdge, type CableEdgeType } from "@/components/CableEdge";
import { DeviceGlyph, STATE_COLOUR, stateColour } from "@/components/DeviceGlyph";
import { Icon } from "@/components/Icon";
import { MapNodeMeasurer } from "@/components/MapNodeMeasurer";
import { useApi } from "@/components/useApi";
import { useAuth } from "@/components/auth";
import { apiGet, apiPost } from "@/components/api";
import {
  Chip,
  ErrorNote,
  Evidence,
  KeyValue,
  Loading,
  Notice,
  PageHeader,
  Panel,
  StateBadge,
} from "@/components/ui";
import { formatBandwidth, humanise, timeAgo } from "@/components/format";
import {
  DEVICE_CATEGORIES,
  HEALTH_STATES,
  type DeviceCategory,
  type HealthState,
  type TopologyEdge,
  type TopologyNode,
  type TopologySnapshot,
} from "@/lib/types";
import { layoutLayered } from "@/lib/topology-layered";

interface TraceResult {
  path: string;
  brokenSegment: { deviceId: number; connectionId: number | null; state: string } | null;
  steps: { device: { id: number; name: string }; state: string }[];
}

interface TopologyPayload {
  snapshot: TopologySnapshot;
  collector: { at: number; detail: string } | null;
  trace?: TraceResult | null;
}

/** The payload a map node carries. */
type MapNodeData = {
  /** "device" is real hardware; the rest are view structure. */
  kind: "device" | "group" | "internet" | "layer" | "frame";
  deviceId: number;
  name: string;
  category: DeviceCategory;
  state: HealthState;
  /** Plain-words explanation of the current state, shown as the tooltip. */
  reason: string;
  ip: string | null;
  portLabel: string | null;
  childCount: number;
  locationName: string | null;
  manufacturer: string;
  model: string;
  mac: string;
  inRateBps: number | null;
  outRateBps: number | null;
  portCount: number;
  /** Group rows only: the category key they open, and their summary. */
  groupKey?: string;
  groupCount?: number;
  groupOnline?: number;
  groupCollapsed?: boolean;
  /** Group rows only: the grid size this row gets when opened. */
  groupOpenWidth?: number;
  groupOpenHeight?: number;
  /** Layer captions only: a short factual note beside the layer name. */
  layerNote?: string;
  /** True while the operator has this node open in the inspector. */
  selected?: boolean;
};

/**
 * The React Flow node type for a map node.
 *
 * `NodeProps` is constrained to a full `Node`, not a bare data bag, so the
 * component is typed against the NODE and reads its payload off `data`.
 */
type MapNodeType = Node<MapNodeData, "mapNode">;
type GroupNodeType = Node<MapNodeData, "groupNode">;
type InternetNodeType = Node<MapNodeData, "internetNode">;
type GroupFrameNodeType = Node<MapNodeData, "groupFrame">;
type LayerNodeType = Node<MapNodeData, "layerLabel">;
type AnyMapNode =
  | MapNodeType
  | GroupNodeType
  | InternetNodeType
  | GroupFrameNodeType
  | LayerNodeType;

/**
 * The CSS class that carries a device's state colour.
 *
 * React Flow hides a node until it has been measured, so the class lives on
 * the inner card, not on the wrapper. Keeping the mapping in one place means
 * the node, its badge and the minimap cannot drift apart.
 */
function nodeStateClass(state: HealthState): string {
  switch (state) {
    case "OFFLINE":
      return "map-node--offline";
    case "LINK_DOWN":
      return "map-node--link_down";
    case "NO_INTERNET":
      // Purple: the link is up, the internet is not. Not a device failure.
      return "map-node--no_internet";
    case "DEGRADED":
      return "map-node--degraded";
    case "STALE":
      return "map-node--stale";
    case "NO_TRAFFIC":
      return "map-node--no_traffic";
    case "ONLINE":
      return "map-node--online";
    default:
      return "";
  }
}

/** A human, plural name for a group row ("Cameras", "Unclassified"). */
function groupLabel(category: DeviceCategory): string {
  if (category === "unknown") return "Unclassified";
  const label = humanise(category);
  if (/(s|x|ch|sh)$/i.test(label)) return `${label}es`;
  return `${label}s`;
}

function MapNode({ data }: NodeProps<MapNodeType>) {
  const rateText = (value: number | null): string => (value === null ? "—" : formatBandwidth(value));
  return (
    <div
      className={`map-node ${data.selected ? "map-node--selected" : ""} ${
        data.category === "router" ? "map-node--anchor" : ""
      } ${nodeStateClass(data.state)}`}
      title={`${data.name} — ${humanise(data.state)}: ${data.reason}`}
      aria-label={`${data.name}, ${humanise(data.category)}, state ${humanise(data.state)}`}
    >
      {/*
        React Flow attaches an edge to a HANDLE, not to the node itself. A
        custom node type that renders no handles can never be the source or
        the target of an edge — the links silently fail to appear.
      */}
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />
      {/* Vertical handles serve the tiered view. */}
      <Handle type="target" position={Position.Top} id="up" />
      <Handle type="source" position={Position.Bottom} id="down" />

      <span className="map-node__glyph">
        <DeviceGlyph
          category={data.category}
          size={42}
          led={stateColour(data.state)}
          title={`${humanise(data.category)} illustration`}
        />
      </span>

      <span className="map-node__name">{data.name}</span>
      <span className="map-node__sub">
        {humanise(data.category)}
        {data.manufacturer ? ` · ${data.manufacturer}` : ""}
      </span>
      <span className="map-node__ip">{data.ip ?? "no address"}</span>

      <span className="map-node__rates">
        <span className="map-node__rate map-node__rate--down" title="Down / inbound rate">
          ↓ {rateText(data.inRateBps)}
        </span>
        <span className="map-node__rate map-node__rate--up" title="Up / outbound rate">
          ↑ {rateText(data.outRateBps)}
        </span>
      </span>

      <span className="map-node__state">
        <span
          className="map-node__led"
          style={{ background: stateColour(data.state) }}
          aria-hidden="true"
        />
        {humanise(data.state)}
      </span>
    </div>
  );
}

/**
 * A whole equipment type on one row: the tidy default view.
 *
 * The row is the click target — opening it lays its devices out underneath in
 * a grid, closing it puts the map back to a handful of rows.
 */
function GroupNode({ data }: NodeProps<GroupNodeType>) {
  return (
    <div
      className={`group-node ${data.groupCollapsed ? "" : "group-node--open"} ${nodeStateClass(
        data.state
      )}`}
      title={`${data.name}: ${data.reason}`}
      aria-label={`${data.name}, ${data.groupCount} devices, ${data.groupCollapsed ? "closed" : "open"}`}
    >
      <Handle type="target" position={Position.Left} id="left" />
      <span className="group-node__glyph">
        <DeviceGlyph category={data.category} size={26} led={stateColour(data.state)} />
      </span>
      <span className="group-node__label">{data.name}</span>
      <span className="group-node__count">{data.groupCount}</span>
      <span className="group-node__summary">{data.ip}</span>
      <span className="group-node__chevron">{data.groupCollapsed ? "Open" : "Close"}</span>
    </div>
  );
}

/** The logical internet endpoint above the gateway. It is a path, not hardware. */
function InternetNode({ data }: NodeProps<InternetNodeType>) {
  return (
    <div className={`internet-node ${nodeStateClass(data.state)}`} title={data.reason}>
      <DeviceGlyph category="internet" size={38} led={stateColour(data.state)} />
      <span className="internet-node__label">Internet</span>
      <span className="internet-node__state">{humanise(data.state)}</span>
      <Handle type="source" position={Position.Bottom} id="down" />
    </div>
  );
}

/** The tinted band an open group's devices sit on. Purely decorative. */
function GroupFrame() {
  return <div className="group-frame" aria-hidden="true" />;
}

/** A tier caption — Core, Distribution, Access — not a device. */
function LayerLabel({ data }: NodeProps<LayerNodeType>) {
  return (
    <div className="layer-label">
      <span className="layer-label__name">{data.name}</span>
      {data.layerNote ? <span className="layer-label__note">{data.layerNote}</span> : null}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  mapNode: MapNode,
  groupNode: GroupNode,
  internetNode: InternetNode,
  groupFrame: GroupFrame,
  layerLabel: LayerLabel,
};const edgeTypes: EdgeTypes = { cable: CableEdge };

/**
 * True when two node payloads describe exactly the same thing.
 *
 * Used to decide whether a polled node can keep its previous object identity.
 */
function sameNodeData(a: MapNodeData, b: MapNodeData): boolean {
  return (
    a.kind === b.kind &&
    a.deviceId === b.deviceId &&
    a.name === b.name &&
    a.category === b.category &&
    a.state === b.state &&
    a.reason === b.reason &&
    a.ip === b.ip &&
    a.portLabel === b.portLabel &&
    a.childCount === b.childCount &&
    a.locationName === b.locationName &&
    a.manufacturer === b.manufacturer &&
    a.model === b.model &&
    a.mac === b.mac &&
    a.inRateBps === b.inRateBps &&
    a.outRateBps === b.outRateBps &&
    a.portCount === b.portCount &&
    a.groupKey === b.groupKey &&
    a.groupCount === b.groupCount &&
    a.groupOnline === b.groupOnline &&
    a.groupCollapsed === b.groupCollapsed &&
    a.groupOpenWidth === b.groupOpenWidth &&
    a.groupOpenHeight === b.groupOpenHeight &&
    a.layerNote === b.layerNote &&
    Boolean(a.selected) === Boolean(b.selected)
  );
}

/** A stable signature of the parts of an edge that affect how it is drawn. */
function edgeSignature(edge: CableEdgeType): string {
  return [
    edge.source,
    edge.target,
    edge.sourceHandle ?? "",
    edge.targetHandle ?? "",
    edge.type ?? "",
    edge.selected ? "1" : "0",
    JSON.stringify(edge.data ?? null),
  ].join("|");
}

/** How far the path along a cable has drifted from healthy. */
function cableTone(edge: TopologyEdge, internetDown: boolean, nodeState: Map<string, string>) {
  // A managed port reporting the link down is a confirmed physical failure,
  // whatever the (possibly older) connection record still says.
  if (edge.state === "down" || edge.physicalState === "down") return "danger" as const;
  if (edge.state === "degraded") return "warn" as const;
  if (edge.state === "unknown") return "muted" as const;
  // Purple is reserved for "the cable is fine, the internet beyond it is not":
  // both ends agree that only external connectivity is failing.
  if (internetDown) {
    const a = nodeState.get(edge.source);
    const b = nodeState.get(edge.target);
    if (a === "NO_INTERNET" && b === "NO_INTERNET") return "purple" as const;
  }
  return "ok" as const;
}

export default function MapPage() {
  const { data, error, loading, reload } = useApi<TopologyPayload>("/api/topology", {
    pollMs: 10_000,
  });
  const { can } = useAuth();
  const [nodes, setNodes, onNodesChange] = useNodesState<AnyMapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CableEdgeType>([]);
  const [selected, setSelected] = useState<{ id: string; data: MapNodeData } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [evidence, setEvidence] = useState<{
    text: string;
    source: string;
    confidence: string;
  } | null>(null);
  const [tracing, setTracing] = useState(false);

  // Canvas controls
  const [query, setQuery] = useState("");
  const [healthFilter, setHealthFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [viewMode, setViewMode] = useState<"layered" | "links">("layered");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [layoutMsg, setLayoutMsg] = useState<string | null>(null);

  /**
   * The React Flow instance, captured on init. It is the public handle on the
   * flow's internal state (including the measured size of every node).
   */
  const flowRef = useRef<ReactFlowInstance<AnyMapNode, CableEdgeType> | null>(null);
  const inspectedId = selected?.id ?? null;

  /**
   * How much of each node's detail to render.
   *
   * A hundred devices do not fit on one screen at a readable size. Instead of
   * drawing unreadable text, the map drops detail as it zooms out: icons at a
   * distance, names as you approach, speeds and ports up close.
   */
  const [zoomBand, setZoomBand] = useState<"far" | "mid" | "near">("near");
  const fittedRef = useRef(false);

  /**
   * Merge a polled snapshot into the graph WITHOUT throwing away what React
   * Flow has already measured.
   *
   * React Flow measures a node's box with a ResizeObserver and stores the
   * result on its INTERNAL node. That measurement is copied back onto the
   * user's node object only when the object identity is preserved
   * (`adoptUserNodes` copies `measured` from the user object and reuses the
   * internal node only when `userNode === internals.userNode`).
   *
   * If every poll replaces the nodes with brand-new objects, the measurement
   * is wiped, the nodes fall back to `visibility: hidden`, the ResizeObserver
   * never fires again (the element is already observed and its size never
   * changed) and the canvas stays blank forever.
   *
   * So: reuse the previous object when nothing changed, and otherwise carry
   * the last known `measured` box onto the new object.
   */
  useEffect(() => {
    if (!data?.snapshot) return;
    const snapshot = data.snapshot;
    const stateById = new Map(snapshot.nodes.map((n) => [n.id, n.state]));
    const internetDown = snapshot.nodes.some((n) => n.state === "NO_INTERNET");

    const term = query.trim().toLowerCase();
    const filtersActive = term.length > 0 || healthFilter !== "all" || categoryFilter !== "all";
    const matchesFilter = (n: TopologyNode): boolean => {
      if (categoryFilter !== "all" && n.category !== categoryFilter) return false;
      if (healthFilter !== "all" && n.state !== healthFilter) return false;
      if (!term) return true;
      return [n.name, n.ip, n.category, n.manufacturer, n.model, n.mac, n.portLabel, n.locationName]
        .some((value) => (value ?? "").toString().toLowerCase().includes(term));
    };

    setNodes((prevNodes) => {
      const prevById = new Map(prevNodes.map((n) => [n.id, n]));
      const nextNodes: AnyMapNode[] = [];

      /** Device payload, shared by both views. */
      const deviceData = (n: TopologyNode, groupKey?: string): MapNodeData => ({
        kind: "device",
        deviceId: n.deviceId,
        name: n.name,
        category: n.category,
        state: n.state,
        reason: n.reason,
        ip: n.ip,
        portLabel: n.portLabel,
        childCount: n.childCount,
        locationName: n.locationName,
        manufacturer: n.manufacturer,
        model: n.model,
        mac: n.mac,
        inRateBps: n.inRateBps,
        outRateBps: n.outRateBps,
        portCount: n.portCount,
        groupKey,
        selected: n.id === inspectedId,
      });

      const pushDevice = (n: TopologyNode, x: number, y: number, groupKey?: string) => {
        const nodeData = deviceData(n, groupKey);
        const prev = prevById.get(n.id);
        if (
          prev &&
          prev.type === "mapNode" &&
          prev.position.x === x &&
          prev.position.y === y &&
          sameNodeData(prev.data, nodeData)
        ) {
          nextNodes.push(prev);
          return;
        }
        const next: MapNodeType = {
          id: n.id,
          type: "mapNode",
          position: { x, y },
          data: nodeData,
        };
        const measured = flowRef.current?.getInternalNode(n.id)?.measured ?? prev?.measured;
        if (measured && measured.width && measured.height) {
          next.measured = { width: measured.width, height: measured.height };
        }
        nextNodes.push(next);
      };

      if (viewMode === "layered") {
        // While a filter is active, open the groups that contain a match so
        // the result is visible without the operator hunting for it.
        const open = new Set(expanded);
        if (filtersActive) {
          for (const n of snapshot.nodes) {
            if (matchesFilter(n)) open.add(n.category);
          }
        }

        const layout = layoutLayered(snapshot.nodes, open);
        const gateway = layout.gateway;

        nextNodes.push({
          id: "internet",
          type: "internetNode",
          position: layout.internetPosition,
          data: {
            kind: "internet",
            deviceId: 0,
            name: "Internet",
            category: "internet",
            state: gateway?.state ?? "UNKNOWN",
            reason: gateway
              ? `The path beyond ${gateway.name} is ${humanise(gateway.state).toLowerCase()}.`
              : "No gateway has been found yet, so the path beyond the network is unknown.",
            ip: null,
            portLabel: null,
            childCount: 0,
            locationName: null,
            manufacturer: "",
            model: "",
            mac: "",
            inRateBps: null,
            outRateBps: null,
            portCount: 0,
          },
          draggable: false,
          selectable: false,
        });

        if (gateway) {
          pushDevice(gateway, layout.gatewayPosition.x, layout.gatewayPosition.y);
        }

        // Tier captions. They are labels, not devices: the counts beside them
        // are the honest structure of THIS network (often: one gateway, no
        // managed switch, every link inferred).
        const switchCount = snapshot.nodes.filter((n) => n.category === "switch").length;
        const apCount = snapshot.nodes.filter((n) => n.category === "access_point").length;
        const gatewayCount = snapshot.nodes.filter(
          (n) => n.category === "router" || n.category === "gateway"
        ).length;
        const endpointCount = snapshot.nodes.length - switchCount - apCount - gatewayCount;
        const verifiedCount = snapshot.edges.filter((e) => e.verified).length;
        const treeLeft = layout.groups[0]?.x ?? -790;
        const firstRowY = layout.groups[0]?.y ?? 300;

        const layerNode = (
          id: string,
          name: string,
          note: string,
          y: number
        ): LayerNodeType => ({
          id,
          type: "layerLabel",
          position: { x: treeLeft - 110, y },
          style: { width: 880, height: 26, pointerEvents: "none" },
          data: {
            kind: "layer",
            deviceId: 0,
            name,
            category: "unknown",
            state: "UNKNOWN",
            reason: note,
            ip: null,
            portLabel: null,
            childCount: 0,
            locationName: null,
            manufacturer: "",
            model: "",
            mac: "",
            inRateBps: null,
            outRateBps: null,
            portCount: 0,
            layerNote: note,
          },
          draggable: false,
          selectable: false,
          zIndex: 0,
        });

        nextNodes.push(
          layerNode(
            "layer-core",
            "CORE LAYER",
            `${gatewayCount} gateway${gatewayCount === 1 ? "" : "s"}`,
            layout.gatewayPosition.y - 78
          ),
          layerNode(
            "layer-distribution",
            "DISTRIBUTION LAYER",
            switchCount + apCount === 0
              ? "no managed switch or access point detected"
              : `${switchCount} switch${switchCount === 1 ? "" : "es"} · ${apCount} access point${
                  apCount === 1 ? "" : "s"
                }`,
            layout.gatewayPosition.y + 205
          ),
          layerNode(
            "layer-access",
            "ACCESS LAYER",
            `${endpointCount} endpoints · ${snapshot.edges.length} links, ${verifiedCount} verified`,
            firstRowY - 38
          )
        );

        // The tinted band behind an open group, drawn before its devices so
        // it sits underneath them.
        for (const group of layout.groups) {
          if (group.collapsed) continue;
          nextNodes.push({
            id: `group-frame-${group.key}`,
            type: "groupFrame",
            position: { x: group.x - 12, y: group.y - 8 },
            style: { width: group.width + 24, height: group.height + 16, pointerEvents: "none" },
            data: {
              kind: "frame",
              deviceId: 0,
              name: "",
              category: group.category,
              state: group.state,
              reason: "",
              ip: null,
              portLabel: null,
              childCount: group.devices.length,
              locationName: null,
              manufacturer: "",
              model: "",
              mac: "",
              inRateBps: null,
              outRateBps: null,
              portCount: 0,
              groupKey: group.key,
            },
            draggable: false,
            selectable: false,
            zIndex: 0,
          });
        }

        for (const n of snapshot.nodes) {
          const position = layout.positions.get(n.id);
          if (!position) continue;
          pushDevice(n, position.x, position.y, n.category);
        }

        for (const group of layout.groups) {
          if (group.devices.length === 0) continue;
          const offline = group.devices.filter(
            (d) => d.state === "OFFLINE" || d.state === "LINK_DOWN"
          ).length;
          const other = group.devices.length - group.online - offline;
          const nodeData: MapNodeData = {
            kind: "group",
            deviceId: 0,
            name: groupLabel(group.category),
            category: group.category,
            state: group.state,
            reason: `${group.devices.length} ${groupLabel(group.category).toLowerCase()}; worst state ${humanise(group.state)}.`,
            ip: `${group.online} online${offline > 0 ? ` · ${offline} offline` : ""}${
              other > 0 ? ` · ${other} other` : ""
            }`,
            portLabel: null,
            childCount: group.devices.length,
            locationName: null,
            manufacturer: "",
            model: "",
            mac: "",
            inRateBps: null,
            outRateBps: null,
            portCount: 0,
            groupKey: group.key,
            groupCount: group.devices.length,
            groupOnline: group.online,
            groupCollapsed: group.collapsed,
            groupOpenWidth: group.openWidth,
            groupOpenHeight: group.openHeight,
          };
          const id = `group-${group.key}`;
          const prev = prevById.get(id);
          const unchanged =
            prev &&
            prev.position.x === group.x &&
            prev.position.y === group.y &&
            prev.style?.width === group.width &&
            prev.style?.height === group.visualHeight &&
            sameNodeData(prev.data, nodeData);
          if (prev && unchanged) {
            nextNodes.push(prev);
          } else {
            nextNodes.push({
              id,
              type: "groupNode",
              position: { x: group.x, y: group.y },
              style: { width: group.width, height: group.visualHeight },
              data: nodeData,
              draggable: false,
            });
          }
        }
      } else {
        for (const n of snapshot.nodes) {
          pushDevice(n, n.x, n.y);
        }
      }

      return nextNodes;
    });

    setEdges((prevEdges) => {
      const prevById = new Map(prevEdges.map((e) => [e.id, e]));

      if (viewMode === "layered") {
        const layout = layoutLayered(snapshot.nodes, expanded);
        const gateway = layout.gateway;
        const nextEdges: CableEdgeType[] = [];
        if (!gateway) return nextEdges;

        const gatewayState = gateway.state;
        nextEdges.push({
          id: "wan",
          source: "internet",
          target: gateway.id,
          sourceHandle: "down",
          targetHandle: "up",
          type: "cable",
          selectable: false,
          focusable: false,
          data: {
            tone:
              gatewayState === "ONLINE"
                ? "ok"
                : gatewayState === "NO_INTERNET"
                  ? "purple"
                  : gatewayState === "OFFLINE"
                    ? "danger"
                    : "muted",
            physical: "unknown",
            label: "WAN",
            rateLabel: "",
            flowing: false,
            grouped: true,
          },
        });

        for (const group of layout.groups) {
          if (group.devices.length === 0) continue;
          nextEdges.push({
            id: `group-edge-${group.key}`,
            source: gateway.id,
            target: `group-${group.key}`,
            sourceHandle: "down",
            targetHandle: "left",
            type: "cable",
            selectable: false,
            focusable: false,
            data: {
              tone: "muted",
              physical: "unknown",
              label: `${group.devices.length} ${groupLabel(group.category).toLowerCase()}`,
              rateLabel: "",
              flowing: false,
              grouped: true,
            },
          });
        }

        return nextEdges;
      }

      return snapshot.edges.map((e) => {
        const hasRate = e.inRateBps !== null || e.outRateBps !== null;
        const rateLabel = hasRate
          ? `↑ ${formatBandwidth(e.outRateBps)} ↓ ${formatBandwidth(e.inRateBps)}`
          : "traffic not counted";
        const flowing =
          e.state === "up" && (e.inRateBps ?? 0) + (e.outRateBps ?? 0) > 0;
        const ports = [e.sourcePort || "?", e.targetPort || "?"];
        const nextEdge: CableEdgeType = {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: "out",
          targetHandle: "in",
          type: "cable",
          selected: e.id === selectedEdgeId,
          data: {
            tone: cableTone(e, internetDown, stateById),
            physical: e.physicalState,
            label: ports.join("  →  "),
            rateLabel,
            // Short, bright dashes mean measured traffic is flowing right now.
            flowing,
            // A confirmed-up link with no counters still shows life, with a
            // slow, dim drift that cannot be mistaken for a throughput figure.
            linked: e.state === "up" && !flowing,
            forceLabel: showLabels,
          },
        };
        const prev = prevById.get(e.id);
        if (prev && edgeSignature(prev) === edgeSignature(nextEdge)) {
          return prev;
        }
        return nextEdge;
      });
    });
  }, [
    data,
    setNodes,
    setEdges,
    inspectedId,
    selectedEdgeId,
    showLabels,
    viewMode,
    expanded,
    query,
    healthFilter,
    categoryFilter,
  ]);

  /*
   * The snapshot arrives after the canvas has mounted, so the `fitView` prop
   * has nothing to fit on the first paint. Fit once, after the nodes exist and
   * have been measured, so a hundred-device map opens as a whole web rather
   * than a corner of one.
   */
  useEffect(() => {
    if (fittedRef.current || nodes.length === 0) return;
    const timer = setTimeout(() => {
      flowRef.current?.fitView({ padding: 0.14, maxZoom: 0.85, duration: 400 });
      fittedRef.current = true;
    }, 450);
    return () => clearTimeout(timer);
  }, [nodes.length]);

  /**
   * Fit the view once React Flow has measured the nodes it is about to fit.
   *
   * `fitView()` silently keeps the current viewport when the nodes it should
   * fit have no boxes yet, which is exactly the state right after a group is
   * opened. Poll the instance until every node has a measured size, then fit.
   */
  const fitWhenMeasured = useCallback((padding = 0.16, maxZoom = 0.9) => {
    let attempts = 0;
    const attempt = () => {
      const instance = flowRef.current;
      if (!instance) return;
      const all = instance.getNodes();
      const ready =
        all.length > 0 && all.every((n) => (n.measured?.width ?? 0) > 0 && (n.measured?.height ?? 0) > 0);
      if (ready || attempts >= 24) {
        instance.fitView({ padding, maxZoom, duration: 420 });
        return;
      }
      attempts += 1;
      window.setTimeout(attempt, 140);
    };
    attempt();
  }, []);

  /** Select a node, then ask the server for its upstream path. */
  const selectDevice = useCallback(async (nodeId: string, nodeData: MapNodeData) => {
    setSelected({ id: nodeId, data: nodeData });
    setSelectedEdgeId(null);
    setEvidence(null);
    setTracing(true);
    setTrace(null);
    try {
      const res = await apiGet<TopologyPayload>(
        `/api/topology?trace=${encodeURIComponent(String(nodeData.deviceId ?? ""))}`
      );
      setTrace(res.trace ?? null);
    } catch {
      setTrace(null);
    } finally {
      setTracing(false);
    }

    // The evidence sentence is supplementary: a failed detail fetch must not
    // take the trace down with it.
    if (nodeData.deviceId) {
      try {
        const detail = await apiGet<{
          device: {
            classificationEvidence: string;
            discoverySource: string;
            classificationConfidence: string;
          };
        }>(`/api/devices/${nodeData.deviceId}`);
        setEvidence({
          text: detail.device.classificationEvidence,
          source: detail.device.discoverySource,
          confidence: detail.device.classificationConfidence,
        });
      } catch {
        setEvidence(null);
      }
    }
  }, []);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: AnyMapNode) => {
      if (node.data.kind === "group" && node.data.groupKey) {
        const key = node.data.groupKey;
        const opening = !expanded.has(key);
        setSelected(null);
        setSelectedEdgeId(null);
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        /*
         * Opening a row frames THAT row and its devices, not the whole tree:
         * fitting all five groups at once shrinks a 49-camera grid to
         * unreadable specks. Closing returns to the overview.
         */
        if (opening) {
          /*
           * Keep the row readable and keep the hierarchy in frame: the trunk,
           * gateway and layer captions live in a gutter to the left of the
           * rows. A wide grid (49 cameras) is allowed to give up a little
           * zoom so that gutter and every column still fit; fitting the whole
           * tree instead shrinks the icons to unreadable specks.
           */
          window.setTimeout(() => {
            const instance = flowRef.current;
            if (!instance) return;
            const pane = document.querySelector(".map-canvas .react-flow");
            const paneWidth = pane instanceof HTMLElement ? pane.clientWidth : 1100;
            const gutter = 300;
            const openWidth = node.data.groupOpenWidth ?? 760;
            const fitZoom = (paneWidth - 24) / (openWidth + gutter);
            const zoom = Math.min(0.9, Math.max(0.5, Math.min(instance.getZoom(), fitZoom)));
            const contentWidth = (openWidth + gutter) * zoom;
            const leftWorld = node.position.x - gutter;
            const x =
              contentWidth <= paneWidth - 24
                ? (paneWidth - contentWidth) / 2 - leftWorld * zoom
                : 12 - leftWorld * zoom;
            /* Keep the internet edge itself on screen, not just the row. */
            const internetY =
              nodes.find((candidate) => candidate.data.kind === "internet")?.position.y ?? -190;
            const y = 14 - internetY * zoom;
            instance.setViewport({ x, y, zoom }, { duration: 420 });
          }, 260);
        } else {
          window.setTimeout(() => fitWhenMeasured(0.16, 0.9), 300);
          window.setTimeout(() => fitWhenMeasured(0.16, 0.9), 1600);
        }
        return;
      }
      if (node.data.kind === "internet") {
        const gateway = nodes.find(
          (n) => n.data.kind === "device" && n.data.category === "router"
        );
        if (gateway) void selectDevice(gateway.id, gateway.data);
        return;
      }
      /* Captions and group frames are structure, never inventory. */
      if (node.data.kind !== "device") return;
      void selectDevice(node.id, node.data);
    },
    [selectDevice, nodes, fitWhenMeasured, expanded]
  );

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: CableEdgeType) => {
    /* Grouped connectors are a summary of the tree, not a cable. */
    if (edge.data?.grouped) return;
    setSelectedEdgeId(edge.id);
  }, []);

  /**
   * Deep link from an alert: /map?focus=<deviceId>.
   *
   * Read once from window.location rather than useSearchParams so the route
   * stays statically prerenderable. The value never affects the markup, so a
   * server render of `null` and a client read of the real id cannot cause a
   * hydration mismatch — it only drives the effect below.
   */
  const [focusId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("focus");
    if (!raw) return null;
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  });

  const focusApplied = useRef(false);
  useEffect(() => {
    if (!focusId || focusApplied.current) return;
    // In the grouped view the device may still be inside a closed row: open
    // its category first, then the layouts and the focus can both find it.
    const target = data?.snapshot.nodes.find((n) => n.deviceId === focusId);
    if (viewMode === "layered" && target && target.category !== "router") {
      if (!expanded.has(target.category)) {
        queueMicrotask(() =>
          setExpanded((prev) => new Set(prev).add(target.category))
        );
        return;
      }
    }
    const node = nodes.find((n) => n.data.deviceId === focusId && n.data.kind === "device");
    if (!node) return;
    focusApplied.current = true;
    // The camera and the selection both need the measured graph, which only
    // exists after the first snapshot lands. Deferring by a microtask keeps
    // this out of the commit phase (and out of a cascading render).
    queueMicrotask(() => {
      void selectDevice(node.id, node.data);
      flowRef.current?.fitView({
        nodes: [{ id: node.id }],
        duration: 700,
        maxZoom: 1.1,
        padding: 1.6,
      });
    });
  }, [focusId, nodes, selectDevice, data, viewMode, expanded]);

  /** Persist one dragged node. Failure is reported, never hidden. */
  const savePosition = useCallback(async (deviceId: number, x: number, y: number) => {
    try {
      await apiPost("/api/topology", { positions: [{ deviceId, x, y }] });
      setLayoutMsg("Layout saved");
    } catch (err) {
      setLayoutMsg(err instanceof Error ? err.message : "The position could not be saved.");
    }
  }, []);

  const resetLayout = useCallback(async () => {
    try {
      await apiPost("/api/topology", { reset: true });
      setLayoutMsg("Layout reset to automatic");
      reload();
    } catch (err) {
      setLayoutMsg(err instanceof Error ? err.message : "The layout could not be reset.");
    }
  }, [reload]);

  /** The filters, applied to what the canvas shows — never to the data. */
  const visibleNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const active = q.length > 0 || healthFilter !== "all" || categoryFilter !== "all";
    if (!active) return nodes;

    const matchingDevices = new Set<string>();
    for (const n of nodes) {
      if (n.data.kind !== "device") continue;
      const d = n.data;
      if (healthFilter !== "all" && d.state !== healthFilter) continue;
      if (categoryFilter !== "all" && d.category !== categoryFilter) continue;
      if (q) {
        const haystack = [d.name, d.ip, d.category, d.portLabel, d.locationName, d.manufacturer, d.model, d.mac]
          .filter((v): v is string => Boolean(v))
          .some((v) => v.toLowerCase().includes(q));
        if (!haystack) continue;
      }
      matchingDevices.add(n.id);
    }

    const groupsWithMatch = new Set<string>();
    for (const n of nodes) {
      if (n.data.kind === "device" && matchingDevices.has(n.id) && n.data.groupKey) {
        groupsWithMatch.add(n.data.groupKey);
      }
    }

    return nodes.filter((n) => {
      if (n.data.kind === "device") {
        // The gateway anchors both views; hiding it would orphan every edge.
        if (n.data.category === "router" || n.data.category === "gateway") return true;
        return matchingDevices.has(n.id);
      }
      if (n.data.kind === "group") return groupsWithMatch.has(n.data.groupKey ?? "");
      if (n.data.kind === "frame") return groupsWithMatch.has(n.data.groupKey ?? "");
      return true;
    });
  }, [nodes, query, healthFilter, categoryFilter]);

  const visibleEdges = useMemo(() => {
    const keep = new Set(visibleNodes.map((n) => n.id));
    return edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }, [edges, visibleNodes]);

  if (loading && !data) return <Loading label="Building the live map…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  const snapshot = data.snapshot;
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const gatewayCount = snapshot.nodes.filter(
    (n) => n.category === "router" || n.category === "gateway"
  ).length;
  const switchCount = snapshot.nodes.filter((n) => n.category === "switch").length;
  const apCount = snapshot.nodes.filter((n) => n.category === "access_point").length;
  const endpointCount = snapshot.nodes.length - gatewayCount - switchCount - apCount;
  const verifiedLinkCount = snapshot.edges.filter((e) => e.verified).length;
  const selectedEdge =
    selectedEdgeId === null
      ? null
      : snapshot.edges.find((e) => e.id === selectedEdgeId) ?? null;
  const canEdit = can("can_edit_inventory");
  const filtered = visibleNodes.length !== nodes.length || visibleEdges.length !== edges.length;
  const visibleDeviceCount = visibleNodes.filter(
    (n) => n.data.kind === "device" && n.data.category !== "router"
  ).length;
  const edgeTone = selectedEdge
    ? cableTone(
        selectedEdge,
        snapshot.nodes.some((n) => n.state === "NO_INTERNET"),
        new Map(snapshot.nodes.map((n) => [n.id, n.state]))
      )
    : null;
  const edgeTypeLabel =
    selectedEdge?.connectionType === "wan"
      ? "WAN"
      : humanise(selectedEdge?.connectionType ?? "unknown");

  return (
    <>
      <PageHeader
        title="Live Map"
        description="Automap draws this network in layers: the internet edge, the gateway, then every endpoint grouped by equipment type. Open a group to see each device, its link state and any measured speed."
        actions={
          <>
            {snapshot.simulated ? (
              <Chip tone="purple">SIMULATED TOPOLOGY</Chip>
            ) : (
              <Chip tone="muted">LIVE · AUTO-DISCOVERED</Chip>
            )}
            <span
              className="chip chip--muted"
              title={`${gatewayCount} gateway(s), ${switchCount} managed switch(es), ${apCount} access point(s) · ${snapshot.edges.length} links, ${verifiedLinkCount} confirmed by a managed port`}
            >
              {gatewayCount} gateway · {endpointCount} endpoints
            </span>
            <span
              className="chip chip--muted"
              title={
                verifiedLinkCount === 0
                  ? "No managed port has confirmed a link, so every cable is drawn as unverified (grey)."
                  : `${verifiedLinkCount} of ${snapshot.edges.length} links are confirmed by a managed port.`
              }
            >
              {verifiedLinkCount} verified links
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={reload}>
              <Icon name="refresh" size={13} />
              Refresh
            </button>
          </>
        }
      />

      {snapshot.simulated ? (
        <div className="mb-4">
          <Notice tone="warn" title="This map is labelled as simulated">
            The estate shown here was produced by the built-in simulator. It is not a
            representation of real hardware unless you have replaced it with a real discovery.
          </Notice>
        </div>
      ) : null}

      {snapshot.nodes.length > 0 &&
      !snapshot.nodes.some((n) => n.inRateBps !== null || n.outRateBps !== null) ? (
        <p className="mb-3 flex items-center gap-2 text-xs text-muted">
          <Icon name="traffic" size={14} />
          <span>
            Link state is measured. Per-device speeds need an SNMP counter — add one on{" "}
            <Link href="/discovery" className="text-neon underline-offset-2 hover:underline">
              Discovery
            </Link>
            . This machine is always measured.
          </span>
        </p>
      ) : null}

      <div className="relative">
        <div className="min-w-0 space-y-3">
          {/* Controls: search, filters, and the canvas switches. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">
                <Icon name="search" size={14} />
              </span>
              <input
                type="search"
                className="field pl-8"
                placeholder="Find a device, IP, port or location…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search the map"
                autoComplete="off"
              />
            </div>
            <select
              className="field field--compact"
              value={healthFilter}
              onChange={(e) => setHealthFilter(e.target.value)}
              aria-label="Filter by health state"
              autoComplete="off"
            >
              <option value="all">All states</option>
              {HEALTH_STATES.map((s) => (
                <option key={s} value={s}>
                  {humanise(s)}
                </option>
              ))}
            </select>
            <select
              className="field field--compact"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label="Filter by equipment type"
              autoComplete="off"
            >
              <option value="all">All equipment</option>
              {DEVICE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanise(c)}
                </option>
              ))}
            </select>
            {filtered ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setQuery("");
                  setHealthFilter("all");
                  setCategoryFilter("all");
                }}
              >
                Clear filters
              </button>
            ) : null}
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5">
              <button
                type="button"
                className={`btn btn--sm ${viewMode === "layered" ? "btn--active" : "btn--ghost"}`}
                aria-pressed={viewMode === "layered"}
                title="Group devices by equipment type, one row per group."
                onClick={() => {
                  setViewMode("layered");
                  window.setTimeout(() => fitWhenMeasured(0.16, 0.9), 300);
                  window.setTimeout(() => fitWhenMeasured(0.16, 0.9), 1500);
                }}
              >
                Grouped
              </button>
              <button
                type="button"
                className={`btn btn--sm ${viewMode === "links" ? "btn--active" : "btn--ghost"}`}
                aria-pressed={viewMode === "links"}
                title="Draw every device link individually."
                onClick={() => {
                  setViewMode("links");
                  window.setTimeout(() => fitWhenMeasured(0.14, 0.85), 300);
                  window.setTimeout(() => fitWhenMeasured(0.14, 0.85), 1500);
                }}
              >
                All links
              </button>
            </div>
            {viewMode === "layered" ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  if (expanded.size > 0) {
                    setExpanded(new Set());
                    window.setTimeout(() => fitWhenMeasured(0.16, 0.9), 300);
                  } else {
                    setExpanded(
                      new Set(
                        snapshot.nodes
                          .map((n) => n.category)
                          .filter((c) => c !== "router" && c !== "gateway")
                      )
                    );
                    /* Opening every row is a browsing action: keep the
                     * operator's current viewport instead of yanking the map
                     * to a fit that is either microscopic or cropped. */
                  }
                }}
              >
                {expanded.size > 0 ? "Collapse all" : "Expand all"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-pressed={showLabels}
                  title="Show every port label at once. Off by default to keep the canvas readable."
                  onClick={() => setShowLabels((v) => !v)}
                >
                  Port labels {showLabels ? "on" : "off"}
                </button>
                {canEdit ? (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={resetLayout}>
                    Reset layout
                  </button>
                ) : null}
              </>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => fitWhenMeasured(0.14, 1.2)}
            >
              Fit to screen
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-pressed={showLegend}
              onClick={() => setShowLegend((v) => !v)}
            >
              Legend
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-pressed={showMiniMap}
              onClick={() => setShowMiniMap((v) => !v)}
            >
              Minimap {showMiniMap ? "on" : "off"}
            </button>
          </div>

          {filtered ? (
            <p className="text-xs text-muted">
              Showing {visibleNodes.filter((n) => n.data.kind === "device").length} of{" "}
              {snapshot.nodes.length} devices.
            </p>
          ) : null}

          {visibleDeviceCount === 0 && filtered ? (
            <Notice tone="info" title="No device matches those filters">
              Clear the search or the filters to bring the topology back.
            </Notice>
          ) : null}

          {/*
            The canvas needs a DEFINITE height, not a percentage of an
            auto-sized parent. The panel owns the height (72vh, floor 520px);
            the body fills it; the graph fills the body. Break any link in
            that chain and React Flow refuses to render a graph at all.
          */}
          <Panel
            className="h-[calc(100vh-15rem)] min-h-[540px] overflow-hidden p-0"
            bodyClassName="h-full w-full p-0"
          >
            <div
              className={`map-canvas map-canvas--${zoomBand} h-full w-full ${
                filtered ? "map-canvas--filtered" : ""
              }`}
            >
              <ReactFlow
                nodes={visibleNodes}
                edges={visibleEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                onEdgeClick={onEdgeClick}
                onMove={(_, viewport) => {
                  const band =
                    viewport.zoom < 0.55 ? "far" : viewport.zoom < 1 ? "mid" : "near";
                  setZoomBand((prev) => (prev === band ? prev : band));
                }}
                onPaneClick={() => {
                  setSelected(null);
                  setSelectedEdgeId(null);
                }}
                onNodeDragStop={(_, node) => {
                  if (!canEdit) return;
                  void savePosition(node.data.deviceId, node.position.x, node.position.y);
                }}
                nodesDraggable={canEdit && viewMode === "links"}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={(instance) => {
                  flowRef.current = instance;
                }}
                fitView
                fitViewOptions={{ padding: 0.14, maxZoom: 0.85 }}
                minZoom={0.04}
              >
                <Background color="rgba(74, 20, 140, 0.25)" gap={24} />
                <Controls />
                {/*
                  React Flow measures nodes with a ResizeObserver, and browsers
                  stop delivering those notifications to a page that is not
                  visible. Without this the canvas stays blank in a background
                  tab: the nodes never get a box, so they stay hidden and the
                  edges have no anchors. See MapNodeMeasurer for the details.
                */}
                <MapNodeMeasurer />
                {showMiniMap ? (
                  <MiniMap
                    position="top-right"
                    pannable
                    zoomable
                    bgColor="rgba(10, 8, 18, 0.92)"
                    maskColor="rgba(6, 5, 10, 0.74)"
                    nodeColor={(n) =>
                      n.type === "groupFrame" || n.type === "layerLabel"
                        ? "transparent"
                        : stateColour(n.data?.state as string)
                    }
                    nodeStrokeColor={(n) =>
                      n.type === "groupFrame" || n.type === "layerLabel"
                        ? "transparent"
                        : "rgba(255, 255, 255, 0.22)"
                    }
                    nodeBorderRadius={4}
                    style={{ width: 168, height: 112, borderRadius: 10 }}
                  />
                ) : null}
              </ReactFlow>
            </div>
          </Panel>

          {layoutMsg ? (
            <p className="text-xs text-muted" role="status">
              {layoutMsg}
            </p>
          ) : null}
        </div>

        {selected || selectedEdge || showLegend ? (
          <div className="map-dock space-y-3">
            <button
              type="button"
              className="map-dock__close"
              onClick={() => {
                setSelected(null);
                setSelectedEdgeId(null);
                setShowLegend(false);
              }}
            >
              Close
            </button>
          {selectedEdge ? (
            <Panel title="Connection">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-base font-semibold text-white">
                      {selectedEdge.sourcePort || "unknown port"}
                      <span className="px-1.5 text-muted">→</span>
                      {selectedEdge.targetPort || "unknown port"}
                    </div>
                    <div className="text-xs text-muted">
                      {edgeTypeLabel} · {selectedEdge.cableId || "no cable ID recorded"}
                    </div>
                  </div>
                  <Chip
                    tone={
                      selectedEdge.state === "down"
                        ? "danger"
                        : selectedEdge.state === "degraded"
                          ? "warn"
                          : selectedEdge.state === "unknown"
                            ? "muted"
                            : "neon"
                    }
                  >
                    {humanise(selectedEdge.state)}
                  </Chip>
                </div>

                <KeyValue
                  items={[
                    {
                      label: "From",
                      value: `${nodeById.get(selectedEdge.source)?.name ?? selectedEdge.source} · ${
                        selectedEdge.sourcePort || "port unknown"
                      }`,
                    },
                    {
                      label: "To",
                      value: `${nodeById.get(selectedEdge.target)?.name ?? selectedEdge.target} · ${
                        selectedEdge.targetPort || "port unknown"
                      }`,
                    },
                    {
                      label: "Physical link",
                      value: humanise(selectedEdge.physicalState),
                    },
                    {
                      label: "Link speed",
                      value:
                        selectedEdge.speedBps === null
                          ? "Not reported"
                          : formatBandwidth(selectedEdge.speedBps),
                    },
                    {
                      label: "Down / in",
                      value: `${formatBandwidth(selectedEdge.inRateBps)}${
                        selectedEdge.rateSource === "device" ? " (device total)" : ""
                      }`,
                    },
                    {
                      label: "Up / out",
                      value: `${formatBandwidth(selectedEdge.outRateBps)}${
                        selectedEdge.rateSource === "device" ? " (device total)" : ""
                      }`,
                    },
                    {
                      label: "Errors (in / out)",
                      value:
                        selectedEdge.inErrors === null && selectedEdge.outErrors === null
                          ? "Not reported"
                          : `${selectedEdge.inErrors ?? "—"} / ${selectedEdge.outErrors ?? "—"}`,
                    },
                    {
                      label: "Discards (in / out)",
                      value:
                        selectedEdge.inDiscards === null && selectedEdge.outDiscards === null
                          ? "Not reported"
                          : `${selectedEdge.inDiscards ?? "—"} / ${selectedEdge.outDiscards ?? "—"}`,
                    },
                    { label: "Discovered by", value: humanise(selectedEdge.sourceType) },
                    {
                      label: "Confidence",
                      value: `${Math.round(selectedEdge.confidence * 100)}%${
                        selectedEdge.verified ? " · verified by an operator" : ""
                      }`,
                    },
                    {
                      label: "Last observed",
                      value:
                        selectedEdge.lastObservedAt === null
                          ? "Never"
                          : timeAgo(selectedEdge.lastObservedAt),
                    },
                    {
                      label: "Cable destination",
                      value: selectedEdge.cableDestination || "Not documented",
                    },
                  ]}
                />

                <Evidence>{selectedEdge.evidence}</Evidence>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Link
                    href={`/devices/${nodeById.get(selectedEdge.source)?.deviceId ?? ""}`}
                    className="btn btn--ghost btn--sm"
                  >
                    Open {nodeById.get(selectedEdge.source)?.name ?? "source"}
                  </Link>
                  <Link
                    href={`/devices/${nodeById.get(selectedEdge.target)?.deviceId ?? ""}`}
                    className="btn btn--ghost btn--sm"
                  >
                    Open {nodeById.get(selectedEdge.target)?.name ?? "target"}
                  </Link>
                </div>
                {edgeTone === "purple" ? (
                  <p className="text-xs leading-relaxed text-muted">
                    The cable is physically up and still carries local traffic. Purple describes
                    the whole path, not the copper.
                  </p>
                ) : null}
              </div>
            </Panel>
          ) : (
            <Panel title="Inspector">
              {selected ? (
                <div className="space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-violet">
                      <DeviceGlyph
                        category={selected.data.category}
                        size={44}
                        led={stateColour(selected.data.state)}
                      />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold text-white">
                        {selected.data.name}
                      </div>
                      <div className="text-xs text-muted">{humanise(selected.data.category)}</div>
                    </div>
                  </div>
                  <StateBadge state={selected.data.state} />
                  {selected.data.state === "NO_INTERNET" ? (
                    <Notice
                      tone="warn"
                      title="Physical link active. External internet connectivity checks are failing."
                    >
                      This device is still reachable on the local network. Only its path to the
                      internet is failing, so local links stay green.
                    </Notice>
                  ) : null}
                  <KeyValue
                    items={[
                      { label: "IP", value: selected.data.ip || "—" },
                      { label: "Type", value: humanise(selected.data.category) },
                      { label: "Manufacturer", value: selected.data.manufacturer || "Not identified" },
                      { label: "Model", value: selected.data.model || "Not reported" },
                      { label: "MAC", value: selected.data.mac || "Not recorded" },
                      { label: "Location", value: selected.data.locationName || "—" },
                      { label: "Ports", value: `${selected.data.portCount}` },
                      { label: "Downstream", value: `${selected.data.childCount} device(s)` },
                      { label: "Connected via", value: selected.data.portLabel || "—" },
                      {
                        label: "Up speed",
                        value: formatBandwidth(selected.data.outRateBps),
                      },
                      {
                        label: "Down speed",
                        value: formatBandwidth(selected.data.inRateBps),
                      },
                    ]}
                  />
                  <p className="text-xs leading-relaxed text-muted">{selected.data.reason}</p>
                  {evidence?.text ? (
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
                      <div className="text-[0.6rem] font-semibold tracking-[0.12em] text-muted uppercase">
                        Why this type
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-white/85">{evidence.text}</p>
                      <p className="mt-1 text-[0.6rem] text-muted">
                        {humanise(evidence.source)} · {evidence.confidence} confidence
                      </p>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Link
                      href={`/devices/${selected.data.deviceId}`}
                      className="btn btn--ghost btn--sm"
                    >
                      Open device detail
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  Click a device for its diagnostics, or a cable for its connection record.
                </p>
              )}
            </Panel>
          )}

          <Panel title="Upstream path trace">
            {tracing ? (
              <p className="text-sm text-muted">Tracing path…</p>
            ) : trace ? (
              <div className="space-y-2">
                <p className="text-sm leading-relaxed text-white">{trace.path}</p>
                {trace.brokenSegment ? (
                  <Notice tone="danger">
                    The first broken segment is at device{" "}
                    <Link
                      href={`/devices/${trace.brokenSegment.deviceId}`}
                      className="font-semibold hover:underline"
                    >
                      #{trace.brokenSegment.deviceId}
                    </Link>{" "}
                    (link state: {trace.brokenSegment.state}).
                  </Notice>
                ) : (
                  <Chip tone="neon">Path reaches the root with no known down link</Chip>
                )}
                <ol className="space-y-1.5">
                  {trace.steps.map((step, idx) => (
                    <li key={idx} className="flex items-center gap-2 text-sm">
                      <span className="text-[0.6rem] text-muted">{idx + 1}</span>
                      <span className="text-white">{step.device.name}</span>
                      <span className="text-xs text-muted">({humanise(step.state)})</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : selected ? (
              <p className="text-sm text-muted">No trace could be resolved from the known connections.</p>
            ) : (
              <p className="text-sm text-muted">Select a node to trace its upstream path.</p>
            )}
          </Panel>

          <Panel title="Cable colours">
            <ul className="space-y-2 text-xs">
              <li className="flex gap-2">
                <span className="cable-swatch" style={{ background: STATE_COLOUR.ONLINE }} />
                <span>
                  <strong className="text-white">Green — healthy.</strong> The link is up and the
                  configured checks pass. Pulses move only when real counters show traffic.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="cable-swatch" style={{ background: STATE_COLOUR.NO_INTERNET }} />
                <span>
                  <strong className="text-white">Purple — link up, internet unavailable.</strong>{" "}
                  The cable carries local traffic; the failure is beyond it.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="cable-swatch" style={{ background: STATE_COLOUR.OFFLINE }} />
                <span>
                  <strong className="text-white">Red — confirmed failure.</strong> A managed port
                  reports the link down, or an endpoint failed its checks.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="cable-swatch cable-swatch--dashed" style={{ color: STATE_COLOUR.DEGRADED }} />
                <span>
                  <strong className="text-white">Amber — degraded.</strong> Errors, discards,
                  utilisation or latency beyond the configured threshold.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="cable-swatch cable-swatch--dotted" style={{ color: "#8a93a0" }} />
                <span>
                  <strong className="text-white">Grey — not verified.</strong> Nothing has
                  confirmed this connection, so it is never shown as healthy.
                </span>
              </li>
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              An <strong className="text-white">×</strong> on a cable means a managed port
              reports the physical link down; a small grey ring means the link state was never
              confirmed. Hover or select a cable to see its ports and physical state.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Motion has two speeds. <strong className="text-white">Bright, fast dashes</strong>{" "}
              are measured traffic. <strong className="text-white">Dim, slow dots</strong> mean
              the link is confirmed up but nothing counts its bytes — the state is real, the
              speed is not known.
            </p>
            {snapshot.lastObservationAt ? (
              <p className="mt-2 text-xs text-muted">
                Newest observation: {timeAgo(snapshot.lastObservationAt)}
              </p>
            ) : null}
          </Panel>
          </div>
        ) : null}
      </div>
    </>
  );
}

