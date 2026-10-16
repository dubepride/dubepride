/**
 * ============================================================================
 *  /api/cron/erp-sync — scheduled ERP draining (serverless-friendly)
 * ============================================================================
 *
 *  On a long-lived Node host the 20-second retry loop in mock-generator.ts
 *  drains the Pending buffer. Serverless functions have no such loop, so this
 *  endpoint does the job when a scheduler calls it.
 *
 *  Guarded by CRON_SECRET. Accepted credentials (any one):
 *    • Authorization: Bearer <CRON_SECRET>   ← Vercel Cron sends this for you
 *    • x-cron-secret: <CRON_SECRET>          ← simple external schedulers
 *    • ?secret=<CRON_SECRET>                 ← last resort (may appear in logs)
 *
 *  Vercel Hobby only allows once-per-day crons (see vercel.json). For
 *  near-real-time draining add a free external scheduler (e.g. cron-job.org)
 *  hitting this URL every minute with the Bearer header, or rely on the
 *  `after()` kick that /api/biometrics/push fires after every device push.
 *
 *  Docs: node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
 */

import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runErpSync } from "@/lib/erp";

/** A sync may talk to a slow ERP; allow more than the default. */
export const maxDuration = 60;

/** Constant-time string compare (both sides hashed to equal length). */
function secretsMatch(a: string, b: string): boolean {
  const da = crypto.createHash("sha256").update(a).digest();
  const db = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

function configuredSecret(): string | null {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  return secret.length > 0 ? secret : null;
}

function authorized(request: NextRequest, secret: string): boolean {
  const bearer = request.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretsMatch(bearer.slice(7), secret)) return true;

  const custom = request.headers.get("x-cron-secret");
  if (custom && secretsMatch(custom, secret)) return true;

  const query = request.nextUrl.searchParams.get("secret");
  if (query && secretsMatch(query, secret)) return true;

  return false;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const secret = configuredSecret();
  if (!secret) {
    // Misconfiguration must be loud, never silently open.
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured on the server." },
      { status: 503 }
    );
  }

  if (!authorized(request, secret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const summary = await runErpSync("Auto");
  // The job itself ran successfully; the ERP outcome is reported in the body.
  return NextResponse.json({ ...summary, ok: summary.ok, ranAt: Date.now() }, { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
