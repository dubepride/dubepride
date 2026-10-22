/**
 * ============================================================================
 *  Setup — first-run checklist
 * ============================================================================
 *
 *  Tells the operator, without guessing, what still needs doing before the
 *  console is usable: database, admin account, demo vs production, collector
 *  state and where to go next. All facts come from the public `/api/health`
 *  endpoint — nothing sensitive is exposed.
 * ============================================================================
 */

"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";
import { useApi } from "@/components/useApi";
import { Chip, Notice, Panel } from "@/components/ui";

interface HealthPayload {
  databaseReady: boolean;
  adminAccountExists: boolean;
  demoMode: boolean;
  collectorMode: string;
}

export default function SetupPage() {
  const { data, error, loading, reload } = useApi<HealthPayload>("/api/health", { pollMs: 30_000 });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 px-4 py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="neon-box flex h-11 w-11 items-center justify-center rounded-xl bg-neon/15 text-neon">
            <Icon name="map" size={20} />
          </span>
          <div>
            <div className="text-sm font-extrabold tracking-[0.24em] text-white">MINEAZY</div>
            <div className="text-[0.62rem] font-semibold tracking-[0.34em] text-neon uppercase">
              Network · Setup Checklist
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/login" className="btn btn--ghost btn--sm">
            Sign in
          </Link>
          <button type="button" className="btn btn--ghost btn--sm" onClick={reload}>
            <Icon name="refresh" size={13} />
            Re-check
          </button>
        </div>
      </header>

      <Panel
        title="Installation readiness"
        subtitle="Facts only — no secrets, addresses or device counts are shown here."
      >
        {loading && !data ? (
          <p className="text-sm text-muted">Checking installation…</p>
        ) : error ? (
          <Notice tone="danger">{error}</Notice>
        ) : data ? (
          <ul className="space-y-2">
            <li className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5">
              <div>
                <div className="text-sm text-white">Database ready</div>
                <div className="text-xs text-muted">Schema migrated and bootstrap complete</div>
              </div>
              <Chip tone={data.databaseReady ? "neon" : "danger"}>
                {data.databaseReady ? "OK" : "NOT READY"}
              </Chip>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5">
              <div>
                <div className="text-sm text-white">Administrator account exists</div>
                <div className="text-xs text-muted">
                  {data.adminAccountExists
                    ? "There is at least one active administrator."
                    : "No administrator has been created yet."}
                </div>
              </div>
              <Chip tone={data.adminAccountExists ? "neon" : "warn"}>
                {data.adminAccountExists ? "OK" : "MISSING"}
              </Chip>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5">
              <div>
                <div className="text-sm text-white">Mode</div>
                <div className="text-xs text-muted">
                  {data.demoMode
                    ? "Labelled demo/simulator enabled. All discovered/polled topology will be marked as simulated."
                    : "Production mode. Real discovery/monitoring only — no demo data is seeded automatically."}
                </div>
              </div>
              <Chip tone={data.demoMode ? "purple" : "muted"}>
                {data.demoMode ? "DEMO (SIMULATED)" : "PRODUCTION"}
              </Chip>
            </li>
            <li className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5">
              <div>
                <div className="text-sm text-white">Collector mode</div>
                <div className="text-xs text-muted">
                  {data.collectorMode === "simulated"
                    ? "The collector will generate simulated observations."
                    : data.collectorMode === "off"
                      ? "The collector is disabled."
                      : "The collector will poll configured devices (SNMP / ICMP / TCP / HTTP)."}
                </div>
              </div>
              <Chip tone="muted">{data.collectorMode}</Chip>
            </li>
          </ul>
        ) : null}
      </Panel>

      <Panel title="Next steps">
        <ol className="space-y-3 text-sm leading-relaxed">
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[0.7rem] font-bold">
              1
            </span>
            <div>
              <div className="text-white">Sign in to the console</div>
              <div className="mt-0.5 text-xs text-muted">
                If this is the first boot and you did not set{" "}
                <code className="font-mono">MINEAZY_ADMIN_PASSWORD</code>, the generated
                one-time password was printed in the terminal where{" "}
                <code className="font-mono">npm run dev</code> started.{" "}
                <Link href="/login" className="text-neon hover:underline">
                  Go to sign in
                </Link>
                .
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[0.7rem] font-bold">
              2
            </span>
            <div>
              <div className="text-white">Configure monitoring</div>
              <div className="mt-0.5 text-xs text-muted">
                Open <Link href="/settings" className="text-neon hover:underline">Settings</Link> to
                choose internet/gateway targets, timeouts, retention and alerts. SNMP credentials
                are added under <strong>Settings → Credentials</strong> (or the Credentials area)
                and are stored encrypted — never shown in the browser.
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[0.7rem] font-bold">
              3
            </span>
            <div>
              <div className="text-white">Discover or seed</div>
              <div className="mt-0.5 text-xs text-muted">
                For a real network: add an <Link href="/discovery" className="text-neon hover:underline">authorised scan range</Link>{" "}
                and run a sweep (or use SNMP neighbours/FDB). For a demo: with{" "}
                <code className="font-mono">MINEAZY_DEMO=1</code>, use the Demo controls or{" "}
                <code className="font-mono">npm run demo:seed</code> to build the labelled
                simulated estate.
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[0.7rem] font-bold">
              4
            </span>
            <div>
              <div className="text-white">Read the docs</div>
              <div className="mt-0.5 text-xs text-muted">
                See <code className="font-mono">mineazy-network/README.md</code> and{" "}
                <code className="font-mono">mineazy-network/docs/</code> for install, SNMP setup,
                discovery, roles, backup/restore, troubleshooting and the implemented-vs-pending
                list.
              </div>
            </div>
          </li>
        </ol>
      </Panel>

      <p className="text-center text-xs text-muted">
        Mineazy Network is local-first. Monitoring runs independently of your browser session; close
        this tab and collection keeps going if the collector process is running.
      </p>
    </main>
  );
}
