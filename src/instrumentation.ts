/**
 * instrumentation.ts — Next.js server lifecycle hook.
 *
 * `register()` runs exactly once per Next.js server instance (dev + prod),
 * before the server accepts traffic. This is where the bridge boots its
 * background services:
 *
 *   • SQLite schema creation + demo seeding
 *   • Terminal simulator (simulated fingerprint scans every few seconds)
 *   • Background ERP retry loop (offline-buffer draining)
 *
 * On serverless platforms the last two are NOT armed: a function may be
 * frozen the instant the response is sent, so an in-process timer is
 * unreliable. There, ERP draining is driven by `after()` on each device push
 * (see /api/biometrics/push) plus scheduled calls to /api/cron/erp-sync.
 *
 * Docs: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md
 */

export async function register() {
  // Only the Node.js runtime owns the database and the timers.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Never start background work while `next build` is compiling pages.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Serverless: no long-lived process to host timers; skip the background
  // services entirely (the schema/seed still boot lazily on the first query).
  const { isServerlessRuntime } = await import("./lib/sqlite");
  if (isServerlessRuntime()) {
    console.log("[instrumentation] serverless runtime — background services disabled");
    return;
  }

  const { startMockServices } = await import("./lib/mock-generator");
  startMockServices();
}
