/**
 * ============================================================================
 *  repo/users.ts — console accounts
 * ============================================================================
 */

import { getDb, queryAll, queryOne, exec, run } from "../db";
import { hashPassword, verifyPassword } from "../passwords";
import { permissionsForRole, type PermissionKey, type UserRole } from "../rbac";
import { verifySessionToken } from "../session";
import type { User } from "../types";

interface UserRow {
  User_ID: number;
  Username: string;
  Email: string;
  Display_Name: string;
  Password_Hash: string;
  Role: string;
  Active: number;
  Created_At: number;
  Last_Login_At: number | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.User_ID,
    username: row.Username,
    email: row.Email,
    displayName: row.Display_Name,
    role: row.Role as UserRole,
    active: row.Active === 1,
    createdAt: row.Created_At,
    lastLoginAt: row.Last_Login_At,
  };
}

/** Every account (newest first). */
export async function listUsers(): Promise<User[]> {
  const rows = await queryAll<UserRow>(
    await getDb(),
    "SELECT * FROM Users ORDER BY Created_At DESC"
  );
  return rows.map(toUser);
}

/** One account by id. */
export async function userById(id: number): Promise<User | null> {
  const row = await queryOne<UserRow>(await getDb(), "SELECT * FROM Users WHERE User_ID = ?", id);
  return row ? toUser(row) : null;
}

/** One account by username (case-insensitive). */
export async function userByUsername(username: string): Promise<(User & { passwordHash: string }) | null> {
  const row = await queryOne<UserRow>(
    await getDb(),
    "SELECT * FROM Users WHERE Username = ? COLLATE NOCASE",
    username
  );
  if (!row) return null;
  return { ...toUser(row), passwordHash: row.Password_Hash };
}

/** The signed-in account resolved from a session token (null when invalid). */
export async function accountByToken(
  token: string | null | undefined
): Promise<(User & { permissions: Record<PermissionKey, boolean> }) | null> {
  const claims = verifySessionToken(token);
  if (!claims) return null;
  const row = await queryOne<UserRow>(
    await getDb(),
    "SELECT * FROM Users WHERE User_ID = ?",
    Number(claims.sub)
  );
  if (!row || row.Active !== 1) return null;
  const user = toUser(row);
  return { ...user, permissions: permissionsForRole(user.role) };
}

/** Check a username/password pair. Returns the account on success. */
export async function authenticate(
  username: string,
  password: string
): Promise<(User & { permissions: Record<PermissionKey, boolean> }) | null> {
  const row = await userByUsername((username ?? "").trim());
  if (!row || !row.active) return null;
  if (!verifyPassword(password ?? "", row.passwordHash)) return null;
  await exec(await getDb(), "UPDATE Users SET Last_Login_At = ? WHERE User_ID = ?", Date.now(), row.id);
  const { passwordHash: _ignored, ...user } = row;
  return { ...user, permissions: permissionsForRole(user.role) };
}

export interface UserInput {
  username: string;
  email: string;
  /** Optional — falls back to the username when omitted or blank. */
  displayName?: string;
  role: UserRole;
  password?: string;
  active?: boolean;
}

/** Create an account. Throws when the username/email is taken. */
export async function createUser(input: UserInput): Promise<number> {
  const db = await getDb();
  const username = input.username.trim();
  const email = input.email.trim();
  if (!username) throw new Error("Username is required.");
  if (!email) throw new Error("Email is required.");
  if (!input.password || input.password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const existing = await queryOne<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM Users WHERE Username = ? COLLATE NOCASE OR Email = ? COLLATE NOCASE",
    username,
    email
  );
  if ((existing?.c ?? 0) > 0) throw new Error("That username or email is already registered.");
  const { lastId } = await run(
    db,
    `INSERT INTO Users (Username, Email, Display_Name, Password_Hash, Role, Active, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    username,
    email,
    input.displayName?.trim() || username,
    hashPassword(input.password),
    input.role,
    input.active === false ? 0 : 1,
    Date.now()
  );
  return lastId;
}

/** Update an account's details (password only when supplied). */
export async function updateUser(
  id: number,
  patch: Partial<UserInput>
): Promise<void> {
  const db = await getDb();
  const current = await queryOne<UserRow>(db, "SELECT * FROM Users WHERE User_ID = ?", id);
  if (!current) throw new Error("That account no longer exists.");
  const email = patch.email?.trim() ?? current.Email;
  const clash = await queryOne<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM Users WHERE Email = ? COLLATE NOCASE AND User_ID <> ?",
    email,
    id
  );
  if ((clash?.c ?? 0) > 0) throw new Error("That email is already registered.");
  await exec(
    db,
    `UPDATE Users
        SET Email = ?, Display_Name = ?, Role = ?, Active = ?
      WHERE User_ID = ?`,
    email,
    patch.displayName?.trim() ?? current.Display_Name,
    patch.role ?? current.Role,
    patch.active === undefined ? current.Active : patch.active ? 1 : 0,
    id
  );
  if (patch.password && patch.password.length >= 8) {
    await setPassword(id, patch.password);
  }
}

/** Set a new password. */
export async function setPassword(id: number, password: string): Promise<void> {
  await exec(
    await getDb(),
    "UPDATE Users SET Password_Hash = ? WHERE User_ID = ?",
    hashPassword(password),
    id
  );
}

/** Delete an account (the last administrator cannot be removed). */
export async function deleteUser(id: number): Promise<void> {
  const db = await getDb();
  const admins =
    (await queryOne<{ c: number }>(
      db,
      "SELECT COUNT(*) AS c FROM Users WHERE Role = 'administrator' AND Active = 1"
    ))?.c ?? 0;
  const target = await queryOne<UserRow>(db, "SELECT * FROM Users WHERE User_ID = ?", id);
  if (!target) throw new Error("That account no longer exists.");
  if (target.Role === "administrator" && admins <= 1) {
    throw new Error("The last administrator account cannot be deleted.");
  }
  await exec(db, "DELETE FROM Users WHERE User_ID = ?", id);
}
