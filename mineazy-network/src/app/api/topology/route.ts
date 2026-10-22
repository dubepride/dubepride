/**
 * ============================================================================
 *  /api/topology — the live map payload, and the saved canvas layout
 * ============================================================================
 *
 *  One request returns the whole graph: the nodes (individual devices — never
 *  an aggregate) and the edges (physical links) with their evidence-backed
 *  state, the rate on each link and the provenance of every edge.
 *
 *  POST persists the positions an operator dragged on the canvas. The
 *  automatic layout is always the fallback: a device with no saved position
 *  is placed by the layout engine, so resetting is safe and lossless.
 * ============================================================================
 */

import { buildTopologySnapshot, traceUpstreamPath } from "@/lib/topology";
import { requirePermission, ok, fail, readJson, stringParam } from "@/lib/api";
import { clearDeviceLayouts, setDeviceLayout } from "@/lib/repo/devices";
import { recordAudit } from "@/lib/repo/audit";
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

/** Save dragged node positions, or clear them all back to the auto layout. */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_edit_inventory");
  if (gate.response) return gate.response;

  const body = await readJson(request);

  if (body.reset === true) {
    const cleared = await clearDeviceLayouts();
    await recordAudit({
      userId: gate.account.id,
      userName: gate.account.username,
      action: "layout.reset",
      entity: "topology",
      entityId: "all",
      after: { cleared },
      note: "Cleared every manual canvas position; the map returned to the automatic layout.",
    });
    return ok({ reset: true, cleared });
  }

  const raw = Array.isArray(body.positions) ? (body.positions as unknown[]) : null;
  if (!raw || raw.length === 0) {
    return fail("Send {positions:[{deviceId,x,y}]} or {reset:true}.");
  }
  if (raw.length > 500) {
    return fail("Too many positions in one request (maximum 500).");
  }

  const saved: number[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const deviceId = Number(item.deviceId);
    const x = Number(item.x);
    const y = Number(item.y);
    if (!Number.isInteger(deviceId) || deviceId <= 0) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Keep the canvas finite even if a client sends nonsense.
    if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000) continue;
    await setDeviceLayout(deviceId, x, y);
    saved.push(deviceId);
  }

  if (saved.length === 0) {
    return fail("No position in the request was valid.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "layout.update",
    entity: "topology",
    entityId: saved.join(","),
    after: { devices: saved.length },
    note: "Manual canvas positions saved from the Live Map.",
  });

  return ok({ saved: saved.length });
}
