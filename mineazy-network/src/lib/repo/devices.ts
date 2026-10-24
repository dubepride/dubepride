/**
 * ============================================================================
 *  repo/devices.ts — the device inventory
 * ============================================================================
 *
 *  Two write paths into this table:
 *
 *    • manual  — an administrator edits the record. Their values win and are
 *                flagged (Name_Locked / Category_Locked) so a later rediscovery
 *                cannot silently overwrite them.
 *    • discovery — the collector reports what it saw. It may fill in blanks,
 *                enrich empty fields and update health, but it never replaces
 *                a locked field.
 */

import { getDb, queryAll, queryOne, exec, run } from "../db";
import { defaultPollSeconds } from "../settings";
import { suggestedName } from "../net/classify";
import type {
  Confidence,
  Criticality,
  Device,
  DeviceCategory,
  DiscoverySource,
  HealthState,
  MonitorMethod,
} from "../types";

interface DeviceRow {
  Device_ID: number;
  Name: string;
  Hostname: string;
  Category: string;
  Manufacturer: string;
  Model: string;
  Serial: string;
  Site_ID: number | null;
  Location_ID: number | null;
  Mgmt_IP: string;
  MAC: string;
  OS: string;
  Notes: string;
  Criticality: string;
  Monitoring_Enabled: number;
  Monitor_Method: string;
  Poll_Interval_Seconds: number;
  Failure_Threshold: number;
  Discovery_Source: string;
  Classification_Confidence: string;
  Classification_Evidence: string;
  Health_State: string;
  Health_Reason: string;
  First_Discovered_At: number | null;
  Last_Seen_At: number | null;
  Last_Observed_At: number | null;
  Simulated: number;
  Layout_X: number | null;
  Layout_Y: number | null;
  Name_Locked: number;
  Category_Locked: number;
  Created_At: number;
  Updated_At: number;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.Device_ID,
    name: row.Name,
    hostname: row.Hostname,
    category: row.Category as DeviceCategory,
    manufacturer: row.Manufacturer,
    model: row.Model,
    serial: row.Serial,
    siteId: row.Site_ID,
    locationId: row.Location_ID,
    mgmtIp: row.Mgmt_IP,
    mac: row.MAC,
    os: row.OS,
    notes: row.Notes,
    criticality: row.Criticality as Criticality,
    monitoringEnabled: row.Monitoring_Enabled === 1,
    monitorMethod: row.Monitor_Method as MonitorMethod,
    pollIntervalSeconds: row.Poll_Interval_Seconds,
    failureThreshold: row.Failure_Threshold,
    discoverySource: row.Discovery_Source as DiscoverySource,
    classificationConfidence: row.Classification_Confidence as Confidence,
    classificationEvidence: row.Classification_Evidence ?? "",
    healthState: row.Health_State as HealthState,
    healthReason: row.Health_Reason,
    firstDiscoveredAt: row.First_Discovered_At,
    lastSeenAt: row.Last_Seen_At,
    lastObservedAt: row.Last_Observed_At,
    simulated: row.Simulated === 1,
    layoutX: row.Layout_X,
    layoutY: row.Layout_Y,
    createdAt: row.Created_At,
    updatedAt: row.Updated_At,
  };
}

/** Every device, optionally filtered. */
export async function listDevices(filter: {
  category?: string;
  state?: string;
  siteId?: number;
  locationId?: number;
  search?: string;
  monitoredOnly?: boolean;
} = {}): Promise<Device[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.category) {
    where.push("Category = ?");
    args.push(filter.category);
  }
  if (filter.state) {
    where.push("Health_State = ?");
    args.push(filter.state);
  }
  if (filter.siteId !== undefined) {
    where.push("Site_ID = ?");
    args.push(filter.siteId);
  }
  if (filter.locationId !== undefined) {
    where.push("Location_ID = ?");
    args.push(filter.locationId);
  }
  if (filter.monitoredOnly) where.push("Monitoring_Enabled = 1");
  if (filter.search) {
    where.push(
      "(Name LIKE ? OR Hostname LIKE ? OR Mgmt_IP LIKE ? OR MAC LIKE ? OR Manufacturer LIKE ? OR Model LIKE ? OR Notes LIKE ?)"
    );
    const like = `%${filter.search}%`;
    args.push(like, like, like, like, like, like, like);
  }
  const sql = `SELECT * FROM Devices ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY Name COLLATE NOCASE`;
  const rows = await queryAll<DeviceRow>(await getDb(), sql, ...args);
  return rows.map(toDevice);
}

