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
  type TopologySnapshot,
} from "@/lib/types";

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
    default:
      return "";
  }
}

function MapNode({ data }: NodeProps<MapNodeType>) {
  return (
    <div
      className={`map-node ${data.selected ? "map-node--selected" : ""} ${nodeStateClass(
        data.state
      )}`}
      title={`${data.name} — ${data.state}: ${data.reason}`}
      aria-label={`${data.name}, ${humanise(data.category)}, state ${humanise(data.state)}`}
    >
      {/*
        React Flow attaches an edge to a HANDLE, not to the node itself. A
        custom node type that renders no handles can never be the source or
        the target of an edge — the links silently fail to appear. One
        target on the left and one source on the right is what makes the
        cables draw.
      */}
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />

      <div className="map-node__body">
        <span className="map-node__glyph">
          <DeviceGlyph
            category={data.category}
            size={40}
            led={stateColour(data.state)}
            title={`${humanise(data.category)} illustration`}
          />
        </span>
        <span className="map-node__text">
          <span className="map-node__name">{data.name}</span>
          <span className="map-node__kind">
            {humanise(data.category)}
            {data.ip ? <span className="map-node__ip"> · {data.ip}</span> : null}
          </span>
          <span className="map-node__foot">
            <span
              className="map-node__led"
              style={{ background: stateColour(data.state) }}
              aria-hidden="true"
            />
            <span className="map-node__state">{humanise(data.state)}</span>
          </span>
        </span>
      </div>

      {data.portLabel || data.childCount > 0 ? (
        <div className="map-node__meta">
          {data.portLabel ? <span className="map-node__port">via {data.portLabel}</span> : null}
          {data.childCount > 0 ? (
            <span className="map-node__children">
              {data.childCount} below
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes: NodeTypes = { mapNode: MapNode };
const edgeTypes: EdgeTypes = { cable: CableEdge };

/**
 * True when two node payloads describe exactly the same thing.
 *
 * Used to decide whether a polled node can keep its previous object identity.
 */
function sameNodeData(a: MapNodeData, b: MapNodeData): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.name === b.name &&
    a.category === b.category &&
    a.state === b.state &&
    a.reason === b.reason &&
    a.ip === b.ip &&
    a.portLabel === b.portLabel &&
    a.childCount === b.childCount &&
    a.locationName === b.locationName &&
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
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CableEdgeType>([]);
  const [selected, setSelected] = useState<{ id: string; data: MapNodeData } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [tracing, setTracing] = useState(false);

  // Canvas controls
  const [query, setQuery] = useState("");
  const [healthFilter, setHealthFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [layoutMsg, setLayoutMsg] = useState<string | null>(null);

  /**
   * The React Flow instance, captured on init. It is the public handle on the
   * flow's internal state (including the measured size of every node).
   */
  const flowRef = useRef<ReactFlowInstance<MapNodeType, CableEdgeType> | null>(null);
  const inspectedId = selected?.id ?? null;

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

    setNodes((prevNodes) => {
      const prevById = new Map(prevNodes.map((n) => [n.id, n]));
      const nextNodes: MapNodeType[] = [];

      for (const n of snapshot.nodes) {
        const nodeData: MapNodeData = {
          deviceId: n.deviceId,
          name: n.name,
          category: n.category,
          state: n.state,
          reason: n.reason,
          ip: n.ip,
          portLabel: n.portLabel,
          childCount: n.childCount,
          locationName: n.locationName,
          selected: n.id === inspectedId,
        };

        const prev = prevById.get(n.id);
        const unchanged =
          prev !== undefined &&
          prev.position.x === n.x &&
          prev.position.y === n.y &&
          sameNodeData(prev.data, nodeData);

        if (prev && unchanged) {
          // Same object identity -> React Flow keeps its measurement.
          nextNodes.push(prev);
          continue;
        }

        const next: MapNodeType = {
          id: n.id,
          type: "mapNode",
          position: { x: n.x, y: n.y },
          data: nodeData,
        };

        // The flow's internal node holds the live measured dimensions.
        const measured = flowRef.current?.getInternalNode(n.id)?.measured ?? prev?.measured;
        if (measured && measured.width && measured.height) {
          next.measured = { width: measured.width, height: measured.height };
        }
        nextNodes.push(next);
      }

      return nextNodes;
    });

    setEdges((prevEdges) => {
      const prevById = new Map(prevEdges.map((e) => [e.id, e]));
      return snapshot.edges.map((e) => {
        const hasRate = e.inRateBps !== null || e.outRateBps !== null;
        const rateLabel = hasRate
          ? `↑ ${formatBandwidth(e.outRateBps)} ↓ ${formatBandwidth(e.inRateBps)}`
          : "traffic unavailable";
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
            // Only measured traffic animates. A link with no counters stays
            // still even when it is perfectly healthy.
            flowing:
              e.state === "up" &&
              (e.inRateBps ?? 0) + (e.outRateBps ?? 0) > 0,
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
  }, [data, setNodes, setEdges, inspectedId, selectedEdgeId, showLabels]);

  /** Select a node, then ask the server for its upstream path. */
  const selectDevice = useCallback(async (nodeId: string, nodeData: MapNodeData) => {
    setSelected({ id: nodeId, data: nodeData });
    setSelectedEdgeId(null);
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
  }, []);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: MapNodeType) => {
      void selectDevice(node.id, node.data);
    },
    [selectDevice]
  );

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: CableEdgeType) => {
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
    const node = nodes.find((n) => n.data.deviceId === focusId);
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
  }, [focusId, nodes, selectDevice]);

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
    return nodes.filter((n) => {
      const d = n.data;
      if (healthFilter !== "all" && d.state !== healthFilter) return false;
      if (categoryFilter !== "all" && d.category !== categoryFilter) return false;
      if (!q) return true;
      return [d.name, d.ip, d.category, d.portLabel, d.locationName]
        .filter((v): v is string => Boolean(v))
        .some((v) => v.toLowerCase().includes(q));
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
  const selectedEdge =
    selectedEdgeId === null
      ? null
      : snapshot.edges.find((e) => e.id === selectedEdgeId) ?? null;
  const canEdit = can("can_edit_inventory");
  const filtered = visibleNodes.length !== nodes.length || visibleEdges.length !== edges.length;
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
        description="Individual devices and physical links. Click a device for its diagnostics, or a cable for its connection record."
        actions={
          <>
            {snapshot.simulated ? (
              <Chip tone="purple">SIMULATED TOPOLOGY</Chip>
            ) : (
              <Chip tone="muted">REAL TOPOLOGY</Chip>
            )}
            <span className="chip chip--muted">
              {snapshot.nodes.length} devices · {snapshot.edges.length} links
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

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-3">
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
              className="field w-auto"
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
              className="field w-auto"
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
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => flowRef.current?.fitView({ duration: 500, padding: 0.25 })}
            >
              Fit to screen
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-pressed={showMiniMap}
              onClick={() => setShowMiniMap((v) => !v)}
            >
              Minimap {showMiniMap ? "on" : "off"}
            </button>
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
          </div>

          {filtered ? (
            <p className="text-xs text-muted">
              Showing {visibleNodes.length} of {nodes.length} devices and {visibleEdges.length} of{" "}
              {edges.length} links.
            </p>
          ) : null}

          {visibleNodes.length === 0 ? (
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
            className="h-[72vh] min-h-[520px] overflow-hidden p-0"
            bodyClassName="h-full w-full p-0"
          >
            <div className="h-full w-full">
              <ReactFlow
                nodes={visibleNodes}
                edges={visibleEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                onEdgeClick={onEdgeClick}
                onPaneClick={() => {
                  setSelected(null);
                  setSelectedEdgeId(null);
                }}
                onNodeDragStop={(_, node) => {
                  if (!canEdit) return;
                  void savePosition(node.data.deviceId, node.position.x, node.position.y);
                }}
                nodesDraggable={canEdit}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={(instance) => {
                  flowRef.current = instance;
                }}
                fitView
                fitViewOptions={{ padding: 0.25 }}
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
                    pannable
                    zoomable
                    nodeColor={(n) => stateColour(n.data?.state as string)}
                    maskColor="rgba(10, 10, 10, 0.72)"
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

        <div className="space-y-4">
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
                      label: "Speed",
                      value:
                        selectedEdge.speedBps === null
                          ? "Not reported"
                          : formatBandwidth(selectedEdge.speedBps),
                    },
                    { label: "Inbound", value: formatBandwidth(selectedEdge.inRateBps) },
                    { label: "Outbound", value: formatBandwidth(selectedEdge.outRateBps) },
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
                      { label: "Location", value: selected.data.locationName || "—" },
                      { label: "Downstream", value: `${selected.data.childCount} device(s)` },
                      { label: "Connected via", value: selected.data.portLabel || "—" },
                    ]}
                  />
                  <p className="text-xs leading-relaxed text-muted">{selected.data.reason}</p>
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
            {snapshot.lastObservationAt ? (
              <p className="mt-2 text-xs text-muted">
                Newest observation: {timeAgo(snapshot.lastObservationAt)}
              </p>
            ) : null}
          </Panel>
        </div>
      </div>
    </>
  );
}
