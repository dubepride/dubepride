/**
 * ============================================================================
 *  repo/audit.ts — the administrative audit trail
 * ============================================================================
 *
 *  Every manual change (rename, re-categorise, new cable record, credential
 *  rotation, discovery scope change) is written here with the before/after
 *  values, so a "who changed this and when?" question always has an answer.
 */

import { getDb, queryAll, exec } from "../db";

export interface AuditEntry {
  id: number;
  at: number;
  userId: number | null;
  userName: string;
  action: string;
  entity: string;
  entityId: string;
  before: string;
  after: string;
  note: string;
}

interface AuditRow {
  Audit_ID: number;
  At: number;
  User_ID: number | null;
  User_Name: string;
  Action: string;
  Entity: string;
  Entity_ID: string;
  Before: string;
  After: string;
  Note: string;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.Audit_ID,
    at: row.At,
    userId: row.User_ID,
    userName: row.User_Name,
    action: row.Action,
    entity: row.Entity,
    entityId: row.Entity_ID,
    before: row.Before,
    after: row.After,
    note: row.Note,
  };
}

/** Write an audit entry. Never throws into the caller's flow. */
export async function recordAudit(entry: {
  userId?: number | null;
  userName?: string;
  action: string;
  entity?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  note?: string;
}): Promise<void> {
  try {
    await exec(
      await getDb(),
      `INSERT INTO Audit_Log (At, User_ID, User_Name, Action, Entity, Entity_ID, Before, After, Note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      entry.userId ?? null,
      entry.userName ?? "system",
      entry.action,
      entry.entity ?? "",
      entry.entityId === undefined ? "" : String(entry.entityId),
      entry.before === undefined ? "" : JSON.stringify(entry.before),
      entry.after === undefined ? "" : JSON.stringify(entry.after),
      entry.note ?? ""
    );
  } catch (err) {
    // Auditing must never break the operation it is recording.
    console.error("[audit] failed to write entry:", err);
  }
}

/** Audit entries, newest first. */
export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  const rows = await queryAll<AuditRow>(
    await getDb(),
    "SELECT * FROM Audit_Log ORDER BY At DESC LIMIT ?",
    limit
  );
  return rows.map(toEntry);
}
