/**
 * ============================================================================
 *  mock-generator.ts — simulated fingerprint terminals + background services
 * ============================================================================
 *
 *  Keeps the dashboard alive the moment it renders:
 *
 *    1. SIMULATOR   — every few seconds a random *online* terminal records a
 *                     punch for a random enrolled employee, exactly as if the
 *                     physical device had called /api/biometrics/push.
 *                     Punches respect a minimum gap per person and stay on
 *                     the branch where the person started their day, so the
 *                     feed never shows someone badge twice in a row or
 *                     teleport across sites. Occasional unregistered IDs and
 *                     terminal drop-outs are injected so the UI's edge states
 *                     are visible too.
 *
 *    2. HEARTBEAT   — refreshes Last_Ping on all online terminals.
 *
 *    3. AUTO-SYNC   — background retry loop that drains the Pending buffer to
 *                     the ERP every 20 seconds.
 *
 *                     ── PRODUCTION NOTE ───────────────────────────────
 *                     In production this loop would be a cron job / queue
 *                     worker outside the web process. It lives here so the
 *                     demo is fully self-driving; disable the simulator with
 *                     SIMULATOR_ENABLED=false and schedule POST
 *                     /api/erp/sync externally if you prefer.
 *                     ─────────────────────────────────────────────────
 *
 *  Started once per server process from src/instrumentation.ts.
 */

import {
  allEmployees,
  allTerminalRows,
  getDb,
  getSyncOverview,
  insertPunch,
  pingOnlineTerminals,
  randomTerminal,
  setTerminalStatus,
  todayPunchesByEmployee,
} from "@/lib/db";
import { EmployeeRow } from "@/lib/types";
import { runErpSync } from "@/lib/erp";

type GlobalWithFlags = typeof globalThis & {
  __taMockStarted?: boolean;
  __taAutoSyncStarted?: boolean;
};

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

/* ------------------------------------------------------------------ */
/* 1. Terminal simulator                                               */
/* ------------------------------------------------------------------ */

async function startSimulator() {
  const minMs = Number(process.env.SIMULATOR_MIN_MS ?? 2_500);
  const maxMs = Number(process.env.SIMULATOR_MAX_MS ?? 5_500);

  const tick = async () => {
    try {
      // Never let the demo flatline: if everything dropped, bring one back.
      let terminal = await randomTerminal();
      if (!terminal) {
        const any = await allTerminalRows();
        if (any.length > 0) {
          await setTerminalStatus(any[0].Terminal_ID, "Online");
          terminal = any[0];
        }
      }

      await pingOnlineTerminals();

      if (terminal) {
        const enrolled = (await allEmployees()).filter((e): e is EmployeeRow => e.Fingerprint_Enrolled === 1);
        if (enrolled.length > 0) {
          const unknown = Math.random() < 0.06; // 6%: ID never enrolled here

          // Believability guards (the classic fake-data tells):
          //  • nobody badges twice within 4 minutes;
          //  • anyone who already punched today keeps the branch they
          //    started the day at instead of teleporting across sites.
          const MIN_GAP_MS = 4 * 60_000;
          const recent = await todayPunchesByEmployee();
          const eligible = enrolled.filter(
            (e) => Date.now() - (recent.get(e.Employee_ID)?.ts ?? 0) >= MIN_GAP_MS
          );
          const employee = unknown ? null : eligible.length > 0 ? pick(eligible) : null;

          if (unknown || employee) {
            const prior = employee ? recent.get(employee.Employee_ID) : undefined;
            const priorTerm =
              prior?.terminalId != null
                ? (await allTerminalRows()).find((t) => t.Terminal_ID === prior.terminalId)
                : undefined;
            const active = priorTerm ?? terminal;

            await insertPunch({
              // Unknown refs resolve to Employee_ID = NULL → "Unregistered ID"
              // in the live feed, mirroring how real hardware pushes stale IDs.
              employeeRef: unknown
                ? `GHOST-${randInt(1000, 9999)}`
                : employee!.ERP_User_ID,
              timestamp: Date.now(),
              terminalId: active.Terminal_ID,
              verifyResult: unknown ? "Denied" : "Verified",
              verifyMethod: unknown ? "Fingerprint" : Math.random() < 0.12 ? "Card" : "Fingerprint",
              rawPayload: `ID=${unknown ? "9999" : employee!.Employee_ID}&Time=${new Date()
                .toISOString()
                .slice(0, 19)
                .replace("T", " ")}&Status=0&Verify=1&IP=${active.IP_Address}`,
            });
          }
        }
      }

      // ~10% chance per tick: flap a terminal Offline/Online (keep ≥1 online).
      if (Math.random() < 0.1) {
        const rows = await allTerminalRows();
        const online = rows.filter((t) => t.Status === "Online");
        const offline = rows.filter((t) => t.Status === "Offline");
        if (offline.length > 0 && Math.random() < 0.55) {
          await setTerminalStatus(pick(offline).Terminal_ID, "Online");
        } else if (online.length > 1) {
          await setTerminalStatus(pick(online).Terminal_ID, "Offline");
        }
      }
    } catch (err) {
      console.error("[simulator] tick failed:", err);
    } finally {
      setTimeout(tick, randInt(minMs, maxMs));
    }
  };

  setTimeout(tick, randInt(800, 1_600));
  console.log(`[simulator] armed — a punch every ${minMs}–${maxMs}ms`);
}

/* ------------------------------------------------------------------ */
/* 2. Background ERP retry loop                                         */
/* ------------------------------------------------------------------ */

async function startAutoSync() {
  const INTERVAL_MS = 20_000;
  const g = globalThis as GlobalWithFlags;

  const tick = async () => {
    try {
      // Cheap pre-check: don't spin up a batch when the buffer is empty.
      if ((await getSyncOverview()).stats.pendingLogs > 0) {
        await runErpSync("Auto");
      }
    } catch (err) {
      console.error("[auto-sync] iteration failed:", err);
    } finally {
      if (!g.__taAutoSyncStarted) return; // stopped
      setTimeout(() => void tick(), INTERVAL_MS);
    }
  };

  g.__taAutoSyncStarted = true;
  setTimeout(() => void tick(), INTERVAL_MS);
  console.log(`[auto-sync] retry loop armed — every ${INTERVAL_MS / 1000}s`);
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

/**
 * Idempotent bootstrap called from instrumentation.register().
 * Safe to invoke multiple times (dev HMR, multiple module graphs, …).
 */
export async function startMockServices(): Promise<void> {
  const g = globalThis as GlobalWithFlags;
  if (g.__taMockStarted) return;

  // Initialise schema + seed data up-front so the first dashboard request
  // never races an empty database.
  await getDb();

  const enabled = (process.env.SIMULATOR_ENABLED ?? "true").toLowerCase() !== "false";
  if (enabled) {
    startSimulator();
  } else {
    console.log("[simulator] disabled via SIMULATOR_ENABLED=false");
  }

  startAutoSync();
  g.__taMockStarted = true;
}
