"use client";

import { useEffect, useState } from "react";
import { IconCheck } from "@/components/icons";
import { formatClockTime } from "@/lib/format";
import type { EmployeeDirectoryResponse, PunchDirection } from "@/lib/types";

/**
 * Ready to Clock (Phase 11) — the admin's manual punch test widget.
 *
 * Simulates exactly what a fingerprint terminal would send: pick an
 * employee, choose a direction (or let the bridge infer the next punch
 * in today's sequence) and commit it through POST /api/attendance/punch.
 * The punch lands as Verified → Pending, so the next ERP sync picks it up
 * like any hardware event.
 */

type DirectionChoice = "AUTO" | PunchDirection;

interface PunchResult {
  employeeName: string;
  timestamp: number;
  direction: PunchDirection;
  terminalName: string | null;
}

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

export default function ReadyToClock() {
  const [employees, setEmployees] = useState<EmployeeDirectoryResponse["employees"]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [employeeRef, setEmployeeRef] = useState<string>("");
  const [direction, setDirection] = useState<DirectionChoice>("AUTO");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PunchResult | null>(null);

  // Roster loads once — the widget itself never polls.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/employees", { cache: "no-store" });
        const json = (await res.json()) as EmployeeDirectoryResponse & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setEmployees(json.employees);
        if (json.employees.length > 0) setEmployeeRef(json.employees[0].erpUserId);
      } catch (err) {
        if (!cancelled) setRosterError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function punch() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/attendance/punch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeRef: employeeRef || undefined,
          direction: direction === "AUTO" ? undefined : direction,
        }),
      });
      const json = (await res.json()) as
        | {
            ok: boolean;
            error?: string;
            punch?: {
              employeeName: string;
              timestamp: number;
              direction: PunchDirection;
              terminalName: string | null;
            };
          }
        | null;
      if (!res.ok || !json?.ok || !json.punch) throw new Error(json?.error || `HTTP ${res.status}`);
      setResult(json.punch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass relative flex flex-col overflow-hidden">
      <div className="accent-line" aria-hidden="true" />

      <header className="border-b border-white/[0.07] px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
              Ready to Clock
            </h2>
            <p className="mt-1 text-[11px] text-muted">
              Admin test widget — simulate a biometric punch
            </p>
          </div>
          <span className="chip chip--muted">Test</span>
        </div>
      </header>

      <div className="flex-1 space-y-4 px-5 py-5">
        {rosterError ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            Roster unavailable — {rosterError}
          </p>
        ) : null}

        <div>
          <label className={LABEL} htmlFor="rtc-employee">
            Employee
          </label>
          <select
            id="rtc-employee"
            className={INPUT}
            value={employeeRef}
            onChange={(e) => setEmployeeRef(e.target.value)}
            disabled={employees.length === 0}
          >
            {employees.length === 0 ? <option value="">Loading roster…</option> : null}
            {employees.map((e) => (
              <option key={e.id} value={e.erpUserId}>
                {e.fullName} · {e.erpUserId}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={LABEL} htmlFor="rtc-direction">
            Direction
          </label>
          <select
            id="rtc-direction"
            className={INPUT}
            value={direction}
            onChange={(e) => setDirection(e.target.value as DirectionChoice)}
          >
            <option value="AUTO">Auto — next punch in today&apos;s sequence</option>
            <option value="IN">Clock In (IN)</option>
            <option value="OUT">Clock Out (OUT)</option>
          </select>
        </div>

        {error ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}

        {result ? (
          <div className="rounded-xl border border-neon/40 bg-neon/10 px-3.5 py-3">
            <p className="flex items-center gap-2 text-xs font-bold text-neon">
              <IconCheck className="h-4 w-4" />
              {result.direction === "IN" ? "Clock In" : "Clock Out"} recorded
            </p>
            <p className="mt-1.5 text-xs text-ink">
              {result.employeeName} · {formatClockTime(new Date(result.timestamp))}
            </p>
            <p className="mt-0.5 text-[11px] text-muted">
              {result.terminalName ?? "No terminal"} · pending ERP sync
            </p>
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn--neon w-full"
          onClick={punch}
          disabled={busy || employees.length === 0}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "Punching…" : "Clock Now"}
        </button>

        <p className="text-[11px] leading-relaxed text-muted/80">
          Writes a verified punch through the same path as the hardware listener — it will appear
          in the live feed and queue for the next ERP push.
        </p>
      </div>
    </section>
  );
}
