/**
 * ============================================================================
 *  repo/ports.ts — switch / device interfaces
 * ============================================================================
 *
 *  A "port" is one network interface on a device: a physical switch port, a
 *  router LAN port, an uplink. Managed switches expose their full interface
 *  inventory over SNMP, so a 24-port switch produces exactly 24 rows with
 *  the real interface identifiers — never a fabricated port list.
 *
 *  Counter columns hold the last raw SNMP values; the derived rates live in
 *  In_Rate_Bps / Out_Rate_Bps and are recomputed by lib/traffic.ts whenever a
 *  new sample arrives.
 */

import { getDb, queryAll, queryOne, exec, run } from "../db";
import type { NetworkPort } from "../types";

interface PortRow {
  Port_ID: number;
  Device_ID: number;
  If_Index: number | null;
  If_Name: string;
  Port_Number: number | null;
  Description: string;
  Admin_State: string;
  Oper_State: string;
  Speed_Bps: number | null;
  Duplex: string | null;
  VLAN: number | null;
  Last_State_Change: number | null;
  In_Octets: number | null;
  Out_Octets: number | null;
  In_Packets: number | null;
  Out_Packets: number | null;
  In_Errors: number | null;
  Out_Errors: number | null;
  In_Discards: number | null;
  Out_Discards: number | null;
  In_Rate_Bps: number | null;
  Out_Rate_Bps: number | null;
  Last_Polled_At: number | null;
  Source: string;
  Label: string;
  Notes: string;
  Managed: number;
}

function toPort(row: PortRow): NetworkPort {
  return {
    id: row.Port_ID,
    deviceId: row.Device_ID,
    ifIndex: row.If_Index,
    ifName: row.If_Name,
    portNumber: row.Port_Number,
    description: row.Description,
    adminState: row.Admin_State,
    operState: row.Oper_State,
    speedBps: row.Speed_Bps,
    duplex: row.Duplex,
    vlan: row.VLAN,
    lastStateChange: row.Last_State_Change,
    inOctets: row.In_Octets,
    outOctets: row.Out_Octets,
    inPackets: row.In_Packets,
    outPackets: row.Out_Packets,
    inErrors: row.In_Errors,
    outErrors: row.Out_Errors,
    inDiscards: row.In_Discards,
    outDiscards: row.Out_Discards,
    inRateBps: row.In_Rate_Bps,
    outRateBps: row.Out_Rate_Bps,
    lastPolledAt: row.Last_Polled_At,
    source: row.Source,
    label: row.Label,
    notes: row.Notes,
    managed: row.Managed === 1,
  };
}

/** Every port of one device, ordered by port number then name. */
export async function listPorts(deviceId: number): Promise<NetworkPort[]> {
  const rows = await queryAll<PortRow>(
    await getDb(),
    "SELECT * FROM Ports WHERE Device_ID = ? ORDER BY COALESCE(Port_Number, 9999), If_Name",
    deviceId
  );
  return rows.map(toPort);
}

/** Every port in the system (used by the topology builder). */
export async function listAllPorts(): Promise<NetworkPort[]> {
  const rows = await queryAll<PortRow>(await getDb(), "SELECT * FROM Ports ORDER BY Device_ID");
  return rows.map(toPort);
}

/** One port by id. */
export async function getPort(id: number): Promise<NetworkPort | null> {
  const row = await queryOne<PortRow>(await getDb(), "SELECT * FROM Ports WHERE Port_ID = ?", id);
  return row ? toPort(row) : null;
}

/** One port by device + interface name. */
export async function portByName(deviceId: number, ifName: string): Promise<NetworkPort | null> {
  const row = await queryOne<PortRow>(
    await getDb(),
    "SELECT * FROM Ports WHERE Device_ID = ? AND If_Name = ? COLLATE NOCASE LIMIT 1",
    deviceId,
    ifName
  );
  return row ? toPort(row) : null;
}

/** The SNMP interface table values reported for a port. */
export interface PortObservation {
  /** SNMP ifIndex when the port came from SNMP. Unknown for manual ports. */
  ifIndex?: number | null;
  ifName: string;
  portNumber?: number | null;
  description?: string;
  adminState?: string;
  operState?: string;
  speedBps?: number | null;
  duplex?: string | null;
  vlan?: number | null;
  lastStateChange?: number | null;
  inOctets?: number | null;
  outOctets?: number | null;
  inPackets?: number | null;
  outPackets?: number | null;
  inErrors?: number | null;
  outErrors?: number | null;
  inDiscards?: number | null;
  outDiscards?: number | null;
  source?: string;
  managed?: boolean;
}

/**
 * Create or refresh a port from an observation.
 *
 * Administrator-owned fields (Label, Notes) are preserved — discovery never
 * overwrites them.
 */
