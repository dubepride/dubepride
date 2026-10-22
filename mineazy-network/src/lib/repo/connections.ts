/**
 * ============================================================================
 *  repo/connections.ts — the topology edges
 * ============================================================================
 *
 *  A connection records "device A's port X is cabled to device B's port Y".
 *  Every row keeps its provenance (LLDP, CDP, FDB, ARP, active scan,
 *  manual, import, simulation) and a confidence value, so the UI can show
 *  *how* we know a link exists instead of presenting inference as fact.
 *
 *  Deduplication: the natural key is
 *      localDevice|localPort|remoteDevice|remotePort
 *  with the two sides interchangeable (a link is a link).
 */

import { getDb, queryAll, queryOne, exec, run } from "../db";
import type { Connection, ConnectionSource, ConnectionType } from "../types";

interface ConnectionRow {
  Connection_ID: number;
  Local_Device_ID: number;
  Local_Port_ID: number | null;
  Remote_Device_ID: number;
  Remote_Port_ID: number | null;
  Type: string;
  Source: string;
  Confidence: number;
  Verified: number;
  Cable_ID: string;
  Cable_Destination: string;
  Notes: string;
  State: string;
  Evidence: string;
  Last_Observed_At: number | null;
  Created_At: number;
  Updated_At: number;
}

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.Connection_ID,
    localDeviceId: row.Local_Device_ID,
    localPortId: row.Local_Port_ID,
    remoteDeviceId: row.Remote_Device_ID,
    remotePortId: row.Remote_Port_ID,
    type: row.Type as ConnectionType,
    source: row.Source as ConnectionSource,
    confidence: row.Confidence,
    verified: row.Verified === 1,
    cableId: row.Cable_ID,
    cableDestination: row.Cable_Destination,
    notes: row.Notes,
    state: row.State,
    evidence: row.Evidence,
    lastObservedAt: row.Last_Observed_At,
    createdAt: row.Created_At,
    updatedAt: row.Updated_At,
  };
}

/** Normalised key for a link, order independent. */
export function connectionKey(
  localDeviceId: number,
  localPortId: number | null,
  remoteDeviceId: number,
  remotePortId: number | null
): string {
  const a = `${localDeviceId}:${localPortId ?? "-"}`;
  const b = `${remoteDeviceId}:${remotePortId ?? "-"}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Every connection. */
export async function listConnections(): Promise<Connection[]> {
  const rows = await queryAll<ConnectionRow>(await getDb(), "SELECT * FROM Connections ORDER BY Connection_ID");
  return rows.map(toConnection);
}

/** Connections touching one device. */
export async function connectionsForDevice(deviceId: number): Promise<Connection[]> {
  const rows = await queryAll<ConnectionRow>(
    await getDb(),
    "SELECT * FROM Connections WHERE Local_Device_ID = ? OR Remote_Device_ID = ?",
    deviceId,
    deviceId
  );
  return rows.map(toConnection);
}

/** One connection by id. */
export async function getConnection(id: number): Promise<Connection | null> {
  const row = await queryOne<ConnectionRow>(
    await getDb(),
    "SELECT * FROM Connections WHERE Connection_ID = ?",
    id
  );
  return row ? toConnection(row) : null;
}

export interface ConnectionInput {
  localDeviceId: number;
  localPortId?: number | null;
  remoteDeviceId: number;
  remotePortId?: number | null;
  type?: ConnectionType;
  source?: ConnectionSource;
  confidence?: number;
  verified?: boolean;
  cableId?: string;
  cableDestination?: string;
  notes?: string;
  state?: string;
  evidence?: string;
}

/**
 * Create or refresh a connection.
 *
 * Administrator-created links are never overwritten by discovery (the
 * manual cable id, label and verification flag survive rediscovery); the
 * discovered side still updates the state + evidence.
 */
export async function upsertConnection(input: ConnectionInput): Promise<{ id: number; created: boolean }> {
  const db = await getDb();
  const key = connectionKey(
    input.localDeviceId,
    input.localPortId ?? null,
    input.remoteDeviceId,
    input.remotePortId ?? null
  );
  const existing = await queryOne<ConnectionRow>(
    db,
    `SELECT * FROM Connections
      WHERE (Local_Device_ID = ? AND (Local_Port_ID IS ?))
         OR (Local_Device_ID = ? AND (Local_Port_ID IS ?))`,
    input.remoteDeviceId,
    input.remotePortId ?? null,
    input.localDeviceId,
    input.localPortId ?? null
  );

  const now = Date.now();
  if (!existing) {
    const { lastId } = await run(
      db,
      `INSERT INTO Connections
        (Local_Device_ID, Local_Port_ID, Remote_Device_ID, Remote_Port_ID, Type, Source, Confidence,
         Verified, Cable_ID, Cable_Destination, Notes, State, Evidence, Last_Observed_At, Created_At, Updated_At)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.localDeviceId,
      input.localPortId ?? null,
      input.remoteDeviceId,
      input.remotePortId ?? null,
      input.type ?? "unknown",
      input.source ?? "unknown",
      input.confidence ?? 0.5,
      input.verified ? 1 : 0,
      input.cableId ?? "",
      input.cableDestination ?? "",
      input.notes ?? "",
      input.state ?? "unknown",
      input.evidence ?? "",
      now,
      now,
      now
    );
    void key;
    return { id: lastId, created: true };
  }

  const connection = toConnection(existing);
  const isManual = connection.source === "manual" && connection.verified;
  await exec(
    db,
    `UPDATE Connections
        SET Local_Port_ID = COALESCE(?, Local_Port_ID),
            Remote_Port_ID = COALESCE(?, Remote_Port_ID),
            Type = ?, Source = ?, Confidence = ?, State = ?, Evidence = ?, Last_Observed_At = ?, Updated_At = ?
      WHERE Connection_ID = ?`,
    input.localPortId ?? null,
    input.remotePortId ?? null,
    isManual ? connection.type : input.type ?? connection.type,
    isManual ? connection.source : input.source ?? connection.source,
    isManual ? connection.confidence : input.confidence ?? connection.confidence,
    input.state ?? connection.state,
    input.evidence ?? connection.evidence,
    now,
    now,
    connection.id
  );
  return { id: connection.id, created: false };
}

