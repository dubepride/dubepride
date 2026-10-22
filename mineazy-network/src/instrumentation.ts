/**
 * ============================================================================
 *  instrumentation.ts — the in-process collector
 * ============================================================================
 *
 *  Mineazy Network has two ways to run the monitoring engine:
 *
 *    1. `npm run collector` — a standalone process. This is the recommended
 *       deployment: monitoring keeps running when the console is restarted
 *       and a long SNMP poll can never block a UI request.
 *
 *    2. This instrumentation hook — the collector runs inside the Next.js
 *       server. Handy for a single-process install (Docker Compose with one
 *       container, a Raspberry Pi, a laptop).
 *
 *  Either way only ONE writer is allowed at a time: `collector/lock.ts` is a
 *  pid-based file lock, so starting the standalone collector automatically
 *  stops the in-process one from starting (and vice versa).
 *
 *  The hook never runs during a production build.
 *
 *  Everything Node-specific lives in `collector/inline.ts` and is imported
 *  dynamically behind the `NEXT_RUNTIME` guard, so the Edge runtime bundle
 *  contains no filesystem or process-signal code.
 * ============================================================================
 */

export async function register(): Promise<void> {
  // The Edge runtime build of this file must stay free of Node APIs.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Never start collecting during `next build`.
  const phase = process.env.NEXT_PHASE ?? "";
  if (phase.includes("build")) return;

  const { startInlineCollector } = await import("./collector/inline");
  await startInlineCollector();
}
