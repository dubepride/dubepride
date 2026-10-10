/**
 * ============================================================================
 *  erp.ts — ERP Sync Engine
 * ============================================================================
 *
 *  Pulls every Attendance_Log marked `Pending`, packs it into a clean JSON
 *  envelope and POSTs it to the external ERP REST API.
 *
 *  Delivery contract (per spec):
 *    • ERP answers 200 OK            → local logs become `Success`
 *    • ERP unreachable (net/timeout/5xx)
 *                                    → logs stay `Pending` (OFFLINE BUFFERING)
 *    • ERP answers 4xx (record rejected)
 *                                    → logs become `Failed` for admin triage
 *
 *  Every attempt — successful or not — is recorded in Erp_Sync_Batches with
 *  the exact payload so the diagnostics page can replay what happened.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  CONNECTING THE REAL ERP
 *  Set these environment variables (see .env.example):
 *      ERP_API_URL       e.g. https://erp.example.com/api/v2/attendance/push
 *      ERP_API_KEY       bearer token sent as `Authorization: Bearer …`
 *      ERP_MOCK_MODE     set to "false" to disable the built-in simulator
 *  While ERP_API_URL is empty the built-in simulator stands in for the ERP
 *  (including periodic simulated outages) so buffering can be demonstrated.
 *  ─────────────────────────────────────────────────────────────────────
 */

import {
  buildErpPayload,
  countSyncBatches,
  getPendingLogs,
  insertSyncBatch,
  markLogsFailed,
  markLogsSynced,
} from "@/lib/db";
import type { ErpSyncPostResponse, SyncBatchDto } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface ErpConfig {
  mode: "mock" | "live";
  url: string | null;
  apiKey: string | null;
  /** Simulator: fail every Nth batch with a 503 (0 = never fail). */
  failEvery: number;
}

export function erpConfig(): ErpConfig {
  const url = process.env.ERP_API_URL?.trim() || null;
  const mockFlag = process.env.ERP_MOCK_MODE?.toLowerCase();
  // Live mode only when a real URL exists AND mocks are not forced on.
  const mode: ErpConfig["mode"] = url && mockFlag !== "true" ? "live" : "mock";
  return {
    mode,
    url,
    apiKey: process.env.ERP_API_KEY?.trim() || null,
    failEvery: Number(process.env.ERP_MOCK_FAIL_EVERY ?? 5),
  };
}

/* ------------------------------------------------------------------ */
/* Concurrency guard                                                   */
/* ------------------------------------------------------------------ */

// One sync at a time process-wide (stored on globalThis so independently
// bundled route modules observe the same lock).
type GlobalWithLock = typeof globalThis & { __taErpSyncLock?: boolean };
const g = globalThis as GlobalWithLock;

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

interface DeliveryResult {
  ok: boolean;
  code: number | null;
  error: string | null;
}

/**
 * Push the payload to the ERP.
 *
 * ── REAL INTEGRATION POINT ────────────────────────────────────────────
 * The live branch below is the ONLY code that talks to the outside ERP.
 * Swap the fetch options (auth header, payload shape, idempotency key …)
 * to match your ERP vendor's contract. Everything else in this file is
 * transport-agnostic.
 * ──────────────────────────────────────────────────────────────────────
 */
async function deliver(
  payloadJson: string,
  cfg: ErpConfig,
  batchSeq: number
): Promise<DeliveryResult> {
  if (cfg.mode === "live") {
    if (!cfg.url) {
      // Config error: ERP_MOCK_MODE=false but no URL provided.
      return { ok: false, code: null, error: "ERP_API_URL is not configured" };
    }
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Source": "TA-BRIDGE",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: payloadJson,
        signal: AbortSignal.timeout(8_000), // treat slow ERP as unreachable
      });

      if (res.ok) return { ok: true, code: res.status, error: null };

      const detail = `ERP responded ${res.status}`;
      if (res.status >= 400 && res.status < 500) {
        // 4xx → the records themselves were rejected; retrying won't help.
        return { ok: false, code: res.status, error: `${detail} — record rejected` };
      }
      // 5xx / unreachable → transient; records remain Pending (buffered).
      return { ok: false, code: res.status, error: detail };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: null, error: `ERP unreachable — ${message}` };
    }
  }

  /* ── ERP SIMULATOR (default) ──────────────────────────────────────
     Stands in for the external ERP so the whole data flow is observable
     without a live system. Adds realistic latency and, every Nth batch,
     a simulated outage to demonstrate offline buffering.             */
  await new Promise((r) => setTimeout(r, 350 + Math.random() * 550));

  const shouldFail =
    cfg.failEvery > 0 && batchSeq > 0 && batchSeq % cfg.failEvery === 0;

  if (shouldFail) {
    return {
      ok: false,
      code: 503,
      error: "Simulated ERP outage (offline-buffering demo) — will retry",
    };
  }
  return { ok: true, code: 200, error: null };
}

