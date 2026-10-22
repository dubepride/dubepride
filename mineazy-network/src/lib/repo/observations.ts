/**
 * ============================================================================
 *  repo/observations.ts — probe results
 * ============================================================================
 *
 *  Every probe the collector runs is recorded here — successful or not. The
 *  incident engine reads these rows to build the "Evidence" block, so the
 *  administrator always sees the actual probe output rather than a claim.
 */

import { getDb, queryAll, exec } from "../db";
import type { HealthObservation } from "../types";

interface ObservationRow {
  Observation_ID: number;
  Device_ID: number;
  Port_ID: number | null;
  Observed_At: number;
  Probe_Type: string;
  Probe_Target: string;
  Result: string;
  Latency_Ms: number | null;
  Reason: string;
  Source: string;
}

function toObservation(row: ObservationRow): HealthObservation {
  return {
    id: row.Observation_ID,
    deviceId: row.Device_ID,
    portId: row.Port_ID,
    observedAt: row.Observed_At,
    probeType: row.Probe_Type as HealthObservation["probeType"],
    probeTarget: row.Probe_Target,
    result: row.Result as HealthObservation["result"],
    latencyMs: row.Latency_Ms,
    reason: row.Reason,
    source: row.Source,
  };
}

/** Record one probe result. */
export async function recordObservation(observation: Omit<HealthObservation, "id">): Promise<void> {
  await exec(
    await getDb(),
    `INSERT INTO Health_Observations
      (Device_ID, Port_ID, Observed_At, Probe_Type, Probe_Target, Result, Latency_Ms, Reason, Source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    observation.deviceId,
    observation.portId ?? null,
    observation.observedAt,
    observation.probeType,
    observation.probeTarget,
    observation.result,
    observation.latencyMs ?? null,
    observation.reason ?? "",
    observation.source ?? ""
  );
}

/** The newest observations for a device. */
export async function latestObservations(deviceId: number, limit = 12): Promise<HealthObservation[]> {
  const rows = await queryAll<ObservationRow>(
    await getDb(),
    "SELECT * FROM Health_Observations WHERE Device_ID = ? ORDER BY Observed_At DESC LIMIT ?",
    deviceId,
    limit
  );
  return rows.map(toObservation);
}

/**
 * The consecutive reachability outcome for a device.
 *
 * Counting backwards from the newest observation tells us how many
 * consecutive probes failed (the device is offline) or succeeded (the device
 * is answering). Only reachability probes count — a link-state observation
 * or an SNMP read must not be mistaken for a ping answer.
 */
export async function consecutiveProbeResults(
  deviceId: number
): Promise<{ failures: number; successes: number }> {
  const rows = await queryAll<{ Result: string }>(
    await getDb(),
    `SELECT Result FROM Health_Observations
      WHERE Device_ID = ? AND Probe_Type IN ('icmp', 'tcp', 'http')
      ORDER BY Observed_At DESC, Observation_ID DESC
      LIMIT 50`,
    deviceId
  );

  let failures = 0;
  let successes = 0;
  for (const row of rows) {
    if (row.Result === "failure" || row.Result === "error") {
      failures += 1;
    } else if (row.Result === "success") {
      successes += 1;
      break; // the streak of successes ends at the first failure
    } else {
      // "skipped" probes are neutral — they neither extend nor break a streak.
      continue;
    }
  }
  return { failures, successes };
}

/** Observations inside a time window. */
export async function observationsSince(
  deviceId: number,
  since: number,
  limit = 200
): Promise<HealthObservation[]> {
  const rows = await queryAll<ObservationRow>(
    await getDb(),
    "SELECT * FROM Health_Observations WHERE Device_ID = ? AND Observed_At >= ? ORDER BY Observed_At DESC LIMIT ?",
    deviceId,
    since,
    limit
  );
  return rows.map(toObservation);
}

/** Observations across the whole system (recent activity feed). */
export async function recentObservations(limit = 100): Promise<HealthObservation[]> {
  const rows = await queryAll<ObservationRow>(
    await getDb(),
    "SELECT * FROM Health_Observations ORDER BY Observed_At DESC LIMIT ?",
    limit
  );
  return rows.map(toObservation);
}

/** Delete observations older than a cutoff (retention). */
export async function pruneObservations(cutoff: number): Promise<number> {
  const db = await getDb();
  const before = (await queryAll<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Health_Observations"))?.[0]?.c ?? 0;
  await exec(db, "DELETE FROM Health_Observations WHERE Observed_At < ?", cutoff);
  const after = (await queryAll<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Health_Observations"))?.[0]?.c ?? 0;
  return before - after;
}