/** One device by id. */
export async function getDevice(id: number): Promise<Device | null> {
  const row = await queryOne<DeviceRow>(await getDb(), "SELECT * FROM Devices WHERE Device_ID = ?", id);
  if (!row) return null;
  const device = toDevice(row);
  device.ipAddresses = await deviceAddresses(id, "ip");
  device.macAddresses = await deviceAddresses(id, "mac");
  return device;
}

/** One device by management IP. */
export async function deviceByIp(ip: string): Promise<Device | null> {
  const row = await queryOne<DeviceRow>(
    await getDb(),
    "SELECT * FROM Devices WHERE Mgmt_IP = ? ORDER BY Device_ID LIMIT 1",
    ip
  );
  return row ? toDevice(row) : null;
}

/** One device by MAC address (case-insensitive). */
export async function deviceByMac(mac: string): Promise<Device | null> {
  const row = await queryOne<DeviceRow>(
    await getDb(),
    "SELECT * FROM Devices WHERE MAC = ? COLLATE NOCASE ORDER BY Device_ID LIMIT 1",
    mac
  );
  return row ? toDevice(row) : null;
}

/** Every observed address of a device ("ip" or "mac"). */
export async function deviceAddresses(deviceId: number, kind?: "ip" | "mac"): Promise<string[]> {
  const rows = await queryAll<{ Address: string }>(
    await getDb(),
    kind
      ? "SELECT Address FROM Device_Addresses WHERE Device_ID = ? AND Kind = ? ORDER BY Address"
      : "SELECT Address FROM Device_Addresses WHERE Device_ID = ? ORDER BY Address",
    ...(kind ? [deviceId, kind] : [deviceId])
  );
  return rows.map((r) => r.Address);
}

/** Record an observed IP/MAC for a device (deduplicated). */
export async function recordAddress(
  deviceId: number,
  kind: "ip" | "mac",
  address: string,
  source: string
): Promise<void> {
  if (!address) return;
  await exec(
    await getDb(),
    `INSERT INTO Device_Addresses (Device_ID, Kind, Address, Source, Observed_At)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(Device_ID, Kind, Address) DO UPDATE SET Observed_At = excluded.Observed_At, Source = excluded.Source`,
    deviceId,
    kind,
    address,
    source,
    Date.now()
  );
}

export interface DeviceInput {
  name: string;
  hostname?: string;
  category?: DeviceCategory;
  manufacturer?: string;
  model?: string;
  serial?: string;
  siteId?: number | null;
  locationId?: number | null;
  mgmtIp?: string;
  mac?: string;
  os?: string;
  notes?: string;
  criticality?: Criticality;
  monitoringEnabled?: boolean;
  monitorMethod?: MonitorMethod;
  pollIntervalSeconds?: number;
  failureThreshold?: number;
  discoverySource?: DiscoverySource;
  classificationConfidence?: Confidence;
  simulated?: boolean;
}

