/**
 * ============================================================================
 *  repo/traffic.ts — historical traffic samples
 * ============================================================================
 *
 *  A sample stores the raw counter values, the derived rates and the window
 *  they were measured over. `Counter_Valid = 0` marks a sample whose rate
 *  could not be trusted (counter reset / rollover / device restart) — the
 *  UI shows the raw counters but refuses to draw a speed from them.
 */

import { getDb, queryAll, queryOne, exec } from "../db";
import type { TrafficSample } from "../types";

interface SampleRow {
  Subject_Type: string;
  Subject_ID: number;
  Sampled_At: number;
  In_Bytes: number | null;
  Out_Bytes: number | null;
  In_Rate_Bps: number | null;
  Out_Rate_Bps: number | null;
  In_Pps: number | null;
  Out_Pps: number | null;
  In_Errors: number | null;
  Out_Errors: number | null;
  Counter_Valid: number;
  Window_Seconds: number | null;
  Source: string;
}

function toSample(row: SampleRow): TrafficSample {
  return {
    subjectType: row.Subject_Type as TrafficSample["subjectType"],
    subjectId: row.Subject_ID,
    sampledAt: row.Sampled_At,
    inBytes: row.In_Bytes,
    outBytes: row.Out_Bytes,
    inRateBps: row.In_Rate_Bps,
    outRateBps: row.Out_Rate_Bps,
    inPps: row.In_Pps,
    outPps: row.Out_Pps,
    inErrors: row.In_Errors,
    outErrors: row.Out_Errors,
    counterValid: row.Counter_Valid === 1,
    windowSeconds: row.Window_Seconds,
    source: row.Source,
  };
}

/** Store one traffic sample. */
export async function recordSample(sample: Omit<TrafficSample, "subjectType" | "subjectId"> & {
  subjectType: "device" | "port";
  subjectId: number;
}): Promise<void> {
  await exec(
    await getDb(),
    `INSERT INTO Traffic_Samples
      (Subject_Type, Subject_ID, Sampled_At, In_Bytes, Out_Bytes, In_Rate_Bps, Out_Rate_Bps,
       In_Pps, Out_Pps, In_Errors, Out_Errors, Counter_Valid, Window_Seconds, Source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sample.subjectType,
    sample.subjectId,
    sample.sampledAt,
    sample.inBytes ?? null,
    sample.outBytes ?? null,
    sample.inRateBps ?? null,
    sample.outRateBps ?? null,
    sample.inPps ?? null,
    sample.outPps ?? null,
    sample.inErrors ?? null,
    sample.outErrors ?? null,
    sample.counterValid ? 1 : 0,
    sample.windowSeconds ?? null,
    sample.source ?? ""
  );
}

/** Samples for one subject inside a time window (oldest first). */
export async function samplesSince(
  subjectType: "device" | "port",
  subjectId: number,
  since: number,
  limit = 500
): Promise<TrafficSample[]> {
  const rows = await queryAll<SampleRow>(
    await getDb(),
    `SELECT * FROM Traffic_Samples
      WHERE Subject_Type = ? AND Subject_ID = ? AND Sampled_At >= ?
      ORDER BY Sampled_At DESC LIMIT ?`,
    subjectType,
    subjectId,
    since,
    limit
  );
  return rows.reverse().map(toSample);
}

/** The newest sample for one subject. */
export async function latestSample(
  subjectType: "device" | "port",
  subjectId: number
): Promise<TrafficSample | null> {
  const rows = await queryAll<SampleRow>(
    await getDb(),
    "SELECT * FROM Traffic_Samples WHERE Subject_Type = ? AND Subject_ID = ? ORDER BY Sampled_At DESC LIMIT 1",
    subjectType,
    subjectId
  );
  return rows[0] ? toSample(rows[0]) : null;
}

/**
 * When was the last time real traffic was measured on a subject?
 *
 * Used to decide whether a link with readable counters is idle (NO_TRAFFIC)
 * or merely quiet. Returns null when no valid, non-zero sample exists.
 */
export async function lastTrafficActivity(
  subjectType: "device" | "port",
  subjectId: number
): Promise<number | null> {
  const row = await queryOne<{ At: number }>(
    await getDb(),
    `SELECT Sampled_At AS At FROM Traffic_Samples
      WHERE Subject_Type = ? AND Subject_ID = ?
        AND Counter_Valid = 1
        AND (COALESCE(In_Rate_Bps, 0) > 0 OR COALESCE(Out_Rate_Bps, 0) > 0)
      ORDER BY Sampled_At DESC LIMIT 1`,
    subjectType,
    subjectId
  );
  return row?.At ?? null;
}

/** The busiest subjects in a window (Traffic + Performance view). */
export async function topSubjects(
  since: number,
  limit = 20
): Promise<{ subjectType: string; subjectId: number; totalBytes: number; maxRateBps: number }[]> {
  const rows = await queryAll<{
    Subject_Type: string;
    Subject_ID: number;
    total: number;
    peak: number;
  }>(
    await getDb(),
    `SELECT Subject_Type, Subject_ID,
            SUM(COALESCE(In_Bytes,0) + COALESCE(Out_Bytes,0)) AS total,
            MAX(COALESCE(In_Rate_Bps,0), COALESCE(Out_Rate_Bps,0)) AS peak
       FROM Traffic_Samples
      WHERE Sampled_At >= ?
      GROUP BY Subject_Type, Subject_ID
      ORDER BY total DESC
      LIMIT ?`,
    since,
    limit
  );
  return rows.map((r) => ({
    subjectType: r.Subject_Type,
    subjectId: r.Subject_ID,
    totalBytes: Number(r.total ?? 0),
    maxRateBps: Number(r.peak ?? 0),
  }));
}

/** Delete samples older than a cutoff (retention). */
export async function pruneSamples(cutoff: number): Promise<number> {
  const db = await getDb();
  const before =
    (await queryAll<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Traffic_Samples"))?.[0]?.c ?? 0;
  await exec(db, "DELETE FROM Traffic_Samples WHERE Sampled_At < ?", cutoff);
  const after =
    (await queryAll<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Traffic_Samples"))?.[0]?.c ?? 0;
  return before - after;
}