/* ------------------------------------------------------------------ */
/* Sync run                                                             */
/* ------------------------------------------------------------------ */

/**
 * Gather all Pending logs and push them to the ERP.
 * Safe to call from the manual "Force Sync Now" button, the background
 * retry loop, or an external cron — re-entrancy is blocked by a lock.
 */
export async function runErpSync(
  trigger: "Manual" | "Auto" = "Manual"
): Promise<ErpSyncPostResponse> {
  if (g.__taErpSyncLock) {
    return {
      ok: false,
      attempted: 0,
      synced: 0,
      failed: 0,
      message: "A sync is already in progress — try again in a moment.",
      batch: null,
      trigger,
    };
  }

  g.__taErpSyncLock = true;
  try {
    const cfg = erpConfig();
    const pending = getPendingLogs(500);

    if (pending.length === 0) {
      return {
        ok: true,
        attempted: 0,
        synced: 0,
        failed: 0,
        message: "Buffer is empty — every punch has reached the ERP.",
        batch: null,
        trigger,
      };
    }

    const logIds = pending.map((l) => l.Log_ID);
    const batchRef = `TAB-${Date.now().toString(36).toUpperCase()}`;
    const payload = buildErpPayload(logIds, batchRef);

    const started = Date.now();
    const result = await deliver(JSON.stringify(payload), cfg, countSyncBatches() + 1);
    const duration = Date.now() - started;

    // Records that were marked Failed by an earlier 4xx are excluded above
    // (only Pending is gathered), so classification here is unambiguous:
    //   ok        → Success
    //   transient → stay Pending (offline buffer)
    //   4xx       → Failed (quarantine)
    const permanentReject =
      !result.ok && result.code !== null && result.code >= 400 && result.code < 500;

    if (result.ok) markLogsSynced(logIds);
    else if (permanentReject) markLogsFailed(logIds);

    const batchRow = insertSyncBatch({
      recordCount: payload.record_count,
      status: result.ok ? "Success" : "Failed",
      responseCode: result.code,
      errorMessage: result.error,
      durationMs: duration,
      trigger,
      payload,
    });

    const batch: SyncBatchDto = {
      batchId: batchRow.Batch_ID,
      createdAt: batchRow.Created_At,
      recordCount: batchRow.Record_Count,
      status: batchRow.Status,
      responseCode: batchRow.Response_Code,
      errorMessage: batchRow.Error_Message,
      durationMs: batchRow.Duration_MS,
      trigger: batchRow.Trigger_Source === "Manual" ? "Manual" : "Auto",
      payload,
    };

    if (result.ok) {
      return {
        ok: true,
        attempted: payload.record_count,
        synced: payload.record_count,
        failed: 0,
        message: `ERP acknowledged ${payload.record_count} record(s) — HTTP 200 in ${duration}ms.`,
        batch,
        trigger,
      };
    }

    return {
      ok: false,
      attempted: payload.record_count,
      synced: 0,
      failed: permanentReject ? payload.record_count : 0,
      message: `${result.error ?? "ERP push failed"} — ${payload.record_count} record(s) ${
        permanentReject ? "quarantined as Failed" : "retained as Pending (offline buffer)"
      }.`,
      batch,
      trigger,
    };
  } catch (err) {
    // Unexpected bridge-side error — never lose the buffer.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      attempted: 0,
      synced: 0,
      failed: 0,
      message: `Sync engine error: ${message}`,
      batch: null,
      trigger,
    };
  } finally {
    g.__taErpSyncLock = false;
  }
}
