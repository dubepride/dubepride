/**
 * ============================================================================
 *  repo/events.ts — the operational event log
 * ============================================================================
 *
 *  Append-only record of everything that changed: a device went away, a port
 *  flapped, the internet checks failed, a device was discovered, an
 *  administrator renamed a switch. The Event History screen renders this
 *  stream; the incident engine also writes to it.
 */

import { getDb, queryAll, exec } from "../db";
import type { EventType, NetworkEvent, Severity } from "../types";

interface EventRow {
  Event_ID: number;
  At: number;
  Type: string;
  Severity: string;
  Title: string;
  Detail: string;
  Subject_Type: string;
  Subject_ID: number | null;
  Source: string;
}

function toEvent(row: EventRow): NetworkEvent {
  return {
    id: row.Event_ID,
    at: row.At,
    type: row.Type as EventType,
    severity: row.Severity as Severity,
    title: row.Title,
    detail: row.Detail,
    subjectType: row.Subject_Type as NetworkEvent["subjectType"],
    subjectId: row.Subject_ID,
    source: row.Source,
  };
}

/** Append an event. */
export async function recordEvent(event: {
  type: EventType;
  severity?: Severity;
  title: string;
  detail?: string;
  subjectType?: NetworkEvent["subjectType"];
  subjectId?: number | null;
  source?: string;
}): Promise<void> {
  await exec(
    await getDb(),
    `INSERT INTO Events (At, Type, Severity, Title, Detail, Subject_Type, Subject_ID, Source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    Date.now(),
    event.type,
    event.severity ?? "info",
    event.title,
    event.detail ?? "",
    event.subjectType ?? "system",
    event.subjectId ?? null,
    event.source ?? ""
  );
}

/** Events newest first, with optional filters. */
export async function listEvents(filter: {
  limit?: number;
  since?: number;
  type?: string;
  severity?: string;
  subjectType?: string;
  subjectId?: number;
} = {}): Promise<NetworkEvent[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.since !== undefined) {
    where.push("At >= ?");
    args.push(filter.since);
  }
  if (filter.type) {
    where.push("Type = ?");
    args.push(filter.type);
  }
  if (filter.severity) {
    where.push("Severity = ?");
    args.push(filter.severity);
  }
  if (filter.subjectType) {
    where.push("Subject_Type = ?");
    args.push(filter.subjectType);
  }
  if (filter.subjectId !== undefined) {
    where.push("Subject_ID = ?");
    args.push(filter.subjectId);
  }
  const limit = filter.limit ?? 200;
  const rows = await queryAll<EventRow>(
    await getDb(),
    `SELECT * FROM Events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY At DESC LIMIT ?`,
    ...args,
    limit
  );
  return rows.map(toEvent);
}

/** Delete events older than a cutoff (retention). */
export async function pruneEvents(cutoff: number): Promise<number> {
  const db = await getDb();
  const before = (await queryAll<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Events"))?.[0]?.c ?? 0;
  await exec(db, "DELETE FROM Events WHERE At < ?", cutoff);
  const after = (await queryAll<{ c: number }>(db, "SELECT COUNT(*) AS c FROM Events"))?.[0]?.c ?? 0;
  return before - after;
}
