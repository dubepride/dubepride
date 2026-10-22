/**
 * ============================================================================
 *  GET /api/health — is this installation ready?
 * ============================================================================
 *
 *  A PUBLIC endpoint (no session required) so the setup wizard and any
 *  external watchdog can check the installation before an operator has
 *  signed in.
 *
 *  It reports the bare minimum and NOTHING sensitive: no hostnames, no
 *  addresses, no counts of devices, no credentials, no versions of the
 *  credential store. It answers three questions:
 *
 *    • Is the database reachable and migrated?
 *    • Does an administrator account exist yet?
 *    • Is the console in the labelled demo mode?
 * ============================================================================
 */

import { connection } from "next/server";

import { queryOne } from "@/lib/db";
import { isDemoMode } from "@/lib/db";
import { fail, ok } from "@/lib/api";

export async function GET(): Promise<Response> {
  /*
   * This endpoint has no session and no other request-time API, so without
   * this it is PRERENDERED AT BUILD TIME and answers with the state of the
   * machine that ran `next build` — the wrong database, the wrong demo flag
   * and the wrong collector mode, for the life of the deployment. The
   * setup wizard and any external watchdog poll it to decide whether the
   * installation is ready, so it has to describe the RUNNING installation.
   */
  await connection();

  let adminAccountExists = false;
  let databaseReady = false;
  let collectorMode = "unknown";

  try {
    const admin = await queryOne<{ c: number }>(
      await (await import("@/lib/db")).getDb(),
      "SELECT COUNT(*) AS c FROM Users WHERE Role = 'administrator' AND Active = 1"
    );
    adminAccountExists = (admin?.c ?? 0) > 0;
    databaseReady = true;

    const mode = await queryOne<{ Value: string }>(
      await (await import("@/lib/db")).getDb(),
      "SELECT Value FROM Settings WHERE Key = 'collector.mode'"
    );
    collectorMode = mode?.Value ?? "real";
  } catch (error) {
    return fail(
      `The database is not ready: ${error instanceof Error ? error.message : String(error)}`,
      503
    );
  }

  return ok({
    databaseReady,
    adminAccountExists,
    demoMode: isDemoMode(),
    collectorMode,
  });
}
