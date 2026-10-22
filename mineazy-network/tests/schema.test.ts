/**
 * ============================================================================
 *  tests/schema.test.ts — the schema and its upgrade path
 * ============================================================================
 *
 *  A local-first install is upgraded in place: the operator replaces the
 *  code and restarts the service. The database therefore has to survive
 *  that upgrade — with every column the new code expects, and with the
 *  stored inventory untouched.
 *
 *  These tests check both halves of that promise.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { createClient } from "@libsql/client";

import { ADDITIVE_COLUMNS, applyAdditiveColumns, migrate } from "../src/lib/schema";
import { removeTempDatabase } from "./helpers";

/** A fresh, throw-away database file. */
function newDatabasePath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mineazy-schema-${label}-`));
  return path.join(dir, "mineazy.db");
}

/** The columns a table actually has. */
async function columnsOf(client: ReturnType<typeof createClient>, table: string): Promise<string[]> {
  const result = await client.execute({
    sql: "SELECT name FROM pragma_table_info(?)",
    args: [table],
  });
  return result.rows.map((row) => String((row as unknown as { name: unknown }).name));
}

describe("schema", () => {
  test("a fresh database has every table the application needs", async () => {
    const dbPath = newDatabasePath("fresh");
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await migrate(client);
      for (const table of [
        "Users",
        "Sites",
        "Locations",
        "Devices",
        "Ports",
        "Connections",
        "Device_Addresses",
        "Health_Observations",
        "Traffic_Samples",
        "Incidents",
        "Events",
        "Audit_Log",
        "Settings",
        "Scan_Targets",
        "SNMP_Credentials",
        "Discovery_Jobs",
        "Notification_Prefs",
        "Collector_State",
      ]) {
        const found = await client.execute(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          [table]
        );
        assert.equal(found.rows.length, 1, `the table ${table} must exist`);
      }
    } finally {
      client.close();
      removeTempDatabase(dbPath);
    }
  });

  test("a fresh database has every additive column", async () => {
    const dbPath = newDatabasePath("columns");
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await migrate(client);
      for (const entry of ADDITIVE_COLUMNS) {
        const columns = await columnsOf(client, entry.table);
        assert.ok(
          columns.includes(entry.column),
          `${entry.table}.${entry.column} must exist after a fresh install`
        );
      }
    } finally {
      client.close();
      removeTempDatabase(dbPath);
    }
  });

  test("migrating an up-to-date database changes nothing", async () => {
    const dbPath = newDatabasePath("idempotent");
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await migrate(client);
      const added = await applyAdditiveColumns(client);
      assert.equal(added, 0, "a second run must not add anything");
    } finally {
      client.close();
      removeTempDatabase(dbPath);
    }
  });

  test("an old database gains the new columns and keeps its inventory", async () => {
    const dbPath = newDatabasePath("upgrade");
    const client = createClient({ url: `file:${dbPath}` });
    try {
      // A database as an older build left it: the table exists in its
      // original shape and holds a real row.
      await client.executeMultiple(`
        CREATE TABLE Devices (
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
        INSERT INTO Devices (Name, Mgmt_IP, Notes, Created_At, Updated_At)
        VALUES ('Old Switch', '10.0.0.1', 'installed before the upgrade', 1000, 1000);
      `);

      // The upgrade.
      await migrate(client);

      const columns = await columnsOf(client, "Devices");
      for (const entry of ADDITIVE_COLUMNS.filter((c) => c.table === "Devices")) {
        assert.ok(
          columns.includes(entry.column),
          `${entry.table}.${entry.column} must be added by the upgrade`
        );
      }

      // The row survived, with its data, and picked up the defaults.
      const rows = await client.execute("SELECT * FROM Devices");
      assert.equal(rows.rows.length, 1, "the upgrade must not destroy stored inventory");
      const row = rows.rows[0] as unknown as Record<string, unknown>;
      assert.equal(row.Name, "Old Switch");
      assert.equal(row.Mgmt_IP, "10.0.0.1");
      assert.equal(row.Notes, "installed before the upgrade");
      assert.equal(row.Health_State, "UNKNOWN");
      assert.equal(row.Monitoring_Enabled, 1);
      assert.equal(row.Poll_Interval_Seconds, 60);
      assert.equal(row.Simulated, 0);
    } finally {
      client.close();
      removeTempDatabase(dbPath);
    }
  });

  test("the indexes exist after the upgrade", async () => {
    const dbPath = newDatabasePath("indexes");
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await migrate(client);
      const rows = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'"
      );
      const names = rows.rows.map((row) => String((row as unknown as { name: unknown }).name));
      for (const expected of [
        "idx_devices_state",
        "idx_ports_device",
        "idx_traffic_subject",
        "idx_inc_key",
        "idx_events_time",
      ]) {
        assert.ok(names.includes(expected), `the index ${expected} must exist`);
      }
    } finally {
      client.close();
      removeTempDatabase(dbPath);
    }
  });
});
