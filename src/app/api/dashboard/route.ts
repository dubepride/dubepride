/**
 * /api/dashboard — polled by the dashboard for metrics + the live scan feed.
 * Response is intentionally tiny and cache-free so the UI reflects punches
 * within one poll interval (~2.5s).
 */

import { requireAdmin } from "@/lib/auth";
import { getDashboard } from "@/lib/db";
import type { DashboardResponse } from "@/lib/types";

export async function GET(): Promise<Response> {
  // Admin-only data (Objective 1): proxy already filters, re-check here too.
  const guard = await requireAdmin();
  if (guard) return guard;

  const { metrics, summary, feed } = await getDashboard();
  const payload: DashboardResponse = { metrics, summary, feed, generatedAt: Date.now() };
  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
