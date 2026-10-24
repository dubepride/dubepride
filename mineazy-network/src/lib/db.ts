/**
 * ============================================================================
 *  db.ts — schema bootstrap, seed data and low-level SQL helpers
 * ============================================================================
 */

import type { Client } from "@libsql/client";
import { executeBatch, getReadyClient, isRemoteDatabase, setBootstrap, type SqlStatement, type SqlValue } from "./sqlite";
import { migrate } from "./schema";
import { hashPassword, randomPassword } from "./passwords";

/* ------------------------------------------------------------------ */
/* Low-level helpers                                                   */
/* ------------------------------------------------------------------ */

export async function exec(db: Client, sql: string, ...params: SqlValue[]): Promise<void> {
  await db.execute({ sql, args: params });
}

export async function execMulti(db: Client, sql: string): Promise<void> {
  await db.executeMultiple(sql);
}

export async function run(
  db: Client,
  sql: string,
  ...params: SqlValue[]
): Promise<{ changes: number; lastId: number }> {
  const res = await db.execute({ sql, args: params });
  return { changes: Number(res.rowsAffected), lastId: Number(res.lastInsertRowid ?? 0) };
}

export async function queryAll<T>(db: Client, sql: string, ...params: SqlValue[]): Promise<T[]> {
  const res = await db.execute({ sql, args: params });
  return res.rows as unknown as T[];
}

export async function queryOne<T>(db: Client, sql: string, ...params: SqlValue[]): Promise<T | undefined> {
  const res = await db.execute({ sql, args: params });
  return res.rows[0] as unknown as T | undefined;
}

export async function batch(db: Client, statements: SqlStatement[]): Promise<void> {
  await executeBatch(db, statements);
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS: Record<string, string> = {
  "site.name": "Automap",
  "site.description": "",
  "monitor.staleAfterSeconds": "300",
  "monitor.defaultPollSeconds": "60",
  "monitor.failureThreshold": "3",
  "monitor.noTrafficAfterSeconds": "600",
  "monitor.internetTargets": JSON.stringify([
    { name: "Cloudflare DNS", host: "1.1.1.1", type: "icmp" },
    { name: "Quad9 DNS", host: "9.9.9.9", type: "icmp" },
    { name: "Internet HTTPS", host: "https://connectivitycheck.gstatic.com/generate_204", type: "http" },
  ]),
  "monitor.gatewayTargets": JSON.stringify([{ name: "Default gateway", host: "", type: "icmp" }]),
  "monitor.snmpTimeoutMs": "2000",
  "monitor.snmpRetries": "1",
  "discovery.enabled": "true",
  "discovery.scheduleMinutes": "60",
  "discovery.rateLimitPerSecond": "50",
  "collector.mode": "real",
  "retention.trafficDays": "14",
  "retention.observationDays": "7",
  "retention.eventDays": "90",
  "alerts.minSeverity": "minor",
  "alerts.browserNotifications": "false",
  "ui.animations": "true",
  "ui.defaultMapView": "full",
};

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

export function isDemoMode(): boolean {
  const flag = (process.env.MINEAZY_DEMO ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

async function seedSettings(db: Client): Promise<void> {
  const existing = await queryAll<{ Key: string }>(db, "SELECT Key FROM Settings");
  const known = new Set(existing.map((r) => r.Key));
  const statements: SqlStatement[] = [];
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (known.has(key)) continue;
    statements.push({
      sql: "INSERT OR REPLACE INTO Settings (Key, Value, Updated_At) VALUES (?, ?, ?)",
      args: [key, value, Date.now()],
    });
  }
  await batch(db, statements);
}

async function seedUsers(db: Client): Promise<void> {
  const count =
    (await queryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Users WHERE Role = 'administrator'"))
      ?.c ?? 0;
  if (count > 0) return;

  const envPassword = (process.env.MINEAZY_ADMIN_PASSWORD ?? "").trim();
  const password = envPassword.length > 0 ? envPassword : randomPassword();
  const now = Date.now();

  await exec(
    db,
    `INSERT INTO Users (Username, Email, Display_Name, Password_Hash, Role, Active, Created_At)
     VALUES (?, ?, ?, ?, 'administrator', 1, ?)`,
    "admin",
    "admin@mineazy.local",
    "Network Administrator",
    hashPassword(password),
    now
  );

  if (!envPassword) {
    console.warn(
      [
        "",
        "=".repeat(72),
        "[setup] MINEAZY_ADMIN_PASSWORD is not set.",
        "[setup] The administrator account was created with a ONE-TIME RANDOM password:",
        "[setup]     username: admin",
        `[setup]     password: ${password}`,
        "[setup] Sign in and change it, or set MINEAZY_ADMIN_PASSWORD before the",
        "[setup] first run to choose your own.",
        "=".repeat(72),
        "",
      ].join("\n")
    );
  }

  if (isDemoMode()) {
    await exec(
      db,
      `INSERT OR IGNORE INTO Users (Username, Email, Display_Name, Password_Hash, Role, Active, Created_At)
       VALUES (?, ?, ?, ?, 'operator', 1, ?)`,
      "operator",
      "operator@mineazy.local",
      "Network Operator",
      hashPassword("mineazy-demo-operator"),
      now
    );
    await exec(
      db,
      `INSERT OR IGNORE INTO Users (Username, Email, Display_Name, Password_Hash, Role, Active, Created_At)
       VALUES (?, ?, ?, ?, 'viewer', 1, ?)`,
      "viewer",
      "viewer@mineazy.local",
      "Read-only Viewer",
      hashPassword("mineazy-demo-viewer"),
      now
    );
  }
}

async function bootstrap(client: Client): Promise<void> {
  await migrate(client);
  await seedSettings(client);
  await seedUsers(client);
}

setBootstrap(bootstrap);

export function getDb(): Promise<Client> {
  return getReadyClient();
}

/**
 * Flush the write-ahead log into the main database file.
 *
 * The database runs in WAL mode, so the data on disk is split between
 * `mineazy.db` and `mineazy.db-wal`. Copying only the first of those while
 * the collector is writing can produce a torn file. After a checkpoint the
 * `.db` file on its own is a complete, consistent snapshot — which is what
 * makes "copy the database file" a safe backup.
 *
 * A remote libSQL database has no local write-ahead log to flush, so the
 * call is a no-op there.
 */
export async function checkpoint(): Promise<{ ok: boolean; detail: string }> {
  const client = await getDb();
  if (isRemoteDatabase()) {
    return {
      ok: true,
      detail: "The remote database has no local write-ahead log to flush.",
    };
  }
  try {
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE);");
    return {
      ok: true,
      detail: "The write-ahead log was flushed into the database file.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `The checkpoint failed: ${message}` };
  }
}

export { exec as execSql, run as runSql, batch as batchSql };
export type { SqlStatement, SqlValue };
