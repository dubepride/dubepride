/**
 * ============================================================================
 *  /api/erp/sync — ERP Sync Engine endpoint + diagnostics feed
 * ============================================================================
 *
 *  GET  → snapshot for the ERP Sync Logs page: statistics, batch history
 *         (with exact payloads) and the oldest Pending records still
 *         waiting in the offline buffer.
 *
 *  POST → run a sync immediately ("Force Sync Now"). Gathers every log
 *         marked 'Pending', pushes one JSON batch to the ERP and records
 *         the outcome (HTTP 200 → Success, unreachable → stays Pending).
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  CONNECTING THE REAL ERP:
 *    1. Set ERP_API_URL / ERP_API_KEY in .env.local (see .env.example).
 *    2. Adjust the payload shape in src/lib/erp.ts → buildErpPayload()
 *       if your ERP expects different field names.
 *    3. Schedule this POST from cron/queue for unattended operation:
 *         curl -X POST http://<bridge-host>:3000/api/erp/sync
 *  ─────────────────────────────────────────────────────────────────────
 */

import { requireAdmin } from "@/lib/auth";
import { getSyncOverview } from "@/lib/db";
import { erpConfig, runErpSync } from "@/lib/erp";
import type { ErpSyncGetResponse } from "@/lib/types";

export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (guard) return guard;

  const cfg = erpConfig();
  const overview = await getSyncOverview();

  const payload: ErpSyncGetResponse = {
    ...overview,
    mode: cfg.mode,
    erpUrl: cfg.url,
    failEvery: cfg.mode === "mock" ? cfg.failEvery : 0,
    generatedAt: Date.now(),
  };
  return Response.json(payload);
}

export async function POST(): Promise<Response> {
  // Force-syncing is an admin action — never allow it unauthenticated.
  const guard = await requireAdmin();
  if (guard) return guard;

  try {
    // Manual trigger from the "Force Sync Now" button. The engine itself
    // is re-entrancy safe (single-flight lock) and never discards records.
    const result = await runErpSync("Manual");
    // Always HTTP 200: the body distinguishes success (`ok: true`) from an
    // ERP outage (`ok: false` + buffered records), which keeps client error
    // handling simple. Transport-level exceptions still return 500 below.
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, attempted: 0, synced: 0, failed: 0, message, batch: null, trigger: "Manual" },
      { status: 500 }
    );
  }
}
