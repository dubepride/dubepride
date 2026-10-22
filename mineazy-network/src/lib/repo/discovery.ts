/**
 * ============================================================================
 *  repo/discovery.ts — authorised scan ranges + discovery job history
 * ============================================================================
 *
 *  The collector may only ever touch the ranges an administrator registered
 *  here. Anything outside this list is refused by lib/net/discovery.ts
 *  before a single packet is sent.
 */

import { getDb, queryAll, queryOne, exec, run } from "../db";

export interface ScanTarget {
  id: number;
  cidr: string;
  description: string;
  enabled: boolean;
  createdAt: number;
  lastScanAt: number | null;
}

interface TargetRow {
  Target_ID: number;
  CIDR: string;
  Description: string;
  Enabled: number;
  Created_At: number;
  Last_Scan_At: number | null;
}

function toTarget(row: TargetRow): ScanTarget {
  return {
    id: row.Target_ID,
    cidr: row.CIDR,
    description: row.Description,
    enabled: row.Enabled === 1,
    createdAt: row.Created_At,
    lastScanAt: row.Last_Scan_At,
  };
}

/** Every registered range. */
export async function listScanTargets(): Promise<ScanTarget[]> {
  const rows = await queryAll<TargetRow>(await getDb(), "SELECT * FROM Scan_Targets ORDER BY CIDR");
  return rows.map(toTarget);
}

/** Enabled ranges only. */
export async function enabledScanTargets(): Promise<ScanTarget[]> {
  const rows = await queryAll<TargetRow>(
    await getDb(),
    "SELECT * FROM Scan_Targets WHERE Enabled = 1 ORDER BY CIDR"
  );
  return rows.map(toTarget);
}

/** One range by id. */
export async function getScanTarget(id: number): Promise<ScanTarget | null> {
  const row = await queryOne<TargetRow>(
    await getDb(),
    "SELECT * FROM Scan_Targets WHERE Target_ID = ?",
    id
  );
  return row ? toTarget(row) : null;
}

/** Add a range. */
export async function createScanTarget(cidr: string, description = ""): Promise<number> {
  const trimmed = cidr.trim();
  if (!trimmed) throw new Error("A CIDR range is required.");
  const existing = await queryOne<{ c: number }>(
    await getDb(),
    "SELECT COUNT(*) AS c FROM Scan_Targets WHERE CIDR = ?",
    trimmed
  );
  if ((existing?.c ?? 0) > 0) throw new Error("That range is already registered.");
  const { lastId } = await run(
    await getDb(),
    "INSERT INTO Scan_Targets (CIDR, Description, Enabled, Created_At) VALUES (?, ?, 1, ?)",
    trimmed,
    description,
    Date.now()
  );
  return lastId;
}

/** Update a range (enable/disable, description). */
export async function updateScanTarget(
  id: number,
  patch: { description?: string; enabled?: boolean }
): Promise<void> {
  const db = await getDb();
  const current = await queryOne<TargetRow>(db, "SELECT * FROM Scan_Targets WHERE Target_ID = ?", id);
  if (!current) throw new Error("That range no longer exists.");
  await exec(
    db,
    "UPDATE Scan_Targets SET Description = ?, Enabled = ? WHERE Target_ID = ?",
    patch.description ?? current.Description,
    patch.enabled === undefined ? current.Enabled : patch.enabled ? 1 : 0,
    id
  );
}

/** Remove a range. */
export async function deleteScanTarget(id: number): Promise<void> {
  await exec(await getDb(), "DELETE FROM Scan_Targets WHERE Target_ID = ?", id);
}

/** Stamp a range as just scanned. */
export async function touchScanTarget(id: number): Promise<void> {
  await exec(await getDb(), "UPDATE Scan_Targets SET Last_Scan_At = ? WHERE Target_ID = ?", Date.now(), id);
}

/* ------------------------------------------------------------------ */
/* Discovery jobs                                                      */
/* ------------------------------------------------------------------ */

export interface DiscoveryJob {
  id: number;
  kind: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  scope: string;
  summary: string;
  error: string;
}

interface JobRow {
  Job_ID: number;
  Kind: string;
  Started_At: number;
  Finished_At: number | null;
  Status: string;
  Scope: string;
  Summary: string;
  Error: string;
}

function toJob(row: JobRow): DiscoveryJob {
  return {
    id: row.Job_ID,
    kind: row.Kind,
    startedAt: row.Started_At,
    finishedAt: row.Finished_At,
    status: row.Status,
    scope: row.Scope,
    summary: row.Summary,
    error: row.Error,
  };
}

/** Start a job record. */
export async function startJob(kind: string, scope: string): Promise<number> {
  const { lastId } = await run(
    await getDb(),
    "INSERT INTO Discovery_Jobs (Kind, Started_At, Status, Scope) VALUES (?, ?, 'running', ?)",
    kind,
    Date.now(),
    scope
  );
  return lastId;
}

/** Finish a job record. */
export async function finishJob(
  id: number,
  status: string,
  summary: string,
  error = ""
): Promise<void> {
  await exec(
    await getDb(),
    "UPDATE Discovery_Jobs SET Finished_At = ?, Status = ?, Summary = ?, Error = ? WHERE Job_ID = ?",
    Date.now(),
    status,
    summary,
    error,
    id
  );
}

/** Job history, newest first. */
export async function listJobs(limit = 25): Promise<DiscoveryJob[]> {
  const rows = await queryAll<JobRow>(
    await getDb(),
    "SELECT * FROM Discovery_Jobs ORDER BY Started_At DESC LIMIT ?",
    limit
  );
  return rows.map(toJob);
}
