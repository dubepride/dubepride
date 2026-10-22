/**
 * ============================================================================
 *  GET /api/incidents — the incident queue
 * ============================================================================
 *
 *  The queue is ordered by severity and age, and it always carries the
 *  evidence block so an operator can see what the collector actually
 *  observed rather than a bare status line.
 * ============================================================================
 */

import { listIncidents, incidentCounts } from "@/lib/repo/incidents";
import { listDevices } from "@/lib/repo/devices";
import { requirePermission, ok, stringParam, intParam } from "@/lib/api";
import type { IncidentState } from "@/lib/types";

export async function GET(request: Request): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const requested = stringParam(request, "state");
  const state: IncidentState | "active" | "all" =
    requested === "open" || requested === "acknowledged" || requested === "resolved"
      ? requested
      : requested === "all"
        ? "all"
        : "active";

  const incidents = await listIncidents({ state, limit: intParam(request, "limit", 200) });
  const devices = await listDevices();
  const names = new Map(devices.map((device) => [device.id, device.name]));

  return ok({
    incidents: incidents.map((incident) => ({
      ...incident,
      deviceName: incident.deviceId ? names.get(incident.deviceId) ?? null : null,
      affectedNames: incident.affected.map((id) => names.get(id) ?? `Device ${id}`),
    })),
    counts: await incidentCounts(),
    state,
  });
}
