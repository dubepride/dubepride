/**
 * ============================================================================
 *  GET    /api/users/:id — one console account
 *  PATCH  /api/users/:id — change an account (role, contact, password)
 *  DELETE /api/users/:id — remove an account
 * ============================================================================
 *
 *  Password hashes never leave the server. The API returns account metadata
 *  only — the hash is never serialised, not even to an administrator.
 *
 *  Two guard rails are enforced here rather than only in the repository:
 *  an administrator may not demote or disable the LAST active administrator,
 *  and nobody may delete or disable their own account.
 * ============================================================================
 */

import { deleteUser, listUsers, updateUser, userById } from "@/lib/repo/users";
import { ROLES, roleLabel, type UserRole } from "@/lib/rbac";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

async function resolveId(params: Params["params"]): Promise<number | null> {
  const { id } = await params;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_manage_users");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid account id.", 400);

  const user = await userById(id);
  if (!user) return fail("That account no longer exists.", 404);

  return ok({ user });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_manage_users");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid account id.", 400);

  const current = await userById(id);
  if (!current) return fail("That account no longer exists.", 404);

  const body = await readJson(request);
  const patch: Parameters<typeof updateUser>[1] = {};

  if (typeof body.email === "string") patch.email = body.email;
  if (typeof body.displayName === "string") patch.displayName = body.displayName;
  if (typeof body.password === "string" && body.password.length > 0) patch.password = body.password;
  if (typeof body.role === "string") {
    if (!ROLES.some((candidate) => candidate.role === body.role)) {
      return fail("That role does not exist.");
    }
    patch.role = body.role as UserRole;
  }
  if (typeof body.active === "boolean") patch.active = body.active;

  if (Object.keys(patch).length === 0) return fail("Nothing to change.");
  if (patch.password !== undefined && patch.password.length < 8) {
    return fail("The password must be at least 8 characters long.");
  }

  // Guard rail: the last active administrator must survive every change.
  const losesAdministrator =
    current.role === "administrator" &&
    current.active &&
    ((patch.role !== undefined && patch.role !== "administrator") || patch.active === false);
  if (losesAdministrator) {
    const admins = (await listUsers()).filter(
      (candidate) => candidate.role === "administrator" && candidate.active
    );
    if (admins.length <= 1) {
      return fail("This is the last active administrator account — it cannot be demoted or disabled.");
    }
  }

  try {
    await updateUser(id, patch);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The account could not be updated.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "user",
    entityId: id,
    before: {
      username: current.username,
      email: current.email,
      role: roleLabel(current.role),
      active: current.active,
    },
    after: {
      username: current.username,
      email: patch.email?.trim() ?? current.email,
      role: patch.role ? roleLabel(patch.role) : roleLabel(current.role),
      active: patch.active ?? current.active,
    },
    note: patch.password !== undefined
      ? "An account was updated and its password was reset."
      : "An account was updated.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: `Account updated: ${current.username}`,
    detail: patch.password !== undefined
      ? "An administrator updated the account and reset its password."
      : "An administrator updated the account.",
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ id, user: await userById(id) });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_manage_users");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid account id.", 400);

  const current = await userById(id);
  if (!current) return fail("That account no longer exists.", 404);

  if (current.id === gate.account.id) {
    return fail("You cannot delete the account you are signed in with.");
  }

  try {
    await deleteUser(id);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The account could not be deleted.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "delete",
    entity: "user",
    entityId: id,
    before: { username: current.username, role: roleLabel(current.role) },
    note: "A console account was deleted.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "minor",
    title: `Account deleted: ${current.username}`,
    detail: "An administrator deleted this console account.",
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ id, deleted: true });
}
