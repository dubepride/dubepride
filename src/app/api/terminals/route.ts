/**
 * /api/terminals — device registry for the Clocking Devices page.
 * Supports GET (list), POST (add), PUT (edit/move), DELETE (remove).
 */
import { requireAdmin } from "@/lib/auth";
import {
  createTerminal,
  deleteTerminal,
  listTerminals,
  updateTerminal,
} from "@/lib/db";
import type { TerminalDto, TerminalsResponse } from "@/lib/types";

export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const terminals: TerminalDto[] = listTerminals().map((t) => ({
    id: t.Terminal_ID,
    mac: t.Terminal_MAC,
    ip: t.IP_Address,
    location: t.Location_Name,
    branch: t.Branch_Name || "",
    status: t.Status,
    lastPing: t.Last_Ping,
    scansToday: Number(t.Scans_Today ?? 0),
  }));

  const payload: TerminalsResponse = { terminals, generatedAt: Date.now() };
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;
  try {
    const body = await req.json();
    const mac = String(body.mac || "").trim();
    const branch = String(body.branch || "").trim();
    if (!mac || !branch) {
      return Response.json({ ok: false, error: "MAC and Branch required" }, { status: 400 });
    }
    const id = createTerminal({
      mac,
      ip: body.ip ?? null,
      location: body.location ?? null,
      deviceName: body.deviceName ?? body.location ?? null,
      branch,
      status: body.status === "Online" ? "Online" : "Offline",
    });
    return Response.json({ ok: true, id }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || "Bad request" }, { status: 400 });
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
    updateTerminal(id, {
      mac: body.mac !== undefined ? String(body.mac) : undefined,
      ip: body.ip !== undefined ? body.ip : undefined,
      location: body.location !== undefined ? body.location : undefined,
      deviceName: body.deviceName !== undefined ? body.deviceName : undefined,
      branch: body.branch !== undefined ? String(body.branch) : undefined,
      status: body.status === "Online" ? "Online" : body.status === "Offline" ? "Offline" : undefined,
    });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || "Bad request" }, { status: 400 });
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
    deleteTerminal(id);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || "Bad request" }, { status: 400 });
  }
}