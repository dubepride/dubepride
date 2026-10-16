/**
 * ============================================================================
 *  /api/shifts — shift definitions CRUD (Phase 11 /shifts)
 * ============================================================================
 *
 *  GET    → the shift catalogue (with per-shift employee assignment counts)
 *  POST   → create { name, startTime, endTime, days }
 *  PUT    → update { id, …patch }
 *  DELETE → remove { id } (employees assigned to it are released)
 *
 *  Times are 24h "HH:MM" wall clocks; duration is derived server-side
 *  (overnight shifts wrap past midnight).
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createShift, deleteShift, listShifts, updateShift } from "@/lib/db";
import type { ShiftsResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(,(Mon|Tue|Wed|Thu|Fri|Sat|Sun))*$/;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const payload: ShiftsResponse = { shifts: await listShifts(), generatedAt: Date.now() };
  return Response.json(payload, { headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const name = String(body.name ?? "").trim();
  const startTime = String(body.startTime ?? "").trim();
  const endTime = String(body.endTime ?? "").trim();
  const days = String(body.days ?? "").trim();

  if (!name) return bad("Shift name is required.");
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    return bad("Start and end times must be in HH:MM (24h) format.");
  }
  if (!DAYS_RE.test(days)) return bad("Assigned days must be a comma list (e.g. Mon,Tue,Wed).");

  try {
    const id = await createShift({ name, startTime, endTime, days });
    return Response.json({ ok: true, id }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create the shift.";
    return bad(message.includes("UNIQUE") ? `A shift named "${name}" already exists.` : message);
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("A numeric shift id is required.");

  const patch: { name?: string; startTime?: string; endTime?: string; days?: string } = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return bad("Shift name cannot be empty.");
    patch.name = name;
  }
  if (body.startTime !== undefined) {
    const v = String(body.startTime).trim();
    if (!TIME_RE.test(v)) return bad("Start time must be in HH:MM (24h) format.");
    patch.startTime = v;
  }
  if (body.endTime !== undefined) {
    const v = String(body.endTime).trim();
    if (!TIME_RE.test(v)) return bad("End time must be in HH:MM (24h) format.");
    patch.endTime = v;
  }
  if (body.days !== undefined) {
    const v = String(body.days).trim();
    if (!DAYS_RE.test(v)) return bad("Assigned days must be a comma list (e.g. Mon,Tue,Wed).");
    patch.days = v;
  }

  try {
    await updateShift(id, patch);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not update the shift.";
    return bad(message.includes("UNIQUE") ? "A shift with that name already exists." : message, 400);
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid JSON body.");
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return bad("A numeric shift id is required.");

  await deleteShift(id);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
