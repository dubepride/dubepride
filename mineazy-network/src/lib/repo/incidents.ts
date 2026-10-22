/**
 * ============================================================================
 *  repo/incidents.ts — incident lifecycle
 * ============================================================================
 *
 *  One open incident per dedupe key. A key encodes the *kind* of failure
 *  and the asset it happened on, so a device that keeps failing updates its
 *  existing incident instead of flooding the notification centre.
 *
 *  Incident states
 *    open        → new, not yet seen by a human
 *    acknowledged → a human has seen it and taken ownership
 *    resolved    → recovered (or closed manually)
 */

import { getDb, queryAll, queryOne, exec, run } from "../db";
import type { Incident, IncidentState, Severity } from "../types";

interface IncidentRow {
  Incident_ID: number;
  Dedupe_Key: string;
  Category: string;
  Severity: string;
  Title: string;
  Device_ID: number | null;
  Connection_ID: number | null;
  Started_At: number;
  Updated_At: number;
  Recovered_At: number | null;
  State: string;
  Evidence: string;
  Affected: string;
  Fault_Location: string;
  Confidence: number;
  Acknowledged: number;
  Acknowledged_By: string | null;
  Assigned_To: string | null;
  Notes: string;
}

function toIncident(row: IncidentRow): Incident {
  let affected: number[] = [];
  try {
    const parsed = JSON.parse(row.Affected || "[]");
    if (Array.isArray(parsed)) affected = parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  } catch {
    affected = [];
  }
  return {
    id: row.Incident_ID,
    key: row.Dedupe_Key,
    category: row.Category,
    severity: row.Severity as Severity,
    title: row.Title,
    deviceId: row.Device_ID,
    connectionId: row.Connection_ID,
    startedAt: row.Started_At,
    updatedAt: row.Updated_At,
    recoveredAt: row.Recovered_At,
    state: row.State as IncidentState,
    evidence: row.Evidence,
    affected,
    faultLocation: row.Fault_Location,
    confidence: row.Confidence,
    acknowledged: row.Acknowledged === 1,
    acknowledgedBy: row.Acknowledged_By,
    assignedTo: row.Assigned_To,
    notes: row.Notes,
  };
}

/** Every incident (newest first). */
export async function listIncidents(filter: {
  state?: IncidentState | "active" | "all";
  limit?: number;
} = {}): Promise<Incident[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.state === "active") {
    where.push("State <> 'resolved'");
  } else if (filter.state && filter.state !== "all") {
    where.push("State = ?");
    args.push(filter.state);
  }
  const rows = await queryAll<IncidentRow>(
    await getDb(),
    `SELECT * FROM Incidents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY Started_At DESC LIMIT ?`,
    ...args,
    filter.limit ?? 200
  );
  return rows.map(toIncident);
}

/** One incident by id. */
export async function getIncident(id: number): Promise<Incident | null> {
  const row = await queryOne<IncidentRow>(await getDb(), "SELECT * FROM Incidents WHERE Incident_ID = ?", id);
  return row ? toIncident(row) : null;
}

/** The open incident for a dedupe key (if any). */
export async function openIncidentByKey(key: string): Promise<Incident | null> {
  const row = await queryOne<IncidentRow>(
    await getDb(),
    "SELECT * FROM Incidents WHERE Dedupe_Key = ? AND State <> 'resolved' ORDER BY Incident_ID DESC LIMIT 1",
    key
  );
  return row ? toIncident(row) : null;
}

/** Create a new incident. */
export async function createIncident(input: {
  key: string;
  category: string;
  severity: Severity;
  title: string;
  deviceId?: number | null;
  connectionId?: number | null;
  evidence?: string;
  affected?: number[];
  faultLocation?: string;
  confidence?: number;
}): Promise<number> {
  const now = Date.now();
  const { lastId } = await run(
    await getDb(),
    `INSERT INTO Incidents
      (Dedupe_Key, Category, Severity, Title, Device_ID, Connection_ID, Started_At, Updated_At,
       State, Evidence, Affected, Fault_Location, Confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    input.key,
    input.category,
    input.severity,
    input.title,
    input.deviceId ?? null,
    input.connectionId ?? null,
    now,
    now,
    input.evidence ?? "",
    JSON.stringify(input.affected ?? []),
    input.faultLocation ?? "",
    input.confidence ?? 0.5
  );
  return lastId;
}

/** Update an incident in place (evidence, severity, affected set…). */
export async function updateIncident(
  id: number,
  patch: {
    severity?: Severity;
    title?: string;
    evidence?: string;
    affected?: number[];
    faultLocation?: string;
    confidence?: number;
    notes?: string;
    assignedTo?: string | null;
  }
): Promise<void> {
  const db = await getDb();
  const current = await queryOne<IncidentRow>(db, "SELECT * FROM Incidents WHERE Incident_ID = ?", id);
  if (!current) throw new Error("That incident no longer exists.");
  const incident = toIncident(current);
  await exec(
    db,
    `UPDATE Incidents
        SET Severity = ?, Title = ?, Evidence = ?, Affected = ?, Fault_Location = ?, Confidence = ?,
            Notes = ?, Assigned_To = ?, Updated_At = ?
      WHERE Incident_ID = ?`,
    patch.severity ?? incident.severity,
    patch.title ?? incident.title,
    patch.evidence ?? incident.evidence,
    JSON.stringify(patch.affected ?? incident.affected),
    patch.faultLocation ?? incident.faultLocation,
    patch.confidence ?? incident.confidence,
    patch.notes ?? incident.notes,
    patch.assignedTo === undefined ? incident.assignedTo : patch.assignedTo,
    Date.now(),
    id
  );
}

/** Acknowledge an incident. */
export async function acknowledgeIncident(id: number, user: string): Promise<void> {
  await exec(
    await getDb(),
    `UPDATE Incidents
        SET Acknowledged = 1, Acknowledged_By = ?, State = CASE WHEN State = 'open' THEN 'acknowledged' ELSE State END,
            Updated_At = ?
      WHERE Incident_ID = ?`,
    user,
    Date.now(),
    id
  );
}

/** Resolve (recover) an incident. */
export async function resolveIncident(id: number, note?: string): Promise<void> {
  const db = await getDb();
  await exec(
    db,
    `UPDATE Incidents
        SET State = 'resolved', Recovered_At = ?, Updated_At = ?,
            Notes = CASE WHEN ? IS NULL THEN Notes ELSE ? END
      WHERE Incident_ID = ?`,
    Date.now(),
    Date.now(),
    note ?? null,
    note ?? null,
    id
  );
  void db;
}

/** Counts per severity for the open incidents (overview tiles). */
export async function incidentCounts(): Promise<Record<string, number>> {
  const rows = await queryAll<{ Severity: string; c: number }>(
    await getDb(),
    "SELECT Severity, COUNT(*) AS c FROM Incidents WHERE State <> 'resolved' GROUP BY Severity"
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.Severity] = row.c;
  return out;
}