export async function upsertPort(
  deviceId: number,
  observation: PortObservation
): Promise<{ id: number; created: boolean; previousOperState: string | null }> {
  const db = await getDb();
  const existing = await queryOne<PortRow>(
    db,
    "SELECT * FROM Ports WHERE Device_ID = ? AND If_Name = ? COLLATE NOCASE LIMIT 1",
    deviceId,
    observation.ifName
  );

  if (!existing) {
    const { lastId } = await run(
      db,
      `INSERT INTO Ports
        (Device_ID, If_Index, If_Name, Port_Number, Description, Admin_State, Oper_State, Speed_Bps,
         Duplex, VLAN, Last_State_Change, In_Octets, Out_Octets, In_Packets, Out_Packets,
         In_Errors, Out_Errors, In_Discards, Out_Discards, Last_Polled_At, Source, Managed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      deviceId,
      observation.ifIndex ?? null,
      observation.ifName,
      observation.portNumber ?? null,
      observation.description ?? "",
      observation.adminState ?? "unknown",
      observation.operState ?? "unknown",
      observation.speedBps ?? null,
      observation.duplex ?? null,
      observation.vlan ?? null,
      observation.lastStateChange ?? null,
      observation.inOctets ?? null,
      observation.outOctets ?? null,
      observation.inPackets ?? null,
      observation.outPackets ?? null,
      observation.inErrors ?? null,
      observation.outErrors ?? null,
      observation.inDiscards ?? null,
      observation.outDiscards ?? null,
      Date.now(),
      observation.source ?? "snmp",
      observation.managed === false ? 0 : 1
    );
    return { id: lastId, created: true, previousOperState: null };
  }

  const port = toPort(existing);
  await exec(
    db,
    `UPDATE Ports
        SET If_Index = ?, Port_Number = COALESCE(?, Port_Number),
            Description = CASE WHEN Description = '' THEN ? ELSE Description END,
            Admin_State = ?, Oper_State = ?, Speed_Bps = ?, Duplex = ?, VLAN = ?,
            Last_State_Change = COALESCE(?, Last_State_Change),
            In_Octets = ?, Out_Octets = ?, In_Packets = ?, Out_Packets = ?,
            In_Errors = ?, Out_Errors = ?, In_Discards = ?, Out_Discards = ?,
            Last_Polled_At = ?, Source = ?, Managed = ?
      WHERE Port_ID = ?`,
    observation.ifIndex ?? port.ifIndex,
    observation.portNumber ?? null,
    observation.description ?? "",
    observation.adminState ?? port.adminState,
    observation.operState ?? port.operState,
    observation.speedBps ?? port.speedBps,
    observation.duplex ?? port.duplex,
    observation.vlan ?? port.vlan,
    observation.lastStateChange ?? null,
    observation.inOctets ?? null,
    observation.outOctets ?? null,
    observation.inPackets ?? null,
    observation.outPackets ?? null,
    observation.inErrors ?? null,
    observation.outErrors ?? null,
    observation.inDiscards ?? null,
    observation.outDiscards ?? null,
    Date.now(),
    observation.source ?? port.source,
    observation.managed === false ? 0 : 1,
    port.id
  );
  return { id: port.id, created: false, previousOperState: port.operState };
}

/** Store freshly calculated rates on a port. */
export async function setPortRates(id: number, inRateBps: number | null, outRateBps: number | null): Promise<void> {
  await exec(
    await getDb(),
    "UPDATE Ports SET In_Rate_Bps = ?, Out_Rate_Bps = ?, Last_Polled_At = ? WHERE Port_ID = ?",
    inRateBps,
    outRateBps,
    Date.now(),
    id
  );
}

/** Administrator edit of a port (label, notes, description). */
export async function updatePort(
  id: number,
  patch: { label?: string; notes?: string; description?: string }
): Promise<void> {
  const db = await getDb();
  const current = await queryOne<PortRow>(db, "SELECT * FROM Ports WHERE Port_ID = ?", id);
  if (!current) throw new Error("That port no longer exists.");
  await exec(
    db,
    "UPDATE Ports SET Label = ?, Notes = ?, Description = ? WHERE Port_ID = ?",
    patch.label ?? current.Label,
    patch.notes ?? current.Notes,
    patch.description ?? current.Description,
    id
  );
}

/** Delete a port record. */
export async function deletePort(id: number): Promise<void> {
  await exec(await getDb(), "DELETE FROM Ports WHERE Port_ID = ?", id);
}

/** Port totals used by the switch summary panel. */
export interface PortSummary {
  total: number;
  active: number;
  withConnection: number;
  unresolved: number;
  down: number;
}

export async function portSummary(deviceId: number): Promise<PortSummary> {
  const db = await getDb();
  const total =
    (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Ports WHERE Device_ID = ?", deviceId))?.c ?? 0;
  const active =
    (await queryOne<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM Ports WHERE Device_ID = ? AND Oper_State = 'up'",
      deviceId
    ))?.c ?? 0;
  const down =
    (await queryOne<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM Ports WHERE Device_ID = ? AND Oper_State = 'down'",
      deviceId
    ))?.c ?? 0;
  const connected =
    (await queryOne<{ c: number }>(
      db,
      `SELECT COUNT(DISTINCT Local_Port_ID) AS c FROM Connections
        WHERE (Local_Device_ID = ? OR Remote_Device_ID = ?) AND Local_Port_ID IS NOT NULL`,
      deviceId,
      deviceId
    ))?.c ?? 0;
  return { total, active, withConnection: connected, unresolved: Math.max(0, active - connected), down };
}
