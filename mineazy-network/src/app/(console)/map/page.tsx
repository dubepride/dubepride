/**
 * ============================================================================
 *  Map — the live topology canvas
 * ============================================================================
 *
 *  Individual device nodes only (never aggregates). Click a node for a
 *  quick inspection and an upstream path trace; edges show the cable,
 *  source (LLDP/CDP/FDB/manual/simulated) and measured rates when available.
 *  Faults light up in red/amber so an operator can follow the chain to the
 *  root cause.
 * ============================================================================
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon } from "@/components/Icon";
import { MapNodeMeasurer } from "@/components/MapNodeMeasurer";
import { useApi } from "@/components/useApi";
import { apiGet } from "@/components/api";
import { Chip, ErrorNote, KeyValue, Loading, Notice, PageHeader, Panel, StateBadge } from "@/components/ui";
import { formatBandwidth, humanise, timeAgo } from "@/components/format";
import type { DeviceCategory, HealthState, TopologySnapshot } from "@/lib/types";

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

/** The dot colour for a state, used by the minimap. */
function stateHex(state: HealthState): string {
  switch (state) {
    case "OFFLINE":
    case "LINK_DOWN":
      return "#ff5252";
    case "NO_INTERNET":
      return "#9b6dff";
    case "DEGRADED":
    case "STALE":
    case "NO_TRAFFIC":
      return "#ffc400";
    case "ONLINE":
      return "#00e676";
    default:
      return "#a0aec0";
  }
}

function MapNode({ data }: NodeProps<MapNodeType>) {
  return (
    <div
      className={`map-node ${data.selected ? "map-node--selected" : ""} ${nodeStateClass(
        data.state
      )}`}
      title={data.reason}
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

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{data.name}</div>
          <div className="text-[0.68rem] text-muted">{humanise(data.category)}</div>
        </div>
        <StateBadge state={data.state} />
      </div>
      {data.ip ? <div className="mt-1 font-mono text-[0.68rem] text-muted">{data.ip}</div> : null}
      {data.portLabel ? (
        <div className="mt-0.5 text-[0.68rem] text-neon">via {data.portLabel}</div>
      ) : null}
      {data.childCount > 0 ? (
        <div className="mt-0.5 text-[0.64rem] text-muted">
          {data.childCount} device{data.childCount === 1 ? "" : "s"} below
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes: NodeTypes = { mapNode: MapNode };

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
function edgeSignature(edge: Edge): string {
  return [
    edge.source,
    edge.target,
    edge.sourceHandle ?? "",
    edge.targetHandle ?? "",
    edge.type ?? "",
    edge.animated ? "1" : "0",
    JSON.stringify(edge.style ?? null),
    typeof edge.label === "string" ? edge.label : "",
    JSON.stringify(edge.labelStyle ?? null),
  ].join("|");
}

export default function MapPage() {
  const { data, error, loading, reload } = useApi<TopologyPayload>("/api/topology", {
    pollMs: 10_000,
  });
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNodeType>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<MapNodeData | null>(null);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [tracing, setTracing] = useState(false);
  /**
   * The React Flow instance, captured on init. It is the public handle on the
   * flow's internal state (including the measured size of every node).
   */
  const flowRef = useRef<ReactFlowInstance<MapNodeType, Edge> | null>(null);
  const inspectedId = selected?.deviceId ?? null;

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
          selected: n.deviceId === inspectedId,
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
        const label =
          e.label || (e.inRateBps !== null || e.outRateBps !== null)
            ? e.label
              ? `${e.label} · ↑${formatBandwidth(e.outRateBps)} ↓${formatBandwidth(e.inRateBps)}`
              : `↑${formatBandwidth(e.outRateBps)} ↓${formatBandwidth(e.inRateBps)}`
            : undefined;
        const nextEdge: Edge = {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: "out",
          targetHandle: "in",
          type: "smoothstep",
          animated: e.state === "down",
          style: {
            stroke:
              e.state === "down"
                ? "#ff5252"
                : e.state === "unknown"
                  ? "#a0aec0"
                  : "#00e676",
            strokeWidth: e.state === "down" ? 2.6 : 1.8,
          },
          label,
          labelStyle: { fill: "#a0aec0", fontSize: 9 },
        };
        const prev = prevById.get(e.id);
        if (prev && edgeSignature(prev) === edgeSignature(nextEdge)) {
          return prev;
        }
        return nextEdge;
      });
    });
  }, [data, setNodes, setEdges, inspectedId]);

  const onNodeClick = useCallback(async (_: React.MouseEvent, node: MapNodeType) => {
    setSelected(node.data);
    setTracing(true);
    setTrace(null);
    try {
      const res = await apiGet<TopologyPayload>(
        `/api/topology?trace=${encodeURIComponent(String(node.data.deviceId ?? ""))}`
      );
      setTrace(res.trace ?? null);
    } catch {
      setTrace(null);
    } finally {
      setTracing(false);
    }
  }, []);

  if (loading && !data) return <Loading label="Building the live map…" />;
  if (error && !data) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  const snapshot = data.snapshot;

  return (
    <>
      <PageHeader
        title="Live Map"
        description="Individual devices and physical links. Use the path trace to follow a fault back to its source."
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

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
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
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              nodeTypes={nodeTypes}
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
              <MiniMap
                nodeColor={(n) => stateHex(n.data?.state as HealthState)}
              />
            </ReactFlow>
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel title="Inspector">
            {selected ? (
              <div className="space-y-2">
                <div>
                  <div className="text-base font-semibold text-white">{selected.name}</div>
                  <div className="text-xs text-muted">{humanise(selected.category)}</div>
                </div>
                <StateBadge state={selected.state} />
                {selected.state === "NO_INTERNET" ? (
                  <Notice tone="warn" title="Physical link active. External internet connectivity checks are failing.">
                    This device is still reachable on the local network. Only its path to the
                    internet is failing, so local links stay green.
                  </Notice>
                ) : null}
                <KeyValue
                  items={[
                    { label: "IP", value: selected.ip || "—" },
                    { label: "Location", value: selected.locationName || "—" },
                    { label: "Downstream", value: `${selected.childCount} device(s)` },
                    { label: "Connected via", value: selected.portLabel || "—" },
                  ]}
                />
                <div className="flex flex-wrap gap-2 pt-1">
                  <Link href={`/devices/${selected.deviceId}`} className="btn btn--ghost btn--sm">
                    Open device detail
                  </Link>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">Click a device node to inspect it and trace its upstream path.</p>
            )}
          </Panel>

          <Panel title="Upstream path trace">
            {tracing ? (
              <p className="text-sm text-muted">Tracing path…</p>
            ) : trace ? (
              <div className="space-y-2">
                <p className="text-sm leading-relaxed text-white">{trace.path}</p>
                {trace.brokenSegment ? (
                  <Notice tone="danger">
                    The first broken segment is at device{" "}
                    <Link href={`/devices/${trace.brokenSegment.deviceId}`} className="font-semibold hover:underline">
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
                      <span className="text-xs text-muted">({step.state})</span>
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

          <Panel title="Legend">
            <div className="flex flex-wrap gap-1.5">
              <Chip tone="neon">Online</Chip>
              <Chip tone="purple">Link up · no internet</Chip>
              <Chip tone="danger">Offline / link down</Chip>
              <Chip tone="warn">Degraded / stale / no traffic</Chip>
              <Chip tone="muted">Unknown / unmonitored</Chip>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Purple means the device and its cable are healthy but external internet checks are
              failing — never that the device itself failed. Edges animate when a link is down.
              Rates are shown only when measured counters exist (no cumulative counters are
              displayed as speed).
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
