/**
 * ============================================================================
 *  Map node measurer
 * ============================================================================
 *
 *  React Flow measures every node with a ResizeObserver and keeps the node
 *  hidden (`visibility: hidden`) until it has a measured box. Browsers stop
 *  delivering ResizeObserver notifications to pages that are not visible, so
 *  a map that was opened in a background tab stays blank: the nodes never get
 *  a box, they never become visible, and the edges have no handle anchors to
 *  draw from.
 *
 *  This component re-runs that measurement on demand by reading the DOM
 *  directly. `offsetWidth`/`offsetHeight` and `getBoundingClientRect()` are
 *  layout based, so they return real numbers even when the page is not
 *  visible. React Flow's own store action does exactly this — it is the same
 *  code path the ResizeObserver callback uses — so the result is identical to
 *  the observer's, just triggered by us.
 *
 *  It has to live INSIDE `<ReactFlow>`: that is where the flow's store lives,
 *  and the store is what owns the measurement.
 * ============================================================================
 */

"use client";

import { useEffect } from "react";
import { useNodes, useStoreApi } from "@xyflow/react";

/**
 * Structural copy of React Flow's internal `InternalNodeUpdate` type, which
 * the package does not re-export.
 */
type NodeInternalsUpdate = {
  id: string;
  nodeElement: HTMLDivElement;
  force?: boolean;
};

export function MapNodeMeasurer() {
  const store = useStoreApi();
  const nodes = useNodes();

  useEffect(() => {
    const state = store.getState();
    const domNode = state.domNode;
    if (!domNode || nodes.length === 0) return;

    const updates = new Map<string, NodeInternalsUpdate>();

    for (const node of nodes) {
      const internal = state.nodeLookup.get(node.id);

      // Already measured AND anchored to its handles: nothing to do. This is
      // the common case after the first pass, so the poll does no work.
      if (internal?.measured?.width && internal?.measured?.height && internal.internals.handleBounds) {
        continue;
      }

      const element = domNode.querySelector<HTMLDivElement>(
        `.react-flow__node[data-id="${node.id}"]`
      );
      if (!element) continue;

      updates.set(node.id, { id: node.id, nodeElement: element, force: true });
    }

    if (updates.size === 0) return;

    // NOTE: `useUpdateNodeInternals()` is deliberately NOT used here. It
    // defers the work to `requestAnimationFrame`, and rAF is paused while the
    // page is hidden — which is exactly the case this component exists for.
    state.updateNodeInternals(updates);
  }, [nodes, store]);

  return null;
}

export default MapNodeMeasurer;
