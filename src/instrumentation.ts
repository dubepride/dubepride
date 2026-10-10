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
 * Docs: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md
 */

export async function register() {
  // Only the Node.js runtime owns the database and the timers.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Never start background work while `next build` is compiling pages.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { startMockServices } = await import("./lib/mock-generator");
  startMockServices();
}
