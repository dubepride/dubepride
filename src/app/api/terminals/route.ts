/**
 * /api/terminals — device registry for the Clocking Devices page.
 * Supports GET (list), POST (add), PUT (edit/move), DELETE (remove).
 *
 * Phase 15: each device also carries an allowed Clocking_Method and an
 * optional geofence centre. A "Geofence Only" device needs no MAC/IP.
 * Phase 20: hardware connection settings — Serial_Number (SN), Protocol,
 * Port, Comm_Key, Timezone, and Direction_Mode.
 */
import { requireAdmin } from "@/lib/auth";
import {
  createTerminal,
  deleteTerminal,
  listBranchNames,
  listTerminals,
  normalizeTerminalDirectionMode,
  normalizeTerminalProtocol,
  updateTerminal,
} from "@/lib/db";
import { normalizeClockingMethod, readClockingConfig, validateClockingConfig } from "@/lib/geofence";
import type { TerminalDto, TerminalsResponse } from "@/lib/types";

export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const terminals: TerminalDto[] = (await listTerminals()).map((t) => ({
    id: t.Terminal_ID,
    mac: t.Terminal_MAC,
    serialNumber: t.Serial_Number ?? null,
    ip: t.IP_Address,
    location: t.Location_Name,
    branch: t.Branch_Name || "",
    status: t.Status,
    lastPing: t.Last_Ping,
    scansToday: Number(t.Scans_Today ?? 0),
    protocol: normalizeTerminalProtocol(t.Protocol),
    port: Number(t.Port ?? 4370),
    commKey: t.Comm_Key ?? "",
    timezone: t.Timezone || "Africa/Harare",
    directionMode: normalizeTerminalDirectionMode(t.Direction_Mode),
    clockingMethod: normalizeClockingMethod(t.Clocking_Method),
    latitude: t.Latitude,
    longitude: t.Longitude,
    geofenceRadiusMeters: t.Geofence_Radius_Meters,
  }));

  const branches = await listBranchNames();
  const payload: TerminalsResponse = { terminals, branches, generatedAt: Date.now() };
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;
  try {
    const body = await req.json();
    const clocking = readClockingConfig(body);
    const method = normalizeClockingMethod(body?.clockingMethod ?? clocking.clockingMethod);
    const mac = String(body?.mac ?? "").trim();
    const serialNumber = String(body?.serialNumber ?? "").trim();
    const branch = String(body?.branch ?? "").trim();
    // A Geofence-only device has no physical terminal; Biometric/Both accepts either Serial Number (SN) or MAC.
    if (!branch || (!mac && !serialNumber && method !== "Geofence")) {
      return Response.json(
        { ok: false, error: "Branch and either Serial Number (SN) or MAC Address are required." },
        { status: 400 }
      );
    }
    const problem = validateClockingConfig(clocking);
    if (problem) return Response.json({ ok: false, error: problem }, { status: 400 });

    const id = await createTerminal({
      mac: mac || serialNumber || null,
      serialNumber: serialNumber || null,
      ip: body?.ip ?? null,
      location: body?.location ?? null,
      deviceName: body?.deviceName ?? body?.location ?? null,
      branch,
      status: body?.status === "Online" ? "Online" : "Offline",
      protocol: body?.protocol,
      port: body?.port,
      commKey: body?.commKey,
      timezone: body?.timezone,
      directionMode: body?.directionMode,
      clockingMethod: method,
      ...clocking,
    });
    return Response.json({ ok: true, id }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: unknown) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "Bad request" },
      { status: 400 }
    );
  }
}

export async function PUT(req: Request): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;
  try {
    const body = await req.json();
    const id = Number(body.id);
    if (!Number.isFinite(id)) {
      return Response.json({ ok: false, error: "Invalid id" }, { status: 400 });
    }
    const clocking = readClockingConfig(body);
    const problem = validateClockingConfig(clocking);
    if (problem) return Response.json({ ok: false, error: problem }, { status: 400 });

    await updateTerminal(id, {
      mac: body.mac !== undefined ? String(body.mac) : undefined,
      serialNumber: body.serialNumber !== undefined ? body.serialNumber : undefined,
      ip: body.ip !== undefined ? body.ip : undefined,
      location: body.location !== undefined ? body.location : undefined,
      deviceName: body.deviceName !== undefined ? body.deviceName : undefined,
      branch: body.branch !== undefined ? String(body.branch) : undefined,
      status: body.status === "Online" ? "Online" : body.status === "Offline" ? "Offline" : undefined,
      protocol: body.protocol !== undefined ? body.protocol : undefined,
      port: body.port !== undefined ? body.port : undefined,
      commKey: body.commKey !== undefined ? body.commKey : undefined,
      timezone: body.timezone !== undefined ? body.timezone : undefined,
      directionMode: body.directionMode !== undefined ? body.directionMode : undefined,
      ...clocking,
    });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: unknown) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "Bad request" },
      { status: 400 }
    );
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;
  try {
    const body = await req.json().catch(() => ({}));
    const id = Number(body.id);
    if (!Number.isFinite(id)) {
      return Response.json({ ok: false, error: "Invalid id" }, { status: 400 });
    }
    await deleteTerminal(id);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: unknown) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "Bad request" },
      { status: 400 }
    );
  }
}
