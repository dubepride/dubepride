/**
 * ============================================================================
 *  collector/main.ts — the standalone collector process
 * ============================================================================
 *
 *  Run it with:
 *      npm run collector
 *
 *  The collector is deliberately a SEPARATE process from the web console:
 *
 *    • Monitoring must keep running when the browser is closed.
 *    • The console can be restarted (or upgraded) without interrupting the
 *      monitoring cycle.
 *    • A long SNMP poll can never block a UI request.
 *
 *  The same code can also be hosted inside the Next.js server (see
 *  `src/instrumentation.ts`) for single-process deployments — the lock in
 *  `lock.ts` guarantees that only one of them ever writes.
 * ============================================================================
 */

import { getNumberSetting, getSetting } from "../lib/settings";
import { recordEvent } from "../lib/repo/events";
import { acquireLock, releaseLock } from "./lock";
import { runCollectorCycle, type CollectorOptions } from "./worker";
import { seedSimulatedTopology, simulateCycle } from "./simulator";

/** How the collector is configured right now. */
export async function currentOptions(): Promise<CollectorOptions> {
  return {
    snmpTimeoutMs: await getNumberSetting("monitor.snmpTimeoutMs", 2000),
    snmpRetries: await getNumberSetting("monitor.snmpRetries", 1),
    mode: ((await getSetting("collector.mode", "real")) as CollectorOptions["mode"]) ?? "real",
  };
}

/** Run one cycle according to the current mode. */
export async function runOnce(): Promise<void> {
  const options = await currentOptions();

  if (options.mode === "off") {
    return;
  }

  if (options.mode === "simulated") {
    await simulateCycle();
    return;
  }

  await runCollectorCycle(options);
}

/**
 * Start the collector loop. Returns a function that stops it.
 *
 * `keepAlive` decides whether the loop alone keeps the Node process alive.
 * The standalone entry point needs it (otherwise the process exits as soon as
 * the first cycle finishes, because an unref'd timer does not hold the event
 * loop open). The in-process collector does not: the HTTP server is already
 * holding the loop open, and an unref'd timer lets the server shut down.
 */
export function startCollectorLoop(
  intervalMs = 30_000,
  options: { keepAlive?: boolean } = {}
): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[collector] cycle failed: ${message}`);
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  if (!options.keepAlive) timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** The entry point used by `npm run collector`. */
async function main(): Promise<void> {
  const refusal = acquireLock();
  if (refusal) {
    console.error(`[collector] ${refusal}`);
    process.exitCode = 1;
    return;
  }

  const options = await currentOptions();
  console.log("[collector] Mineazy Network collector starting.");
  console.log(`[collector] mode = ${options.mode}`);
  if (options.mode === "simulated") {
    console.log("[collector] SIMULATED MODE — the data on screen is generated, not measured.");
    await seedSimulatedTopology();
  }

  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: "Collector started",
    detail: `The collector started in "${options.mode}" mode.`,
    subjectType: "system",
    subjectId: null,
    source: "collector",
  });

  const stop = startCollectorLoop(30_000, { keepAlive: true });

  const shutdown = (): void => {
    console.log("[collector] stopping.");
    stop();
    releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("collector/main.ts");
if (isDirectRun) {
  void main();
}
