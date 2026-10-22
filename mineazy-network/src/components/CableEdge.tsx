/**
 * ============================================================================
 *  CableEdge.tsx — a cable drawn as a cable, not as a label
 * ============================================================================
 *
 *  Two things make this different from React Flow's default edge:
 *
 *  1. **No permanent text on the wire.** Port names used to be rendered on
 *     every edge at 9px, which is exactly the unreadable clutter the design
 *     brief calls out. The label now appears on hover or selection, in a
 *     readable HTML pill that does not scale with the canvas.
 *
 *  2. **The cable's colour is not the whole story.** A cable can be physically
 *     connected and carrying local traffic while the internet beyond it is
 *     down (purple, not red). So the wire carries the *path* state, and a
 *     separate marker carries the *physical link* state — an X when a
 *     managed port reports the link down, a small ring when nothing has
 *     confirmed it yet.
 *
 *  Animation means "measured traffic is flowing", nothing else. It is a
 *  dashed march driven by real counter deltas and it stops under
 *  `prefers-reduced-motion`.
 * ============================================================================
 */

"use client";

import { useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

/** How the path along this cable is doing. */
export type CableTone = "ok" | "purple" | "danger" | "warn" | "muted";

/** The physical link as reported by a managed port, or unknown. */
export type CablePhysical = "up" | "down" | "unknown";

export type CableEdgeData = {
  tone: CableTone;
  physical: CablePhysical;
  /** "lan0 → GigabitEthernet1/0/1" — shown on hover/selection only. */
  label: string;
  /** "↑ 12.4 Mbps ↓ 3.1 Mbps", or "Traffic unavailable". */
  rateLabel: string;
  /** True only when measured counters show actual traffic in this window. */
  flowing: boolean;
  /** The operator turned "Port labels" on for the whole map. */
  forceLabel?: boolean;
};

export type CableEdgeType = Edge<CableEdgeData, "cable">;

const STROKE: Record<CableTone, string> = {
  ok: "#00e676",
  purple: "#9b6dff",
  danger: "#ff5252",
  warn: "#ffc400",
  muted: "#8a93a0",
};

const DASH: Record<CableTone, string | undefined> = {
  ok: undefined,
  purple: undefined,
  danger: undefined,
  // Long dashes: degraded is still a working link.
  warn: "9 5",
  // Short dots: nothing has confirmed this connection.
  muted: "3 6",
};

const PHYSICAL_LABEL: Record<CablePhysical, string> = {
  up: "physical link up",
  down: "physical link DOWN",
  unknown: "physical link not verified",
};

export function CableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<CableEdgeType>) {
  const [hovered, setHovered] = useState(false);

  const tone: CableTone = data?.tone ?? "muted";
  const physical: CablePhysical = data?.physical ?? "unknown";
  const flowing = Boolean(data?.flowing);
  const colour = STROKE[tone];
  const dash = DASH[tone];

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  });

  const showLabel = Boolean(selected || hovered || data?.forceLabel);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={[
          "cable",
          `cable--${tone}`,
          flowing ? "cable--flowing" : "",
          selected ? "cable--selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          stroke: colour,
          strokeWidth: selected ? 2.9 : 2,
          strokeDasharray: dash,
        }}
      />

      {/*
        A wide invisible stroke on top of the visible one. React Flow's own
        interaction path sits underneath the edge content, and an 2px line is
        almost impossible to click; this makes the whole cable a target
        without changing how it looks.
      */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        style={{ pointerEvents: "stroke", cursor: "pointer" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />

      {/* Physical link, drawn on the wire where a port reports it is down. */}
      {physical === "down" ? (
        <g transform={`translate(${labelX}, ${labelY})`} pointerEvents="none">
          <circle r={8.5} fill="#0a0a0a" stroke={colour} strokeWidth={1.4} />
          <path
            d="M-3.1-3.1 3.1 3.1M3.1-3.1-3.1 3.1"
            stroke={colour}
            strokeWidth={2.1}
            strokeLinecap="round"
          />
        </g>
      ) : physical === "unknown" ? (
        <g transform={`translate(${labelX}, ${labelY})`} pointerEvents="none">
          <circle r={3.4} fill="#0a0a0a" stroke="#8a93a0" strokeWidth={1.2} />
        </g>
      ) : null}

      {showLabel ? (
        <EdgeLabelRenderer>
          <div
            className="cable-label nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <div className="cable-label__ports">{data?.label}</div>
            <div className="cable-label__meta">
              <span className={`cable-label__dot cable-label__dot--${tone}`} />
              {PHYSICAL_LABEL[physical]}
              {data?.rateLabel ? <span className="cable-label__rate">{data.rateLabel}</span> : null}
            </div>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export default CableEdge;