/** Create a device (manual or seeded). */
export async function createDevice(input: DeviceInput): Promise<number> {
  const now = Date.now();
  const name = input.name.trim();
  if (!name) throw new Error("Device name is required.");
  const { lastId } = await run(
    await getDb(),
    `INSERT INTO Devices
      (Name, Hostname, Category, Manufacturer, Model, Serial, Site_ID, Location_ID, Mgmt_IP, MAC, OS,
       Notes, Criticality, Monitoring_Enabled, Monitor_Method, Poll_Interval_Seconds, Failure_Threshold,
       Discovery_Source, Classification_Confidence, Health_State, Health_Reason, First_Discovered_At,
       Last_Observed_At, Simulated, Name_Locked, Category_Locked, Created_At, Updated_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', ?, ?, ?, ?, ?, ?, ?, ?)`,
    name,
    input.hostname ?? "",
    input.category ?? "unknown",
    input.manufacturer ?? "",
    input.model ?? "",
    input.serial ?? "",
    input.siteId ?? null,
    input.locationId ?? null,
    input.mgmtIp ?? "",
    input.mac ?? "",
    input.os ?? "",
    input.notes ?? "",
    input.criticality ?? "standard",
    input.monitoringEnabled === false ? 0 : 1,
    input.monitorMethod ?? "icmp",
    input.pollIntervalSeconds ?? (await defaultPollSeconds()),
    input.failureThreshold ?? 3,
    input.discoverySource ?? "manual",
    input.classificationConfidence ?? "confirmed",
    `Added to the inventory.`,
    now,
    now,
    input.simulated ? 1 : 0,
    // A manually created device is, by definition, administrator-owned.
    1,
    input.category && input.category !== "unknown" ? 1 : 0,
    now,
    now
  );
  return lastId;
}

/**
 * Apply an administrator edit.
 *
 * Setting the name or the category explicitly locks that field so a later
 * rediscovery cannot overwrite the administrator's decision.
 */
export async function updateDevice(id: number, patch: Partial<DeviceInput>): Promise<void> {
  const db = await getDb();
  const current = await queryOne<DeviceRow>(db, "SELECT * FROM Devices WHERE Device_ID = ?", id);
  if (!current) throw new Error("That device no longer exists.");

  const name = patch.name !== undefined ? patch.name.trim() : current.Name;
  if (!name) throw new Error("Device name is required.");

  const nameChanged = patch.name !== undefined && patch.name.trim() !== current.Name;
  const categoryChanged =
    patch.category !== undefined && patch.category !== current.Category;

  await exec(
    db,
    `UPDATE Devices
        SET Name = ?, Hostname = ?, Category = ?, Manufacturer = ?, Model = ?, Serial = ?,
            Site_ID = ?, Location_ID = ?, Mgmt_IP = ?, MAC = ?, OS = ?, Notes = ?, Criticality = ?,
            Monitoring_Enabled = ?, Monitor_Method = ?, Poll_Interval_Seconds = ?, Failure_Threshold = ?,
            Name_Locked = ?, Category_Locked = ?, Updated_At = ?
      WHERE Device_ID = ?`,
    name,
    patch.hostname ?? current.Hostname,
    patch.category ?? current.Category,
    patch.manufacturer ?? current.Manufacturer,
    patch.model ?? current.Model,
    patch.serial ?? current.Serial,
    patch.siteId === undefined ? current.Site_ID : patch.siteId,
    patch.locationId === undefined ? current.Location_ID : patch.locationId,
    patch.mgmtIp ?? current.Mgmt_IP,
    patch.mac ?? current.MAC,
    patch.os ?? current.OS,
    patch.notes ?? current.Notes,
    patch.criticality ?? current.Criticality,
    patch.monitoringEnabled === undefined ? current.Monitoring_Enabled : patch.monitoringEnabled ? 1 : 0,
    patch.monitorMethod ?? current.Monitor_Method,
    patch.pollIntervalSeconds ?? current.Poll_Interval_Seconds,
    patch.failureThreshold ?? current.Failure_Threshold,
    nameChanged || current.Name_Locked === 1 ? 1 : 0,
    categoryChanged || current.Category_Locked === 1 ? 1 : 0,
    Date.now(),
    id
  );
}

/** Persist a manual canvas position. */
export async function setDeviceLayout(id: number, x: number, y: number): Promise<void> {
  await exec(
    await getDb(),
    "UPDATE Devices SET Layout_X = ?, Layout_Y = ?, Updated_At = ? WHERE Device_ID = ?",
    x,
    y,
    Date.now(),
    id
  );
}

