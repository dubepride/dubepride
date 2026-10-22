/**
 * ============================================================================
 *  repo/credentials.ts — SNMP credential storage
 * ============================================================================
 *
 *  Secrets are encrypted at rest (see lib/secrets.ts) and are NEVER returned
 *  to the browser: the API only exposes a redacted preview (e.g. "p•••••••d")
 *  and the "has community / has auth key" booleans.
 *
 *  The collector decrypts them locally when it talks to a device.
 */

import { getDb, queryAll, queryOne, exec, run } from "../db";
import { decryptSecret, encryptSecret, redactSecret } from "../secrets";

export type SnmpVersion = "1" | "2c" | "3";

export interface SnmpCredential {
  id: number;
  name: string;
  version: SnmpVersion;
  username: string;
  authProtocol: string;
  privProtocol: string;
  /** Decrypted secrets — only populated for the collector, never for the API. */
  community: string;
  authKey: string;
  privKey: string;
  createdAt: number;
  updatedAt: number;
}

interface CredentialRow {
  Credential_ID: number;
  Name: string;
  Version: string;
  Community: string;
  Username: string;
  Auth_Protocol: string;
  Auth_Key: string;
  Priv_Protocol: string;
  Priv_Key: string;
  Created_At: number;
  Updated_At: number;
}

function toCredential(row: CredentialRow, decrypt: boolean): SnmpCredential {
  return {
    id: row.Credential_ID,
    name: row.Name,
    version: (row.Version as SnmpVersion) ?? "2c",
    username: row.Username,
    authProtocol: row.Auth_Protocol,
    privProtocol: row.Priv_Protocol,
    community: decrypt ? decryptSecret(row.Community) : "",
    authKey: decrypt ? decryptSecret(row.Auth_Key) : "",
    privKey: decrypt ? decryptSecret(row.Priv_Key) : "",
    createdAt: row.Created_At,
    updatedAt: row.Updated_At,
  };
}

/** Every credential with secrets decrypted (collector use only). */
export async function listCredentials(withSecrets = false): Promise<SnmpCredential[]> {
  const rows = await queryAll<CredentialRow>(await getDb(), "SELECT * FROM SNMP_Credentials ORDER BY Name");
  return rows.map((row) => toCredential(row, withSecrets));
}

/** One credential by id (secrets decrypted when requested). */
export async function getCredential(id: number, withSecrets = false): Promise<SnmpCredential | null> {
  const row = await queryOne<CredentialRow>(
    await getDb(),
    "SELECT * FROM SNMP_Credentials WHERE Credential_ID = ?",
    id
  );
  return row ? toCredential(row, withSecrets) : null;
}

/** A credential by name (secrets decrypted). */
export async function credentialByName(name: string): Promise<SnmpCredential | null> {
  const row = await queryOne<CredentialRow>(
    await getDb(),
    "SELECT * FROM SNMP_Credentials WHERE Name = ? COLLATE NOCASE LIMIT 1",
    name
  );
  return row ? toCredential(row, true) : null;
}

/** Create a credential (secrets encrypted before they touch the disk). */
export async function createCredential(input: {
  name: string;
  version: SnmpVersion;
  community?: string;
  username?: string;
  authProtocol?: string;
  authKey?: string;
  privProtocol?: string;
  privKey?: string;
}): Promise<number> {
  const name = input.name.trim();
  if (!name) throw new Error("Credential name is required.");
  if (input.version === "3" && !input.username?.trim()) {
    throw new Error("SNMPv3 requires a username.");
  }
  if (input.version !== "3" && !input.community?.trim()) {
    throw new Error("SNMPv1/v2c requires a community string.");
  }
  const now = Date.now();
  const { lastId } = await run(
    await getDb(),
    `INSERT INTO SNMP_Credentials
      (Name, Version, Community, Username, Auth_Protocol, Auth_Key, Priv_Protocol, Priv_Key, Created_At, Updated_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    name,
    input.version,
    encryptSecret(input.community ?? ""),
    input.username ?? "",
    input.authProtocol ?? "",
    encryptSecret(input.authKey ?? ""),
    input.privProtocol ?? "",
    encryptSecret(input.privKey ?? ""),
    now,
    now
  );
  return lastId;
}

/** Update a credential. Empty secret fields are left untouched. */
export async function updateCredential(
  id: number,
  patch: {
    version?: SnmpVersion;
    community?: string;
    username?: string;
    authProtocol?: string;
    authKey?: string;
    privProtocol?: string;
    privKey?: string;
  }
): Promise<void> {
  const db = await getDb();
  const current = await queryOne<CredentialRow>(db, "SELECT * FROM SNMP_Credentials WHERE Credential_ID = ?", id);
  if (!current) throw new Error("That credential no longer exists.");
  await exec(
    db,
    `UPDATE SNMP_Credentials
        SET Version = ?, Community = ?, Username = ?, Auth_Protocol = ?, Auth_Key = ?,
            Priv_Protocol = ?, Priv_Key = ?, Updated_At = ?
      WHERE Credential_ID = ?`,
    patch.version ?? current.Version,
    patch.community ? encryptSecret(patch.community) : current.Community,
    patch.username ?? current.Username,
    patch.authProtocol ?? current.Auth_Protocol,
    patch.authKey ? encryptSecret(patch.authKey) : current.Auth_Key,
    patch.privProtocol ?? current.Priv_Protocol,
    patch.privKey ? encryptSecret(patch.privKey) : current.Priv_Key,
    Date.now(),
    id
  );
}

/** Delete a credential. */
export async function deleteCredential(id: number): Promise<void> {
  await exec(await getDb(), "DELETE FROM SNMP_Credentials WHERE Credential_ID = ?", id);
}

/** The safe-to-display shape (no secrets, only a redacted preview). */
export interface CredentialSummary {
  id: number;
  name: string;
  version: SnmpVersion;
  username: string;
  authProtocol: string;
  privProtocol: string;
  communityPreview: string;
  hasCommunity: boolean;
  hasAuthKey: boolean;
  hasPrivKey: boolean;
  updatedAt: number;
}

/** Credential list without secrets — what the Settings page renders. */
export async function credentialSummaries(): Promise<CredentialSummary[]> {
  const rows = await queryAll<CredentialRow>(
    await getDb(),
    "SELECT * FROM SNMP_Credentials ORDER BY Name"
  );
  return rows.map((row) => ({
    id: row.Credential_ID,
    name: row.Name,
    version: (row.Version as SnmpVersion) ?? "2c",
    username: row.Username,
    authProtocol: row.Auth_Protocol,
    privProtocol: row.Priv_Protocol,
    communityPreview: redactSecret(decryptSecret(row.Community)),
    hasCommunity: row.Community.length > 0,
    hasAuthKey: row.Auth_Key.length > 0,
    hasPrivKey: row.Priv_Key.length > 0,
    updatedAt: row.Updated_At,
  }));
}
