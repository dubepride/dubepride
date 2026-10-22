/**
 * ============================================================================
 *  GET   /api/incidents/:id — one incident with its full evidence
 *  PATCH /api/incidents/:id — acknowledge, note, assign, resolve
 * ============================================================================
 *
 *  Incident handling is a deliberate separation of powers:
 *
 *    acknowledge — a human has seen it. The incident STAYS OPEN, because
 *                  seeing a fault is not the same as it being fixed.
 *    note       — append context for the next operator.
 *    assign     — record who owns the investigation.
 *    severity   — re-rate the incident when the real impact is known.
 *    resolve    — close it. A recovered fault is closed by the collector
 *                  when it observes the recovery; an operator may also close
 *                  one by hand, and that manual close is recorded.
 *
 *  Every action is written to the audit trail with the account that made it.
 * ============================================================================
 */

import {
  acknowledgeIncident,
  getIncident,
  resolveIncident,
  updateIncident,
} from "@/lib/repo/incidents";
import { listDevices } from "@/lib/repo/devices";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";
import type { Severity } from "@/lib/types";

type Params = { params: Promise<{ id: string }> };

async function resolveId(params: Params["params"]): Promise<number | null> {
  const { id } = await params;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

const SEVERITIES: readonly string[] = ["critical", "major", "minor", "info"];

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid incident id.", 400);

  const incident = await getIncident(id);
  if (!incident) return fail("That incident no longer exists.", 404);

  const devices = await listDevices();
  const names = new Map(devices.map((device) => [device.id, device.name]));

  return ok({
    incident: {
      ...incident,
      deviceName: incident.deviceId ? names.get(incident.deviceId) ?? null : null,
      affectedNames: incident.affected.map((deviceId) => names.get(deviceId) ?? `Device ${deviceId}`),
    },
  });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_manage_incidents");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid incident id.", 400);

  const current = await getIncident(id);
  if (!current) return fail("That incident no longer exists.", 404);

  const body = await readJson(request);
  const action = typeof body.action === "string" ? body.action : "";

  switch (action) {
    case "acknowledge": {
      await acknowledgeIncident(id, gate.account.username);
      await recordAudit({
        userId: gate.account.id,
        userName: gate.account.username,
        action: "acknowledge",
        entity: "incident",
        entityId: id,
        before: { state: current.state, acknowledged: current.acknowledged },
        after: { state: "acknowledged", acknowledged: true },
        note: "The incident was acknowledged. It stays open until the fault is observed as recovered.",
      });
      await recordEvent({
        type: "incident_raised",
        severity: "info",
        title: `Incident acknowledged: ${current.title}`,
        detail: `${gate.account.username} acknowledged the incident.`,
        subjectType: "device",
        subjectId: current.deviceId,
        source: "console",
      });
      break;
    }

    case "note": {
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!note) return fail("A note cannot be empty.");
      const combined = current.notes ? `${current.notes}\n${note}` : note;
      await updateIncident(id, { notes: combined });
      await recordAudit({
        userId: gate.account.id,
        userName: gate.account.username,
        action: "note",
        entity: "incident",
        entityId: id,
        before: { notes: current.notes },
        after: { notes: combined },
        note: "A note was appended to the incident.",
      });
      break;
    }

    case "assign": {
      const assignedTo = typeof body.assignedTo === "string" ? body.assignedTo.trim() : "";
      await updateIncident(id, { assignedTo: assignedTo || null });
      await recordAudit({
        userId: gate.account.id,
        userName: gate.account.username,
        action: "assign",
        entity: "incident",
        entityId: id,
        before: { assignedTo: current.assignedTo },
        after: { assignedTo: assignedTo || null },
        note: "The incident was assigned.",
      });
      break;
    }

    case "severity": {
      const severity = typeof body.severity === "string" ? body.severity : "";
      if (!SEVERITIES.includes(severity)) {
        return fail(`Unknown severity "${body.severity}".`);
      }
      await updateIncident(id, { severity: severity as Severity });
      await recordAudit({
        userId: gate.account.id,
        userName: gate.account.username,
        action: "severity",
        entity: "incident",
        entityId: id,
        before: { severity: current.severity },
        after: { severity },
        note: "The incident severity was changed.",
      });
      break;
    }

    case "resolve": {
      const note =
        typeof body.note === "string" && body.note.trim()
          ? body.note.trim()
          : "Closed manually by an operator.";
      await resolveIncident(id, note);
      await recordAudit({
        userId: gate.account.id,
        userName: gate.account.username,
        action: "resolve",
        entity: "incident",
        entityId: id,
        before: { state: current.state },
        after: { state: "resolved" },
        note: "The incident was closed by hand.",
      });
      await recordEvent({
        type: "incident_recovered",
        severity: "info",
        title: `Incident closed: ${current.title}`,
        detail: `${gate.account.username} closed the incident manually.`,
        subjectType: "device",
        subjectId: current.deviceId,
        source: "console",
      });
      break;
    }

    default:
      return fail(
        'Unknown action. Use "acknowledge", "note", "assign", "severity" or "resolve".'
      );
  }

  return ok({ id, incident: await getIncident(id) });
}
