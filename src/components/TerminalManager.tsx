"use client";

import { useEffect, useState } from "react";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { TerminalsResponse } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import MetricCard from "./MetricCard";
import { IconScan, IconServer } from "./icons";

/**
 * Terminal Manager — registry of every IP fingerprint/face/card device.
 * Polls /api/terminals every 3s so status dots and last-ping ages stay live.
 */
export default function TerminalManager() {
  const { data, loading, error } = usePoll<TerminalsResponse>("/api/terminals", 3000);
  const terminals = data?.terminals ?? [];
  const online = terminals.filter((t) => t.status === "Online").length;
  const offline = terminals.length - online;
  const scans = terminals.reduce((sum, t) => sum + t.scansToday, 0);

  const [origin, setOrigin] = useState("https://biobridge-attendance.vercel.app");
  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Page header -------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            Terminal Manager
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every enrolled biometric &amp; geofence device, its protocol identity and live
            connection state.
          </p>
        </div>
        <span className="chip chip--muted">Auto-refresh 3s</span>
      </div>

      {/* Summary ------------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label="Devices Online"
          value={`${online}/${terminals.length}`}
          sub="reporting within heartbeat window"
          icon={<IconServer />}
          tone={online === terminals.length && terminals.length > 0 ? "neon" : "warn"}
          loading={loading && !data}
        />
        <MetricCard
          label="Devices Offline"
          value={offline}
          sub={offline > 0 ? "no heartbeat received" : "fleet fully reachable"}
          icon={<IconServer />}
          tone={offline > 0 ? "danger" : "neon"}
          loading={loading && !data}
        />
        <MetricCard
          label="Scans Today"
          value={scans}
          sub="across all terminals"
          icon={<IconScan />}
          tone="neon"
          loading={loading && !data}
        />
      </div>

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Terminal registry unavailable — {error}. Retrying…
        </p>
      ) : null}

      {/* Device table ------------------------------------------------- */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Connected Devices
          </h2>
          <span className="font-mono text-[11px] tracking-wider text-muted">
            {terminals.length} REGISTERED
          </span>
        </header>

        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>Status</th>
                <th>Branch</th>
                <th>Location</th>
                <th>Protocol &amp; Mode</th>
                <th>Serial (SN) / MAC</th>
                <th>IP : Port</th>
                <th>Last Ping</th>
                <th className="text-right">Scans Today</th>
              </tr>
            </thead>
            <tbody>
              {loading && terminals.length === 0
                ? [0, 1, 2, 3, 4].map((i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={8} className="h-[57px] bg-white/[0.03]" />
                    </tr>
                  ))
                : terminals.map((t) => {
                    const isOn = t.status === "Online";
                    return (
                      <tr key={t.id} className="tbl-row transition-colors">
                        <td>
                          <span
                            className={`chip ${isOn ? "chip--neon" : "chip--danger"}`}
                          >
                            <span
                              className={`status-dot ${isOn ? "status-dot--on" : "status-dot--off"}`}
                            />
                            {t.status}
                          </span>
                        </td>
                        <td>
                          <span className="chip chip--muted border-neon/30! text-neon/90!">
                            {t.branch || "Unassigned"}
                          </span>
                        </td>
                        <td className="font-semibold text-ink">{t.location}</td>
                        <td className="font-mono text-xs text-neon">
                          {t.protocol || "ADMS"} · {t.directionMode || "Auto"}
                        </td>
                        <td className="font-mono text-muted">
                          {t.serialNumber || t.mac}
                        </td>
                        <td className="font-mono text-muted">
                          {t.ip ? `${t.ip}:${t.port || 4370}` : `Push :${t.port || 4370}`}
                        </td>
                        <td>
                          <span
                            className={`${isOn ? "text-ink" : "text-muted"} font-mono text-xs`}
                            title={t.lastPing ? new Date(t.lastPing).toString() : undefined}
                          >
                            {isOn ? formatRelative(t.lastPing) : "— offline —"}
                          </span>
                          {isOn && t.lastPing ? (
                            <span className="ml-2 hidden font-mono text-[10px] text-muted/70 xl:inline">
                              {formatDateTime(t.lastPing)}
                            </span>
                          ) : null}
                        </td>
                        <td className="text-right font-mono text-ink tabular-nums">
                          {t.scansToday}
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Hardware hookup cheat-sheet ---------------------------------- */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Universal Device Push Configuration (ADMS / ISAPI / Webhook)
          </h2>
        </header>
        <div className="grid gap-5 px-5 py-5 lg:grid-cols-2">
          <div>
            <p className="text-sm leading-relaxed text-muted">
              Point every terminal&apos;s <strong className="text-ink">HTTP Push / ADMS</strong>{" "}
              setting at the bridge. The device identifies itself with its{" "}
              <code className="font-mono text-neon">SN</code> (matched against
              Serial Number or Terminal MAC) and transmits ATTLOG frames — each punch lands in
              the attendance buffer as{" "}
              <span className="chip chip--warn mx-1">Pending</span> until the ERP
              sync engine delivers it.
            </p>
            <ul className="mt-4 space-y-2 text-xs text-muted">
              <li>
                <span className="text-ink">1. ZKTeco / eSSL ADMS:</span> Server URL →{" "}
                <code className="font-mono text-neon">{origin}/iclock/cdata</code>
              </li>
              <li>
                <span className="text-ink">2. Hikvision / Generic Push:</span> Endpoint →{" "}
                <code className="font-mono text-neon">{origin}/api/biometrics/push</code>
              </li>
              <li>
                <span className="text-ink">3. Auto-Discovery:</span> Any unregistered terminal
                pushing with a valid <code className="font-mono text-neon">SN</code> is automatically
                added to the device registry and marked Online.
              </li>
            </ul>
          </div>
          <div className="glass-inset scroll-thin overflow-x-auto p-4">
            <pre className="font-mono text-[11px] leading-relaxed text-muted">
              <code>
                <span className="text-neon">ZKTECO ADMS NATIVE PATH</span>
                {"\n"}{origin}/iclock/cdata?SN=&lt;device-serial&gt;&amp;table=ATTLOG
                {"\n\n"}
                <span className="text-neon">TAB-SEPARATED ATTLOG OR KEY=VALUE</span>
                {"\n"}1001{"\t"}2026-11-09 08:02:07{"\t"}0{"\t"}1{"\t"}0{"\t"}0
                {"\n"}ID=EMP1001&amp;Time=2026-11-09 08:02:07&amp;Status=0&amp;Verify=1
                {"\n\n"}
                <span className="text-neon">TEST WITH CURL</span>
                {"\n"}curl -X POST &quot;{origin}/iclock/cdata?SN=ZK-BELMONT-01&amp;table=ATTLOG&quot; \
                {"\n"}  -d &quot;1001{"\t"}2026-11-09 08:02:07{"\t"}0{"\t"}1&quot;
              </code>
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}
