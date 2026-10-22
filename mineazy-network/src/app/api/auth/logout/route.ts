/**
 * ============================================================================
 *  POST /api/auth/logout — sign out
 * ============================================================================
 *
 *  Always succeeds: clearing a cookie must work even when the session has
 *  already expired.
 * ============================================================================
 */

import { SESSION_COOKIE } from "@/lib/session";
import { currentAccount, ok } from "@/lib/api";
import { recordAudit } from "@/lib/repo/audit";

export async function POST(): Promise<Response> {
  const account = await currentAccount();
  if (account) {
    await recordAudit({
      userId: account.id,
      userName: account.username,
      action: "sign_out",
      entity: "session",
      entityId: account.id,
      note: "Signed out of the console.",
    });
  }

  const response = ok({ signedOut: true });
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
  return response;
}
