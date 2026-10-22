/**
 * ============================================================================
 *  GET /api/topology — the live map payload
 * ============================================================================
 *
 *  One request returns the whole graph: the nodes (individual devices — never
 *  an aggregate) and the edges (physical links) with their evidence-backed
 *  state, the rate on each link and the provenance of every edge.
 * ============================================================================
 */

import { buildTopologySnapshot, traceUpstreamPath } from "@/lib/topology";
import { requirePermission, ok, stringParam } from "@/lib/api";
import { collectorHeartbeat } from "../../../collector/worker";

export async function GET(request: Request): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const snapshot = await buildTopologySnapshot();

  // Optional: trace the upstream path of one device.
  const deviceId = stringParam(request, "trace");
  if (deviceId) {
    const id = Number(deviceId);
    if (Number.isFinite(id)) {
      const trace = await traceUpstreamPath(id);
      return ok({ snapshot, trace });
    }
  }

  const heartbeat = await collectorHeartbeat();
  return ok({ snapshot, collector: heartbeat });
}
