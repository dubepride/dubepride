/**
 * /api/dashboard/exceptions — Phase 4 drill-down for the Exceptions widget.
 *
 *   GET                          → summary: live counts for all six boxes
 *   GET ?type=arrived_late       → that bucket's rows (+ refreshed counts)
 *   GET ?type=garbage            → 400 with the list of valid types
 *
 * Aliases accepted: `early` → arrived_early, `late` → arrived_late, and
 * any casing / hyphen separator ("Arrived-Late") is normalised. Admin-only
 * (the proxy filters unauthenticated callers, requireAdmin re-checks) and
 * cache-free so the drawer always reflects punches captured since the
 * last open.
 */

import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  EXCEPTION_TYPE_ALIASES,
  EXCEPTION_TYPES,
  normalizeExceptionTypeParam,
} from "@/lib/exception-meta";
import { getExceptions } from "@/lib/db";
import type { ExceptionType, ExceptionsResponse } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest): Promise<Response> {
  // Admin-only data: proxy already filters, re-check here too.
  const guard = await requireAdmin();
  if (guard) return guard;

  const raw = request.nextUrl.searchParams.get("type");
  let type: ExceptionType | null = null;

  if (raw !== null) {
    const key = normalizeExceptionTypeParam(raw);
    if (key !== "") {
      const resolved = EXCEPTION_TYPE_ALIASES[key] ?? key;
      if (!EXCEPTION_TYPES.includes(resolved as ExceptionType)) {
        return Response.json(
          {
            ok: false,
            error: `Unknown exception type "${raw}".`,
            allowed: [...EXCEPTION_TYPES],
          },
          { status: 400, headers: NO_STORE }
        );
      }
      type = resolved as ExceptionType;
    }
  }

  const payload: ExceptionsResponse = getExceptions(type);
  return Response.json(payload, { headers: NO_STORE });
}