/** Clear every manual canvas position (reset to the automatic layout). */
export async function clearDeviceLayouts(): Promise<number> {
  const db = await getDb();
  // Count first: the driver's rowsAffected is not a reliable "how many rows
  // had a position" answer, and this number ends up in the audit log.
  const row = await queryOne<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM Devices WHERE Layout_X IS NOT NULL OR Layout_Y IS NOT NULL"
  );
  await run(
    db,
    "UPDATE Devices SET Layout_X = NULL, Layout_Y = NULL WHERE Layout_X IS NOT NULL OR Layout_Y IS NOT NULL"
  );
  return Number(row?.n ?? 0);
}

/** Update the health state + reason shown on the map and in the device list. */
export async function setDeviceHealth(
  id: number,
  state: HealthState,
  reason: string
): Promise<void> {
  await exec(
    await getDb(),
    "UPDATE Devices SET Health_State = ?, Health_Reason = ?, Updated_At = ? WHERE Device_ID = ?",
    state,
    reason,
    Date.now(),
    id
  );
}

/** Record that the collector observed the device (timestamps only). */
export async function touchDevice(
  id: number,
  opts: { seen?: boolean; observedAt?: number } = {}
): Promise<void> {
  const now = opts.observedAt ?? Date.now();
  await exec(
    await getDb(),
    `UPDATE Devices
        SET Last_Observed_At = ?, Last_Seen_At = CASE WHEN ? THEN ? ELSE Last_Seen_At END,
            Updated_At = ?
      WHERE Device_ID = ?`,
    now,
    opts.seen ? 1 : 0,
    now,
    now,
    id
  );
}

/** Mark a device as discovered for the first time. */
export async function markFirstDiscovered(id: number): Promise<void> {
  await exec(
    await getDb(),
    "UPDATE Devices SET First_Discovered_At = COALESCE(First_Discovered_At, ?) WHERE Device_ID = ?",
    Date.now(),
    id
  );
}

/**
 * Discovery upsert.
 *
 * The collector calls this with what it observed. Existing devices are
 * enriched (never overwritten where an administrator has decided), missing
 * devices are created with a provisional name.
 */
