/**
 * ============================================================================
 *  GET  /api/users — the console accounts
 *  POST /api/users — create an account
 * ============================================================================
 *
 *  Password hashes never leave the server. The API returns the account
 *  metadata only.
 * ============================================================================
 */

import { listUsers, createUser } from "@/lib/repo/users";
import { ROLES, roleLabel, type UserRole } from "@/lib/rbac";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_manage_users");
  if (gate.response) return gate.response;

  const users = await listUsers();
  return ok({
    users,
    roles: ROLES.map((role) => ({
      role: role.role,
      label: role.label,
      description: role.description,
      permissions: role.permissions,
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_manage_users");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role = typeof body.role === "string" ? body.role : "";

  if (!username) return fail("A username is required.");
  if (!email) return fail("An email address is required.");
  if (password.length < 8) return fail("The password must be at least 8 characters long.");
  if (!ROLES.some((candidate) => candidate.role === role)) {
    return fail("That role does not exist.");
  }

  let id: number;
  try {
    id = await createUser({
      username,
      email,
      displayName: typeof body.displayName === "string" ? body.displayName : username,
      role: role as UserRole,
      password,
      active: body.active !== false,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The account could not be created.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "create",
    entity: "user",
    entityId: id,
    after: { username, email, role: roleLabel(role) },
    note: "A console account was created.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: `Account created: ${username}`,
    detail: `A new ${roleLabel(role)} account was created.`,
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ id, username }, 201);
}
