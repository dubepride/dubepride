/**
 * ============================================================================
 *  sqlite.ts — the single place that knows how to reach the database
 * ============================================================================
 *
 *  Two deployment shapes, one code path:
 *
 *    • Local dev / tests / office PC → a plain SQLite *file*
 *      (data/ta-bridge.db, override with TA_DB_PATH).
 *    • Serverless (Vercel / Netlify / Cloudflare) → a remote Turso (libSQL)
 *      database, because function filesystems are ephemeral: a local .db file
 *      would be wiped on every deploy, restart and cold start.
 *
 *  Why @libsql/client for both: it speaks the same SQLite dialect locally and
 *  over HTTP remotely, so the ~3 300 lines of SQL in db.ts stay unchanged.
 *  The remote protocol has one rule the file driver hides for us — every
 *  statement may run on a *different* connection — so db.ts never relies on
 *  connection-local state (e.g. `last_insert_rowid()`) after a separate call.
 *
 *  CONFIG
 *    TURSO_DATABASE_URL  libsql://…turso.io  → remote mode (production)
 *    TURSO_AUTH_TOKEN    the database token
 *    TA_DB_PATH          path to the SQLite file (local mode only)
 *
 *  `getReadyClient()` resolves only once the schema exists and the demo seed
 *  has been applied, so no caller can ever issue a query before bootstrap.
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
  __taBridgeClient?: Client;
  __taBridgeBootstrap?: Promise<void>;
};

/** The bootstrap callback (migrate + seed) — registered by db.ts. */
let bootstrapper: ((client: Client) => Promise<void>) | null = null;

/** db.ts owns the schema; sqlite.ts owns the connection. */
export function setBootstrap(fn: (client: Client) => Promise<void>): void {
  bootstrapper = fn;
}

/** True when a remote (Turso/libSQL) database is configured. */
export function isRemoteDatabase(): boolean {
  return Boolean(remoteUrl());
}

function remoteUrl(): string | null {
  const url = (
    process.env.TURSO_DATABASE_URL ??
    process.env.LIBSQL_DATABASE_URL ??
    ""
  ).trim();
  return url.length > 0 ? url : null;
}

function authToken(): string | undefined {
  const token = (
    process.env.TURSO_AUTH_TOKEN ??
    process.env.LIBSQL_AUTH_TOKEN ??
    ""
  ).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * The libSQL URL in use. Remote when configured, otherwise a `file:` URL
 * pointing at the local SQLite database (created on demand).
 */
export function databaseUrl(): string {
  const remote = remoteUrl();
  if (remote) return remote;

  const file =
    process.env.TA_DB_PATH?.trim() || path.join(process.cwd(), "data", "ta-bridge.db");
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return `file:${file}`;
}

/** A short, secret-free label for logs ("file:…ta-bridge.db" / "libsql://…"). */
export function databaseLabel(): string {
  const url = databaseUrl();
  if (!url.startsWith("file:")) {
    // Never log the token; host-only is enough to identify the database.
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
  if (g.__taBridgeClient) return g.__taBridgeClient;

  const url = databaseUrl();
  // `intMode: "number"` in both modes keeps INTEGER columns as plain JS numbers
  // (the remote default can hand back bigint, which `JSON.stringify` rejects).
  const client = createClient(
    url.startsWith("file:")
      ? { url, intMode: "number" }
      : { url, authToken: authToken(), intMode: "number" }
  );
  g.__taBridgeClient = client;
  return client;
}

/**
 * The bootstrap promise: WAL pragma + schema/seed work, exactly once per
 * process. A failure clears the cache so the next request can retry instead
 * of the process being permanently poisoned.
 */
function bootstrapPromise(client: Client): Promise<void> {
  const g = globalThis as GlobalWithPool;
  if (!g.__taBridgeBootstrap) {
    g.__taBridgeBootstrap = (async () => {
      // WAL is a local-file concern; remote libSQL manages durability itself.
      if (!isRemoteDatabase()) {
        await client.execute("PRAGMA journal_mode = WAL;");
        await client.execute("PRAGMA busy_timeout = 5000;");
      }
      if (bootstrapper) await bootstrapper(client);
    })().catch((err) => {
      g.__taBridgeBootstrap = undefined;
      throw err;
    });
  }
  return g.__taBridgeBootstrap;
}

/** The client, guaranteed migrated + seeded. Use this for every query. */
export async function getReadyClient(): Promise<Client> {
  const client = getClient();
  await bootstrapPromise(client);
  return client;
}

/**
 * Run many statements in ONE round trip. Matters on serverless: a remote
 * round trip is ~20–40 ms, so a 500-row seed loop would otherwise cost
 * ~15 seconds and hundreds of billed writes.
 */
export async function executeBatch(client: Client, statements: SqlStatement[]): Promise<void> {
  if (statements.length === 0) return;
  await client.batch(
    statements as InStatement[],
    "write"
  );
}