export async function upsertDiscoveredDevice(input: {
  ip?: string;
  mac?: string;
  hostname?: string;
  /** A friendly display name. Administrator-set names are never overwritten. */
  displayName?: string;
  category?: DeviceCategory;
  /** Why the category was chosen, quoted from the observation. */
  classificationEvidence?: string;
  manufacturer?: string;
  model?: string;
  systemDescription?: string;
  source: DiscoverySource;
  confidence?: Confidence;
  simulated?: boolean;
}): Promise<{ id: number; created: boolean }> {
  const db = await getDb();
  const row =
    (input.ip ? await queryOne<DeviceRow>(db, "SELECT * FROM Devices WHERE Mgmt_IP = ? LIMIT 1", input.ip) : undefined) ??
    (input.mac
      ? await queryOne<DeviceRow>(
          db,
          "SELECT * FROM Devices WHERE MAC = ? COLLATE NOCASE LIMIT 1",
          input.mac
        )
      : undefined);

  const now = Date.now();
  if (!row) {
    const provisionalName =
      input.displayName?.trim() ||
      input.hostname?.trim() ||
      suggestedName({
        category: input.category,
        manufacturer: input.manufacturer,
        mac: input.mac,
        ip: input.ip,
      }) ||
      `Unknown device ${now.toString().slice(-4)}`;
    const { lastId } = await run(
      db,
      `INSERT INTO Devices
        (Name, Hostname, Category, Manufacturer, Model, Mgmt_IP, MAC, OS, Discovery_Source,
         Classification_Confidence, Classification_Evidence, Health_State, Health_Reason,
         First_Discovered_At, Last_Observed_At,
         Simulated, Poll_Interval_Seconds, Created_At, Updated_At)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', ?, ?, ?, ?, ?, ?, ?)`,
      provisionalName,
      input.hostname ?? "",
      input.category ?? "unknown",
      input.manufacturer ?? "",
      input.model ?? "",
      input.ip ?? "",
      input.mac ?? "",
      input.systemDescription ?? "",
      input.source,
      input.confidence ?? "unknown",
      input.classificationEvidence ?? "",
      "Discovered by the collector; awaiting classification.",
      now,
      now,
      input.simulated ? 1 : 0,
      await defaultPollSeconds(),
      now,
      now
    );
    return { id: lastId, created: true };
  }

  const device = toDevice(row);
  // A name an administrator typed is final. A name the discovery code invented
  // (a bare MAC or IP) is a placeholder, so a better label may replace it.
  const autoNamed =
    !device.name.trim() ||
    device.name.toUpperCase() === device.mac.toUpperCase() ||
    device.name === device.mgmtIp;
  const nextName =
    row.Name_Locked === 1
      ? device.name
      : input.hostname?.trim() ||
        input.displayName?.trim() ||
        (autoNamed ? input.displayName?.trim() || device.name : device.name);
  const nextCategory =
    row.Category_Locked === 1
      ? device.category
      : // A weak observation must not erase a better verdict. "unknown" means
        // "this pass learned nothing", not "the device changed".
        (input.category ?? device.category) === "unknown" && device.category !== "unknown"
        ? device.category
        : input.category ?? device.category;
  const nextManufacturer = device.manufacturer || input.manufacturer || "";
  const nextModel = device.model || input.model || "";
  const nextDescription = device.os || input.systemDescription || "";
  // The evidence follows the category: when the old verdict is kept, so is the
  // observation that produced it.
  const nextEvidence =
    nextCategory === device.category && input.classificationEvidence
      ? device.classificationEvidence || input.classificationEvidence
      : input.classificationEvidence || device.classificationEvidence;

  await exec(
    db,
    `UPDATE Devices
        SET Name = ?, Hostname = ?, Category = ?, Manufacturer = ?, Model = ?, OS = ?,
            Discovery_Source = ?, Classification_Confidence = ?, Classification_Evidence = ?,
            -- Identity fields are filled when they are empty and never
            -- overwritten: the first observation may be an ICMP reply with no
            -- MAC, and the neighbour table supplies it a second later.
            MAC = CASE WHEN MAC = '' THEN ? ELSE MAC END,
            Last_Observed_At = ?, Updated_At = ?
      WHERE Device_ID = ?`,
    nextName,
    input.hostname ?? device.hostname,
    nextCategory,
    nextManufacturer,
    nextModel,
    nextDescription,
    input.source,
    input.confidence ?? device.classificationConfidence,
    nextEvidence,
    input.mac ?? "",
    now,
    now,
    device.id
  );
  return { id: device.id, created: false };
}

/** Delete a device and its ports (connections are kept for audit but unlinked). */
export async function deleteDevice(id: number): Promise<void> {
  const db = await getDb();
  await exec(db, "UPDATE Connections SET Local_Port_ID = NULL WHERE Local_Port_ID IN (SELECT Port_ID FROM Ports WHERE Device_ID = ?)", id);
  await exec(db, "UPDATE Connections SET Remote_Port_ID = NULL WHERE Remote_Port_ID IN (SELECT Port_ID FROM Ports WHERE Device_ID = ?)", id);
  await exec(db, "DELETE FROM Ports WHERE Device_ID = ?", id);
  await exec(db, "DELETE FROM Device_Addresses WHERE Device_ID = ?", id);
  await exec(db, "DELETE FROM Devices WHERE Device_ID = ?", id);
}

/** Count devices by health state (used by the overview). */
export async function deviceCountsByState(): Promise<Record<string, number>> {
  const rows = await queryAll<{ Health_State: string; c: number }>(
    await getDb(),
    "SELECT Health_State, COUNT(*) AS c FROM Devices GROUP BY Health_State"
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.Health_State] = row.c;
  return out;
}

/** Count devices by category (used by the overview + map legend). */
export async function deviceCountsByCategory(): Promise<Record<string, number>> {
  const rows = await queryAll<{ Category: string; c: number }>(
    await getDb(),
    "SELECT Category, COUNT(*) AS c FROM Devices GROUP BY Category"
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.Category] = row.c;
  return out;
}
