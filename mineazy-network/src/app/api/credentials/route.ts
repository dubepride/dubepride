/**
 * ============================================================================
 *  GET  /api/credentials — SNMP credentials (redacted)
 *  POST /api/credentials — store a credential
 * ============================================================================
 *
 *  SECURITY: a community string or an SNMPv3 key is write-only from the
 *  browser. The GET handler returns the redacted preview produced by
 *  `credentialSummaries()` — the real value is never serialised into a
 *  response, not even to an administrator.
 * ============================================================================
 */

import { credentialSummaries, createCredential } from "@/lib/repo/credentials";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";
import type { SnmpVersion } from "@/lib/repo/credentials";

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_manage_credentials");
  if (gate.response) return gate.response;

  const credentials = await credentialSummaries();
  return ok({ credentials, count: credentials.length });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_manage_credentials");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return fail("A credential name is required.");

  const version: SnmpVersion =
    body.version === "1" || body.version === "2c" || body.version === "3" ? body.version : "2c";

  let id: number;
  try {
    id = await createCredential({
      name,
      version,
      community: typeof body.community === "string" ? body.community : "",
      username: typeof body.username === "string" ? body.username : "",
      authProtocol: typeof body.authProtocol === "string" ? body.authProtocol : "SHA",
      authKey: typeof body.authKey === "string" ? body.authKey : "",
      privProtocol: typeof body.privProtocol === "string" ? body.privProtocol : "AES",
      privKey: typeof body.privKey === "string" ? body.privKey : "",
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The credential could not be stored.");
  }

  // The audit trail records THAT a credential changed — never the secret.
  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "create",
    entity: "credential",
    entityId: id,
    after: { name, version },
    note: "An SNMP credential was stored (secret values are never written to the audit trail).",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: `SNMP credential added: ${name}`,
    detail: `A new SNMPv${version} credential was stored.`,
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ id, name }, 201);
}
