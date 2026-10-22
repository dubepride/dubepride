/**
 * ============================================================================
 *  schema.ts — the Mineazy Network database schema
 * ============================================================================
 *
 *  Conventions (identical to the rest of the estate):
 *    • all timestamps are epoch milliseconds (SQLite INTEGER)
 *    • SQLite has no booleans — flags are stored as 0/1 integers
 *    • column names are PascalCase with underscores
 *
 *  The schema is applied in three steps on every boot:
 *
 *    1. TABLES_SQL creates every table. Every statement is `IF NOT EXISTS`,
 *       so the same code boots a fresh checkout and an existing data file
 *       alike.
 *    2. ADDITIVE_COLUMNS adds the columns that were introduced after a table
 *       was first created. `CREATE TABLE IF NOT EXISTS` never adds a column
 *       to a table that already exists, so without this step an upgraded
 *       database would be missing them. Nothing is ever dropped or
 *       rewritten, so an upgrade never destroys stored inventory.
 *    3. INDEX_SQL creates the indexes. It runs LAST because several indexes
 *       cover columns that step 2 may have just added.
 *
 *  Entity map (see also §15 of the product brief):
 *    Sites/Locations ─┐
 *    Devices ─────────┼─ Ports ──┐
 *         │           │          ├─ Connections (topology edges)
 *         │           └──────────┘
 *         ├─ Health_Observations   (probe results)
 *         ├─ Traffic_Samples       (counter deltas + derived rates)
 *         ├─ Device_Addresses      (extra IPs / MACs)
 *         ├─ Incidents             (deduped, correlated, acknowledged)
 *         └─ Events                (append-only operational log)
 * ============================================================================
 */

import type { Client } from "@libsql/client";

/**
 * The base shape of every table.
 *
 * These are the columns a table had when it was first created. Anything
 * added later lives in `ADDITIVE_COLUMNS` instead, so that an existing
 * database picks it up on boot.
 */
export const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS Users (
  User_ID       INTEGER PRIMARY KEY AUTOINCREMENT,
  Username      TEXT    NOT NULL UNIQUE,
  Email         TEXT    NOT NULL UNIQUE,
  Display_Name  TEXT    NOT NULL,
  Password_Hash TEXT    NOT NULL,
  Role          TEXT    NOT NULL DEFAULT 'viewer',
  Active        INTEGER NOT NULL DEFAULT 1,
  Created_At    INTEGER NOT NULL,
  Last_Login_At INTEGER
);

