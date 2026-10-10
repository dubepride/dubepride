/**
 * ============================================================================
 *  /api/my-portal/time-off — the worker's time-off requests (Phase 14)
 * ============================================================================
 *
 *  GET  → the signed-in account's pending/entire request history.
 *  POST → file { type, startDate, endDate, reason } — stored in
 *         Time_Off_Requests with Status 'Pending'. Dates are YYYY-MM-DD;
 *         the end date cannot precede the start.
 *
 *  Server-side protection: requires can_request_time_off.
 */

import type { NextRequest } from "next/server";
import { currentAccount, forbiddenResponse, requirePermission, unauthorizedResponse } from "@/lib/auth";
import { createTimeOffRequest, listTimeOffRequests } from "@/lib/db";
import type { MyPortalTimeOffResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  const guard = await requirePermission("can_request_time_off");
  if (guard) return guard;

  const account = await currentAccount();
  if (!account) return unauthorizedResponse();
  if (account.permissions.can_request_time_off !== true) return forbiddenResponse();

  const payload: MyPortalTimeOffResponse = {
    ok: true,
    requests: listTimeOffRequests(account.employeeId),
    message: "",
  };
  return Response.json(payload, { headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await requirePermission("can_request_time_off");
  if (guard) return guard;

  const account = await currentAccount();
  if (!account) return unauthorizedResponse();
  if (account.permissions.can_request_time_off !== true) return forbiddenResponse();

  if (account.employeeId == null) {
    return bad("No roster employee is linked to this account — ask a manager to link one.");
  }

  let body: { type?: unknown; startDate?: unknown; endDate?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as { type?: unknown; startDate?: unknown; endDate?: unknown; reason?: unknown };
  } catch {
    return bad("Invalid JSON body.");
  }

  let requestRow;
  try {
    requestRow = createTimeOffRequest({
      accountId: account.accountId,
      employeeId: account.employeeId,
      type: String(body.type ?? ""),
      startDate: String(body.startDate ?? ""),
      endDate: String(body.endDate ?? ""),
      reason: String(body.reason ?? ""),
    });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Could not file the request.");
  }

  const payload: MyPortalTimeOffResponse = {
    ok: true,
    requests: listTimeOffRequests(account.employeeId),
    message: `Request saved — starting ${requestRow.Start_Date}.`,
  };
  return Response.json(payload, { headers: NO_STORE });
}