/** Update the evidence-backed state of a link. */
export async function setConnectionState(
  id: number,
  state: string,
  evidence: string
): Promise<void> {
  await exec(
    await getDb(),
    "UPDATE Connections SET State = ?, Evidence = ?, Last_Observed_At = ?, Updated_At = ? WHERE Connection_ID = ?",
    state,
    evidence,
    Date.now(),
    Date.now(),
    id
  );
}

/** Administrator edit of a connection (cable id, destination, notes, verify). */
export async function updateConnection(
  id: number,
  patch: Partial<ConnectionInput>
): Promise<void> {
  const db = await getDb();
  const current = await queryOne<ConnectionRow>(db, "SELECT * FROM Connections WHERE Connection_ID = ?", id);
  if (!current) throw new Error("That connection no longer exists.");
  const connection = toConnection(current);
  await exec(
    db,
    `UPDATE Connections
        SET Local_Port_ID = ?, Remote_Port_ID = ?, Cable_ID = ?, Cable_Destination = ?, Notes = ?,
            Verified = ?, Type = ?, Source = ?, Updated_At = ?
      WHERE Connection_ID = ?`,
    patch.localPortId === undefined ? connection.localPortId : patch.localPortId,
    patch.remotePortId === undefined ? connection.remotePortId : patch.remotePortId,
    patch.cableId ?? connection.cableId,
    patch.cableDestination ?? connection.cableDestination,
    patch.notes ?? connection.notes,
    patch.verified === undefined ? (connection.verified ? 1 : 0) : patch.verified ? 1 : 0,
    patch.type ?? connection.type,
    patch.verified ? "manual" : patch.source ?? connection.source,
    Date.now(),
    id
  );
}

/** Delete a connection record. */
export async function deleteConnection(id: number): Promise<void> {
  await exec(await getDb(), "DELETE FROM Connections WHERE Connection_ID = ?", id);
}

/** Remove every automatically discovered connection (keeps manual records). */
export async function clearDiscoveredConnections(): Promise<number> {
  const db = await getDb();
  const before = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Connections"))?.c ?? 0;
  await exec(
    db,
    "DELETE FROM Connections WHERE Source <> 'manual' AND Verified = 0"
  );
  const after = (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Connections"))?.c ?? 0;
  return before - after;
}
