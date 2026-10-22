/**
 * ============================================================================
 *  collector/lock.ts — the single-writer lock
 * ============================================================================
 *
 *  Exactly one collector may write observations at a time. Two collectors
 *  running side by side would double-count traffic, duplicate incidents and
 *  fight over the same rows.
 *
 *  The lock is a small file next to the database holding the owner's pid.
 *  If the pid is gone the lock is stale and can be taken over — a crashed
 *  collector must not permanently block the service.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";

/** The lock file path (next to the database). */
export function lockFilePath(): string {
  const dbPath = process.env.MINEAZY_DB_PATH?.trim() || path.join(process.cwd(), "data", "mineazy.db");
  return path.join(path.dirname(dbPath), "collector.lock");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The state of the lock file. */
export interface LockState {
  held: boolean;
  pid: number | null;
  startedAt: number | null;
}

/** Read the current lock state without taking it. */
export function readLock(): LockState {
  const file = lockFilePath();
  try {
    if (!fs.existsSync(file)) return { held: false, pid: null, startedAt: null };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; startedAt?: number };
    const pid = typeof raw.pid === "number" ? raw.pid : null;
    const alive = pid !== null && isProcessAlive(pid);
    return { held: alive, pid, startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null };
  } catch {
    return { held: false, pid: null, startedAt: null };
  }
}

/**
 * Try to take the lock.
 *
 * Returns null on success, or a message explaining why the lock is held.
 */
export function acquireLock(): string | null {
  const file = lockFilePath();
  const existing = readLock();

  if (existing.held && existing.pid !== process.pid) {
    return `Another collector (pid ${existing.pid}) is already running.`;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `The collector lock file could not be written (${message}).`;
  }
  return null;
}

/** Release the lock (only if this process owns it). */
export function releaseLock(): void {
  const state = readLock();
  if (state.pid !== process.pid) return;
  try {
    fs.unlinkSync(lockFilePath());
  } catch {
    // Nothing to release.
  }
}
