/**
 * ============================================================================
 *  GET    /api/credentials/:id — one SNMP credential (redacted)
 *  PATCH  /api/credentials/:id — rotate or retune a credential
 *  DELETE /api/credentials/:id — remove a credential
 * ============================================================================
 *
 *  SECURITY: the secret is write-only from the browser, in both directions.
 *  The GET handler never decrypts anything — it returns the same redacted
 *  preview as the list endpoint. The PATCH handler accepts a new secret but
 *  never echoes it back, and neither the secret nor the audit trail ever
 *  contains it.
 * ============================================================================
 */

import {
  credentialSummaries,
  deleteCredential,
  getCredential,
  updateCredential,
} from "@/lib/repo/credentials";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";
import type { SnmpVersion } from "@/lib/repo/credentials";

type Params = { params: Promise<{ id: string }> };

async function resolveId(params: Params["params"]): Promise<number | null> {
  const { id } = await params;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_manage_credentials");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid credential id.", 400);

  const credential = await getCredential(id);
  if (!credential) return fail("That credential no longer exists.", 404);

  // Reuse the list summariser so the redaction rules can only ever be one
  // implementation — there is no second path that could leak a secret.
  const summary = (await credentialSummaries()).find((entry) => entry.id === id);
  if (!summary) return fail("That credential no longer exists.", 404);

  return ok({ credential: summary });
}

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_manage_credentials");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid credential id.", 400);

  const current = await getCredential(id);
  if (!current) return fail("That credential no longer exists.", 404);

  const body = await readJson(request);
  const patch: Parameters<typeof updateCredential>[1] = {};

  if (typeof body.version === "string") {
    const version = body.version as SnmpVersion;
    if (version !== "1" && version !== "2c" && version !== "3") {
      return fail(`Unknown SNMP version "${body.version}".`);
    }
    patch.version = version;
  }
  if (typeof body.username === "string") patch.username = body.username;
  if (typeof body.authProtocol === "string") patch.authProtocol = body.authProtocol;
  if (typeof body.privProtocol === "string") patch.privProtocol = body.privProtocol;
  // An empty string means "leave the stored secret alone".
  if (typeof body.community === "string" && body.community.length > 0) {
    patch.community = body.community;
  }
  if (typeof body.authKey === "string" && body.authKey.length > 0) patch.authKey = body.authKey;
  if (typeof body.privKey === "string" && body.privKey.length > 0) patch.privKey = body.privKey;

  if (Object.keys(patch).length === 0) return fail("Nothing to change.");

  try {
    await updateCredential(id, patch);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The credential could not be updated.");
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "credential",
    entityId: id,
    before: { name: current.name, version: current.version, username: current.username },
    after: {
      name: current.name,
      version: patch.version ?? current.version,
      username: patch.username ?? current.username,
    },
    note: "An SNMP credential was changed (secret values are never written to the audit trail).",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: `SNMP credential changed: ${current.name}`,
    detail: `The credential was updated to SNMPv${patch.version ?? current.version}.`,
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  const summary = (await credentialSummaries()).find((entry) => entry.id === id);
  return ok({ id, credential: summary ?? null });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const gate = await requirePermission("can_manage_credentials");
  if (gate.response) return gate.response;

  const id = await resolveId(params);
  if (id === null) return fail("Invalid credential id.", 400);

  const current = await getCredential(id);
  if (!current) return fail("That credential no longer exists.", 404);

  await deleteCredential(id);

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "delete",
    entity: "credential",
    entityId: id,
    before: { name: current.name, version: current.version },
    note: "An SNMP credential was deleted (secret values are never written to the audit trail).",
  });
  await recordEvent({
    type: "config_changed",
    severity: "minor",
    title: `SNMP credential removed: ${current.name}`,
    detail: "The credential is no longer available to the collector.",
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ id, deleted: true });
}
