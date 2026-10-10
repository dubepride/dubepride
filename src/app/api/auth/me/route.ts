/**
 * ============================================================================
 *  GET /api/auth/me — the signed-in account + live permission matrix
 * ============================================================================
 *
 *  Phase 14 core: the client-side AuthContext polls this endpoint so the
 *  sidebar, Settings tabs and My Portal widgets render exactly what the
 *  logged-in System Account's Access Level permits. The matrix is resolved
 *  server-side from the account's Access_Level on every call — editing the
 *  matrix in Settings takes effect on the next poll without a re-login.
 *
 *  200 → { account, permissions, home }  (session cookie required)
 *  401 → unauthenticated
 */

import { currentAccount } from "@/lib/auth";

export async function GET(): Promise<Response> {
  const account = await currentAccount();
  if (!account) {
    return Response.json(
      { ok: false, error: "Unauthorized — sign in at /login." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  return Response.json(
    {
      ok: true,
      account: {
        accountId: account.accountId,
        firstName: account.firstName,
        surname: account.surname,
        name: account.name,
        email: account.email,
        accessLevelId: account.accessLevelId,
        levelName: account.levelName,
        branchId: account.branchId,
        branchName: account.branchName,
        employeeId: account.employeeId,
      },
      permissions: account.permissions,
      home: account.home,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}