/**
 * ============================================================================
 *  tests/helpers.ts — shared test scaffolding
 * ============================================================================
 *
 *  Each test file runs in its own process (the Node test runner spawns one
 *  child per file), so a test file can point the whole application at a
 *  throw-away SQLite file by setting the environment BEFORE any module that
 *  touches the database is imported.
 *
 *  Nothing here touches the developer's real database.
 * ============================================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Point the application at a fresh temporary database.
 *
 * Call this at the very top of a test file, before the first dynamic
 * `import()` of anything under `src/`.
 *
 * The name deliberately does not start with "use": it is not a React hook,
 * and the React hooks lint rule would (rightly) object if it looked like
 * one.
 */
export function tempDatabase(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mineazy-${label}-`));
  const dbPath = path.join(dir, "mineazy.db");
  process.env.MINEAZY_DB_PATH = dbPath;
  process.env.MINEAZY_SECRET_KEY = `test-secret-${label}`;
  process.env.MINEAZY_SECRET_KEY_FILE = path.join(dir, "secret.key");
  process.env.MINEAZY_SESSION_SECRET = `test-session-${label}`;
  process.env.MINEAZY_ADMIN_PASSWORD = "test-administrator-password";
  // Demo mode off: the tests exercise the production code paths.
  process.env.MINEAZY_DEMO = "0";
  return dbPath;
}

/** Remove a temporary database directory created by `tempDatabase`. */
export function removeTempDatabase(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort — the OS will clean the temp directory anyway.
  }
}
