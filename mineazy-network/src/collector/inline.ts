/**
 * ============================================================================
 *  collector/inline.ts — the in-process collector entry point
 * ============================================================================
 *
 *  This module is Node-only (it touches the filesystem and the process
 *  signals), so `instrumentation.ts` imports it *dynamically* behind a
 *  `NEXT_RUNTIME === "nodejs"` guard. That keeps the Edge runtime bundle free
 *  of `node:fs` / `node:path` / `process.kill` and silences the
 *  "Node.js API is used … not supported in the Edge Runtime" warnings.
 *
 *  It is intentionally separate from `instrumentation.ts` so the runtime
 *  guard is the only thing the Edge bundle ever sees.
 * ============================================================================
 */

import { acquireLock, releaseLock } from "./lock";

/** True when the process should host the collector in-process. */
export function inlineCollectorEnabled(): boolean {
  const explicit = (process.env.MINEAZY_INLINE_COLLECTOR ?? "").trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "no") return false;
  if (explicit === "1" || explicit === "true" || explicit === "yes") return true;

  // Default: on in demo mode (so the simulator runs out of the box), off for
  // a production install where the standalone collector is expected.
  const demo = (process.env.MINEAZY_DEMO ?? "").trim().toLowerCase();
  return demo === "1" || demo === "true" || demo === "yes";
}

/**
 * Start the collector inside this process.
 *
 * Returns false when the collector was not started (disabled, or another
 * collector already holds the single-writer lock).
 */
export async function startInlineCollector(): Promise<boolean> {
  if (!inlineCollectorEnabled()) return false;

  // Only one writer may touch the database at a time.
  const refusal = acquireLock();
  if (refusal) {
    console.warn(`[instrumentation] in-process collector not started: ${refusal}`);
    return false;
  }

  const { startCollectorLoop } = await import("./main");
  const stop = startCollectorLoop();

  const shutdown = (): void => {
    stop();
    releaseLock();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("[instrumentation] in-process collector started.");
  return true;
}