CREATE TABLE IF NOT EXISTS Sites (
  Site_ID     INTEGER PRIMARY KEY AUTOINCREMENT,
  Name        TEXT    NOT NULL UNIQUE,
  Description TEXT    NOT NULL DEFAULT '',
  Created_At  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Locations (
  Location_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Site_ID     INTEGER,
  Name        TEXT    NOT NULL,
  Building    TEXT    NOT NULL DEFAULT '',
  Room        TEXT    NOT NULL DEFAULT '',
  Notes       TEXT    NOT NULL DEFAULT '',
  Created_At  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Devices (
  Device_ID     INTEGER PRIMARY KEY AUTOINCREMENT,
  Name          TEXT    NOT NULL,
  Hostname      TEXT    NOT NULL DEFAULT '',
  Category      TEXT    NOT NULL DEFAULT 'unknown',
  Manufacturer  TEXT    NOT NULL DEFAULT '',
  Model         TEXT    NOT NULL DEFAULT '',
  Serial        TEXT    NOT NULL DEFAULT '',
  Site_ID       INTEGER,
  Location_ID   INTEGER,
  Mgmt_IP       TEXT    NOT NULL DEFAULT '',
  MAC           TEXT    NOT NULL DEFAULT '',
  OS            TEXT    NOT NULL DEFAULT '',
  Notes         TEXT    NOT NULL DEFAULT '',
  Created_At    INTEGER NOT NULL,
  Updated_At    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Ports (
  Port_ID           INTEGER PRIMARY KEY AUTOINCREMENT,
  Device_ID         INTEGER NOT NULL,
  If_Index          INTEGER,
  If_Name           TEXT    NOT NULL,
  Port_Number       INTEGER,
  Description       TEXT    NOT NULL DEFAULT '',
  Admin_State       TEXT    NOT NULL DEFAULT 'unknown',
  Oper_State        TEXT    NOT NULL DEFAULT 'unknown',
  Speed_Bps         INTEGER,
  Duplex            TEXT,
  VLAN              INTEGER,
  Last_State_Change INTEGER,
  In_Octets         INTEGER,
  Out_Octets        INTEGER,
  In_Packets        INTEGER,
  Out_Packets       INTEGER,
  In_Errors         INTEGER,
  Out_Errors        INTEGER,
  In_Discards       INTEGER,
  Out_Discards      INTEGER
);

CREATE TABLE IF NOT EXISTS Connections (
  Connection_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
  Local_Device_ID INTEGER NOT NULL,
  Local_Port_ID   INTEGER,
  Remote_Device_ID INTEGER NOT NULL,
  Remote_Port_ID  INTEGER,
  Type            TEXT    NOT NULL DEFAULT 'unknown',
  Created_At      INTEGER NOT NULL,
  Updated_At      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Device_Addresses (
  Address_ID  INTEGER PRIMARY KEY AUTOINCREMENT,
  Device_ID   INTEGER NOT NULL,
  Kind        TEXT    NOT NULL,
  Address     TEXT    NOT NULL,
  Source      TEXT    NOT NULL DEFAULT '',
  Observed_At INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Health_Observations (
  Observation_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Device_ID      INTEGER NOT NULL,
  Port_ID        INTEGER,
  Observed_At    INTEGER NOT NULL,
  Probe_Type     TEXT    NOT NULL,
  Probe_Target   TEXT    NOT NULL DEFAULT '',
  Result         TEXT    NOT NULL,
  Latency_Ms     REAL,
  Reason         TEXT    NOT NULL DEFAULT '',
  Source         TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Traffic_Samples (
  Sample_ID      INTEGER PRIMARY KEY AUTOINCREMENT,
  Subject_Type   TEXT    NOT NULL,
  Subject_ID     INTEGER NOT NULL,
  Sampled_At     INTEGER NOT NULL,
  In_Bytes       INTEGER,
  Out_Bytes      INTEGER,
  In_Rate_Bps    REAL,
  Out_Rate_Bps   REAL,
  In_Pps         REAL,
  Out_Pps        REAL,
  In_Errors      INTEGER,
  Out_Errors     INTEGER,
  Counter_Valid  INTEGER NOT NULL DEFAULT 1,
  Window_Seconds REAL,
  Source         TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Incidents (
  Incident_ID  INTEGER PRIMARY KEY AUTOINCREMENT,
  Dedupe_Key   TEXT    NOT NULL,
  Category     TEXT    NOT NULL,
  Severity     TEXT    NOT NULL DEFAULT 'minor',
  Title        TEXT    NOT NULL,
  Device_ID    INTEGER,
  Connection_ID INTEGER,
  Started_At   INTEGER NOT NULL,
  Updated_At   INTEGER NOT NULL,
  Recovered_At INTEGER,
  State        TEXT    NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS Events (
  Event_ID     INTEGER PRIMARY KEY AUTOINCREMENT,
  At           INTEGER NOT NULL,
  Type         TEXT    NOT NULL,
  Severity     TEXT    NOT NULL DEFAULT 'info',
  Title        TEXT    NOT NULL,
  Detail       TEXT    NOT NULL DEFAULT '',
  Subject_Type TEXT    NOT NULL DEFAULT 'system',
  Subject_ID   INTEGER,
  Source       TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Audit_Log (
  Audit_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
  At         INTEGER NOT NULL,
  User_ID    INTEGER,
  User_Name  TEXT    NOT NULL DEFAULT '',
  Action     TEXT    NOT NULL,
  Entity     TEXT    NOT NULL DEFAULT '',
  Entity_ID  TEXT    NOT NULL DEFAULT '',
  Before     TEXT    NOT NULL DEFAULT '',
  After      TEXT    NOT NULL DEFAULT '',
  Note       TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Settings (
  Key        TEXT PRIMARY KEY,
  Value      TEXT NOT NULL,
  Updated_At INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Scan_Targets (
  Target_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
  CIDR        TEXT    NOT NULL UNIQUE,
  Description TEXT    NOT NULL DEFAULT '',
  Enabled     INTEGER NOT NULL DEFAULT 1,
  Created_At  INTEGER NOT NULL,
  Last_Scan_At INTEGER
);

CREATE TABLE IF NOT EXISTS SNMP_Credentials (
  Credential_ID INTEGER PRIMARY KEY AUTOINCREMENT,
  Name          TEXT    NOT NULL UNIQUE,
  Version       TEXT    NOT NULL DEFAULT '2c',
  Community     TEXT    NOT NULL DEFAULT '',
  Username      TEXT    NOT NULL DEFAULT '',
  Auth_Protocol TEXT    NOT NULL DEFAULT '',
  Auth_Key      TEXT    NOT NULL DEFAULT '',
  Priv_Protocol TEXT    NOT NULL DEFAULT '',
  Priv_Key      TEXT    NOT NULL DEFAULT '',
  Created_At    INTEGER NOT NULL,
  Updated_At    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS Discovery_Jobs (
  Job_ID      INTEGER PRIMARY KEY AUTOINCREMENT,
  Kind        TEXT    NOT NULL DEFAULT 'scan',
  Started_At  INTEGER NOT NULL,
  Finished_At INTEGER,
  Status      TEXT    NOT NULL DEFAULT 'running',
  Scope       TEXT    NOT NULL DEFAULT '',
  Summary     TEXT    NOT NULL DEFAULT '',
  Error       TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS Notification_Prefs (
  User_ID        INTEGER PRIMARY KEY,
  Min_Severity   TEXT    NOT NULL DEFAULT 'minor',
  Categories     TEXT    NOT NULL DEFAULT '[]',
  Locations      TEXT    NOT NULL DEFAULT '[]',
  Browser_Alerts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS Collector_State (
  Name        TEXT PRIMARY KEY,
  Heartbeat   INTEGER NOT NULL,
  Started_At  INTEGER NOT NULL,
  Detail      TEXT    NOT NULL DEFAULT ''
);
`;

/**
 * Columns that were added after their table was first created.
 *
 * `CREATE TABLE IF NOT EXISTS` skips a table that already exists, so these
 * columns would be missing forever on a database created by an older build.
 * Each entry is applied only when the column is absent, which makes the
 * whole list idempotent.
 *
 * `ddl` is the column definition used in the `ALTER TABLE` statement, so it
 * includes the column name and its type/default.
 */
export const ADDITIVE_COLUMNS: { table: string; column: string; ddl: string }[] = [
  // ── Devices: monitoring controls, health and discovery provenance ──
  { table: "Devices", column: "Criticality", ddl: "Criticality TEXT NOT NULL DEFAULT 'standard'" },
  { table: "Devices", column: "Monitoring_Enabled", ddl: "Monitoring_Enabled INTEGER NOT NULL DEFAULT 1" },
  { table: "Devices", column: "Monitor_Method", ddl: "Monitor_Method TEXT NOT NULL DEFAULT 'icmp'" },
  { table: "Devices", column: "Poll_Interval_Seconds", ddl: "Poll_Interval_Seconds INTEGER NOT NULL DEFAULT 60" },
  { table: "Devices", column: "Failure_Threshold", ddl: "Failure_Threshold INTEGER NOT NULL DEFAULT 3" },
  { table: "Devices", column: "Discovery_Source", ddl: "Discovery_Source TEXT NOT NULL DEFAULT 'unknown'" },
  { table: "Devices", column: "Classification_Confidence", ddl: "Classification_Confidence TEXT NOT NULL DEFAULT 'unknown'" },
  { table: "Devices", column: "Health_State", ddl: "Health_State TEXT NOT NULL DEFAULT 'UNKNOWN'" },
  { table: "Devices", column: "Health_Reason", ddl: "Health_Reason TEXT NOT NULL DEFAULT ''" },
  { table: "Devices", column: "First_Discovered_At", ddl: "First_Discovered_At INTEGER" },
  { table: "Devices", column: "Last_Seen_At", ddl: "Last_Seen_At INTEGER" },
  { table: "Devices", column: "Last_Observed_At", ddl: "Last_Observed_At INTEGER" },
  { table: "Devices", column: "Simulated", ddl: "Simulated INTEGER NOT NULL DEFAULT 0" },
  { table: "Devices", column: "Layout_X", ddl: "Layout_X REAL" },
  { table: "Devices", column: "Layout_Y", ddl: "Layout_Y REAL" },
  { table: "Devices", column: "Name_Locked", ddl: "Name_Locked INTEGER NOT NULL DEFAULT 0" },
  { table: "Devices", column: "Category_Locked", ddl: "Category_Locked INTEGER NOT NULL DEFAULT 0" },

  // ── Ports: the derived rates and the admin metadata ──
  { table: "Ports", column: "In_Rate_Bps", ddl: "In_Rate_Bps REAL" },
  { table: "Ports", column: "Out_Rate_Bps", ddl: "Out_Rate_Bps REAL" },
  { table: "Ports", column: "Last_Polled_At", ddl: "Last_Polled_At INTEGER" },
  { table: "Ports", column: "Source", ddl: "Source TEXT NOT NULL DEFAULT ''" },
  { table: "Ports", column: "Label", ddl: "Label TEXT NOT NULL DEFAULT ''" },
  { table: "Ports", column: "Notes", ddl: "Notes TEXT NOT NULL DEFAULT ''" },
  { table: "Ports", column: "Managed", ddl: "Managed INTEGER NOT NULL DEFAULT 0" },

  // ── Connections: provenance, cabling and the observed link state ──
  { table: "Connections", column: "Source", ddl: "Source TEXT NOT NULL DEFAULT 'unknown'" },
  { table: "Connections", column: "Confidence", ddl: "Confidence REAL NOT NULL DEFAULT 0" },
  { table: "Connections", column: "Verified", ddl: "Verified INTEGER NOT NULL DEFAULT 0" },
  { table: "Connections", column: "Cable_ID", ddl: "Cable_ID TEXT NOT NULL DEFAULT ''" },
  { table: "Connections", column: "Cable_Destination", ddl: "Cable_Destination TEXT NOT NULL DEFAULT ''" },
  { table: "Connections", column: "Notes", ddl: "Notes TEXT NOT NULL DEFAULT ''" },
  { table: "Connections", column: "State", ddl: "State TEXT NOT NULL DEFAULT 'unknown'" },
  { table: "Connections", column: "Evidence", ddl: "Evidence TEXT NOT NULL DEFAULT ''" },
  { table: "Connections", column: "Last_Observed_At", ddl: "Last_Observed_At INTEGER" },

  // ── Incidents: correlation, acknowledgement and the operator's notes ──
  { table: "Incidents", column: "Evidence", ddl: "Evidence TEXT NOT NULL DEFAULT ''" },
  { table: "Incidents", column: "Affected", ddl: "Affected TEXT NOT NULL DEFAULT '[]'" },
  { table: "Incidents", column: "Fault_Location", ddl: "Fault_Location TEXT NOT NULL DEFAULT ''" },
  { table: "Incidents", column: "Confidence", ddl: "Confidence REAL NOT NULL DEFAULT 0" },
  { table: "Incidents", column: "Acknowledged", ddl: "Acknowledged INTEGER NOT NULL DEFAULT 0" },
  { table: "Incidents", column: "Acknowledged_By", ddl: "Acknowledged_By TEXT" },
  { table: "Incidents", column: "Assigned_To", ddl: "Assigned_To TEXT" },
  { table: "Incidents", column: "Notes", ddl: "Notes TEXT NOT NULL DEFAULT ''" },
];

/**
 * The indexes.
 *
 * They are created after the additive columns, because several of them cover
 * a column that a migration may have just added.
 */
export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_devices_cat    ON Devices (Category);
CREATE INDEX IF NOT EXISTS idx_devices_state  ON Devices (Health_State);
CREATE INDEX IF NOT EXISTS idx_devices_loc    ON Devices (Location_ID);
CREATE INDEX IF NOT EXISTS idx_ports_device ON Ports (Device_ID);
CREATE INDEX IF NOT EXISTS idx_ports_ifname ON Ports (Device_ID, If_Name);
CREATE INDEX IF NOT EXISTS idx_conn_local  ON Connections (Local_Device_ID);
CREATE INDEX IF NOT EXISTS idx_conn_remote ON Connections (Remote_Device_ID);
CREATE UNIQUE INDEX IF NOT EXISTS idx_addr_unique ON Device_Addresses (Device_ID, Kind, Address);
CREATE INDEX IF NOT EXISTS idx_addr_lookup ON Device_Addresses (Address);
CREATE INDEX IF NOT EXISTS idx_obs_device ON Health_Observations (Device_ID, Observed_At DESC);
CREATE INDEX IF NOT EXISTS idx_obs_time   ON Health_Observations (Observed_At DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_subject ON Traffic_Samples (Subject_Type, Subject_ID, Sampled_At DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_time    ON Traffic_Samples (Sampled_At DESC);
CREATE INDEX IF NOT EXISTS idx_inc_key   ON Incidents (Dedupe_Key, State);
CREATE INDEX IF NOT EXISTS idx_inc_state ON Incidents (State, Severity);
CREATE INDEX IF NOT EXISTS idx_inc_time  ON Incidents (Started_At DESC);
CREATE INDEX IF NOT EXISTS idx_events_time ON Events (At DESC);
CREATE INDEX IF NOT EXISTS idx_events_subj ON Events (Subject_Type, Subject_ID, At DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time ON Audit_Log (At DESC);
`;

/** The columns a table currently has. */
async function tableColumns(client: Client, table: string): Promise<Set<string>> {
  const result = await client.execute({
    sql: "SELECT name FROM pragma_table_info(?)",
    args: [table],
  });
  return new Set(result.rows.map((row) => String((row as unknown as { name: unknown }).name)));
}

/**
 * Add the columns that are missing from a table.
 *
 * Returns the number of columns that were added, which is zero for a
 * database that is already up to date.
 */
export async function applyAdditiveColumns(client: Client): Promise<number> {
  const byTable = new Map<string, { table: string; column: string; ddl: string }[]>();
  for (const entry of ADDITIVE_COLUMNS) {
    const list = byTable.get(entry.table) ?? [];
    list.push(entry);
    byTable.set(entry.table, list);
  }

  let added = 0;
  for (const [table, entries] of byTable) {
    const present = await tableColumns(client, table);
    for (const entry of entries) {
      if (present.has(entry.column)) continue;
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${entry.ddl}`);
      added += 1;
    }
  }
  return added;
}

/**
 * Bring a database up to the current schema.
 *
 * Idempotent: running it against a fresh file, an up-to-date file or an
 * old file always ends with the same schema, and never touches stored
 * inventory.
 */
export async function migrate(client: Client): Promise<void> {
  await client.executeMultiple(TABLES_SQL);
  await applyAdditiveColumns(client);
  await client.executeMultiple(INDEX_SQL);
}
