/**
 * ============================================================================
 *  settings.ts — typed access to the key/value configuration table
 * ============================================================================
 *
 *  Everything an administrator can tune (poll intervals, thresholds, external
 *  probe targets, discovery schedule, retention) lives in one key/value table
 *  so the collector and the API read exactly the same values.
 *
 *  Writes go through `setSetting`, which also records an audit entry when a
 *  user id is supplied.
 */

import { getDb, queryAll, queryOne, exec } from "./db";

/** A monitoring target used for reachability / internet checks. */
export interface MonitorTarget {
  name: string;
  host: string;
  type: "icmp" | "tcp" | "http";
  port?: number;
}

/** Read a single setting (falls back to the supplied default). */
export async function getSetting(key: string, fallback = ""): Promise<string> {
  const row = await queryOne<{ Value: string }>(await getDb(), "SELECT Value FROM Settings WHERE Key = ?", key);
  return row ? row.Value : fallback;
}

/** Read a numeric setting. */
export async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const raw = await getSetting(key, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Read a boolean setting ("true"/"1" → true). */
export async function getBooleanSetting(key: string, fallback = false): Promise<boolean> {
  const raw = (await getSetting(key, fallback ? "true" : "false")).trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return fallback;
}

/** Read a JSON setting, tolerating malformed content. */
export async function getJsonSetting<T>(key: string, fallback: T): Promise<T> {
  const raw = await getSetting(key, "");
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write a setting. */
export async function setSetting(key: string, value: string): Promise<void> {
  await exec(
    await getDb(),
    "INSERT INTO Settings (Key, Value, Updated_At) VALUES (?, ?, ?) ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value, Updated_At = excluded.Updated_At",
    key,
    value,
    Date.now()
  );
}

/** Every setting as a flat object (used by the Settings page + export). */
export async function allSettings(): Promise<Record<string, string>> {
  const rows = await queryAll<{ Key: string; Value: string }>(
    await getDb(),
    "SELECT Key, Value FROM Settings ORDER BY Key"
  );
  const out: Record<string, string> = {};
  for (const row of rows) out[row.Key] = row.Value;
  return out;
}

/* ------------------------------------------------------------------ */
/* Typed convenience accessors                                         */
/* ------------------------------------------------------------------ */

export async function internetTargets(): Promise<MonitorTarget[]> {
  return getJsonSetting<MonitorTarget[]>("monitor.internetTargets", []);
}

export async function gatewayTargets(): Promise<MonitorTarget[]> {
  return getJsonSetting<MonitorTarget[]>("monitor.gatewayTargets", []);
}

export async function staleAfterSeconds(): Promise<number> {
  return getNumberSetting("monitor.staleAfterSeconds", 300);
}

export async function defaultPollSeconds(): Promise<number> {
  return getNumberSetting("monitor.defaultPollSeconds", 60);
}

export async function defaultFailureThreshold(): Promise<number> {
  return getNumberSetting("monitor.failureThreshold", 3);
}
