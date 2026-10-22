/**
 * ============================================================================
 *  GET    /api/demo — the demo state (mode, faults, simulated estate)
 *  POST   /api/demo — inject a fault / clear the faults / seed the estate
 *  DELETE /api/demo — clear every injected fault
 * ============================================================================
 *
 *  The demo controls are only available when the console is running in
 *  demo mode (`MINEAZY_DEMO=1`). In a production install the endpoint
 *  refuses to do anything, so nobody can inject a fake fault into a live
 *  monitoring run.
 * ============================================================================
 */

import { isDemoMode } from "@/lib/db";
import { readFaults, writeFaults, clearFaults, seedSimulatedTopology } from "../../../collector/simulator";
import { getSetting, setSetting } from "@/lib/settings";
import { recordEvent } from "@/lib/repo/events";
import { recordAudit } from "@/lib/repo/audit";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const enabled = isDemoMode();
  return ok({
    enabled,
    mode: await getSetting("collector.mode", "real"),
    faults: enabled ? await readFaults() : null,
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_config_monitoring");
  if (gate.response) return gate.response;

  if (!isDemoMode()) {
    return fail(
      "Demo controls are disabled. Start the console with MINEAZY_DEMO=1 to enable the labelled simulator.",
      403
    );
  }

  const body = await readJson(request);
  const action = typeof body.action === "string" ? body.action : "fault";

  if (action === "seed") {
    const result = await seedSimulatedTopology();
    return ok({ action, ...result });
  }

  if (action === "clear") {
    const faults = await clearFaults();
    await recordEvent({
      type: "config_changed",
      severity: "info",
      title: "Demo faults cleared",
      detail: "Every injected demo fault was removed.",
      subjectType: "system",
      subjectId: null,
      source: "simulator",
    });
    return ok({ action, faults });
  }

  if (action === "mode") {
    const mode = typeof body.mode === "string" ? body.mode : "";
    if (mode !== "real" && mode !== "simulated" && mode !== "off") {
      return fail('The collector mode must be "real", "simulated" or "off".');
    }
    await setSetting("collector.mode", mode);
    await recordEvent({
      type: "config_changed",
      severity: "info",
      title: `Collector mode set to "${mode}"`,
      detail:
        mode === "simulated"
          ? "The collector will now generate SIMULATED data. No real hardware is contacted."
          : `The collector mode is now "${mode}".`,
      subjectType: "system",
      subjectId: null,
      source: "console",
    });
    await recordAudit({
      userId: gate.account.id,
      userName: gate.account.username,
      action: "update",
      entity: "collector_mode",
      after: { mode },
      note: "The collector mode was changed from the demo panel.",
    });
    return ok({ action, mode });
  }

  // Inject a fault.
  const patch: Parameters<typeof writeFaults>[0] = {};
  if (typeof body.uplinkDown === "boolean") patch.uplinkDown = body.uplinkDown;
  if (typeof body.whiteHouseDown === "boolean") patch.whiteHouseDown = body.whiteHouseDown;
  if (typeof body.noInternet === "boolean") patch.noInternet = body.noInternet;
  if (typeof body.noTraffic === "boolean") patch.noTraffic = body.noTraffic;
  if (Array.isArray(body.deviceOffline)) {
    patch.deviceOffline = body.deviceOffline.filter((n): n is string => typeof n === "string");
  }

  if (Object.keys(patch).length === 0) return fail("No fault was supplied.");

  const faults = await writeFaults(patch);
  await recordEvent({
    type: "config_changed",
    severity: "minor",
    title: "Demo fault injected",
    detail: `SIMULATED fault: ${JSON.stringify(patch)}`,
    subjectType: "system",
    subjectId: null,
    source: "simulator",
  });

  return ok({ action, faults });
}

export async function DELETE(): Promise<Response> {
  const gate = await requirePermission("can_config_monitoring");
  if (gate.response) return gate.response;

  if (!isDemoMode()) return fail("Demo controls are disabled.", 403);

  const faults = await clearFaults();
  return ok({ faults });
}
