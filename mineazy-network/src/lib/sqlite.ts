/**
 * ============================================================================
 *  sqlite.ts — the single place that knows how to reach the database
 * ============================================================================
 *
 *  Mineazy Network is local-first: the console, the collector and every
 *  observation live on the machine inside the customer's network, so the
 *  default store is a plain SQLite *file* on that machine's disk.
 *
 *    • Local install  → data/mineazy.db          (override: MINEAZY_DB_PATH)
 *    • Shared install → libsql://… (Turso)       (optional, same SQL dialect)
 *
 *  @libsql/client speaks the same dialect in both modes, so every query in
 *  src/lib/repo/* is identical for a file-backed and a remote database.
 *
 *  The remote protocol has one rule the file driver hides: a statement may
 *  run on a different connection, so we never rely on connection-local state
 *  (e.g. `last_insert_rowid()`) after a separate call.
 */

import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";

/** Values accepted as bound parameters. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** A prepared statement shape (sql + bound args). */
export interface SqlStatement {
  sql: string;
  args?: SqlValue[];
}

type GlobalWithPool = typeof globalThis & {
  __mineazyClient?: Client;
  __mineazyBootstrap?: Promise<void>;
};

/** The bootstrap callback (migrate + seed) — registered by db.ts. */
let bootstrapper: ((client: Client) => Promise<void>) | null = null;

/** db.ts owns the schema; sqlite.ts owns the connection. */
export function setBootstrap(fn: (client: Client) => Promise<void>): void {
  bootstrapper = fn;
}

/** True when a remote (Turso/libSQL) database is configured. */
export function isRemoteDatabase(): boolean {
  return remoteUrl() !== null;
}

function remoteUrl(): string | null {
  const url = (process.env.MINEAZY_DATABASE_URL ?? process.env.LIBSQL_DATABASE_URL ?? "").trim();
  return url.length > 0 ? url : null;
}

function authToken(): string | undefined {
  const token = (process.env.MINEAZY_DATABASE_TOKEN ?? process.env.LIBSQL_AUTH_TOKEN ?? "").trim();
  return token.length > 0 ? token : undefined;
}

/**
 * The database URL in use. Remote when configured, otherwise a `file:` URL
 * pointing at the local SQLite database (created on demand).
 */
export function databaseUrl(): string {
  const remote = remoteUrl();
  if (remote) return remote;

  const file = process.env.MINEAZY_DB_PATH?.trim() || path.join(process.cwd(), "data", "mineazy.db");
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return `file:${file}`;
}

/** A short, secret-free label for logs ("file:…mineazy.db" / "remote:host"). */
export function databaseLabel(): string {
  const url = databaseUrl();
  if (!url.startsWith("file:")) {
    try {
      return `remote:${new URL(url.replace(/^libsql:/, "https:")).host}`;
    } catch {
      return "remote:libsql";
    }
  }
  return `file:${path.basename(url.slice("file:".length))}`;
}

/** The process-wide client (cached across dev-HMR module graphs). */
export function getClient(): Client {
  const g = globalThis as GlobalWithPool;
  if (g.__mineazyClient) return g.__mineazyClient;

  const url = databaseUrl();
  // `intMode: "number"` keeps INTEGER columns as plain JS numbers (the remote
  // default can hand back bigint, which `JSON.stringify` rejects).
  const client = createClient(
    url.startsWith("file:")
      ? { url, intMode: "number" }
      : { url, authToken: authToken(), intMode: "number" }
  );
  g.__mineazyClient = client;
  return client;
}

/**
 * The bootstrap promise: WAL pragma + schema/seed work, exactly once per
 * process. A failure clears the cache so the next request can retry instead
 * of the process being permanently poisoned.
 */
function bootstrapPromise(client: Client): Promise<void> {
  const g = globalThis as GlobalWithPool;
  if (!g.__mineazyBootstrap) {
    g.__mineazyBootstrap = (async () => {
      if (!isRemoteDatabase()) {
        await client.execute("PRAGMA journal_mode = WAL;");
        await client.execute("PRAGMA busy_timeout = 5000;");
      }
      if (bootstrapper) await bootstrapper(client);
    })().catch((err) => {
      g.__mineazyBootstrap = undefined;
      throw err;
    });
  }
  return g.__mineazyBootstrap;
}

/** The client, guaranteed migrated + seeded. Use this for every query. */
export async function getReadyClient(): Promise<Client> {
  const client = getClient();
  await bootstrapPromise(client);
  return client;
}

/** Run many statements in ONE round trip. */
export async function executeBatch(client: Client, statements: SqlStatement[]): Promise<void> {
  if (statements.length === 0) return;
  await client.batch(statements as InStatement[], "write");
}
