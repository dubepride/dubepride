"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconUsers } from "@/components/icons";
import { formatClockTime } from "@/lib/format";
import type { EmployeeDirectoryEntry, EmployeeDirectoryResponse, PunchDirection } from "@/lib/types";

/**
 * Ready to Clock (Phase 11) — the admin's manual punch test widget, restyled
 * as a premium biometric clock-in terminal.
 *
 * The behaviour is unchanged: pick an employee, choose a direction (or let the
 * bridge infer the next punch in today's sequence) and commit it through
 * POST /api/attendance/punch. The punch lands as Verified → Pending, so the
 * next ERP sync picks it up like any hardware event.
 *
 * The animated fingerprint is purely a visual representation of the clocking
 * interaction — no real biometric is captured or verified here.
 */

type DirectionChoice = "AUTO" | PunchDirection;
type Phase = "idle" | "scanning" | "success" | "error";

interface PunchResult {
  employeeName: string;
  timestamp: number;
  direction: PunchDirection;
  terminalName: string | null;
}

/** How long the scanning state is held so the animation is actually perceptible. */
const MIN_SCAN_MS = 950;
const SUCCESS_HOLD_MS = 2800;
const ERROR_HOLD_MS = 4600;

const DIRECTION_OPTIONS: { value: DirectionChoice; label: string; hint: string }[] = [
  { value: "AUTO", label: "Auto", hint: "Next in sequence" },
  { value: "IN", label: "Clock In", hint: "Punch IN" },
  { value: "OUT", label: "Clock Out", hint: "Punch OUT" },
];

/** Detailed fingerprint glyph, drawn with individually animatable paths. */
function FingerprintGlyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
      <path pathLength={1} d="M9.5 30.5 C9.5 20 15.8 12.6 24 12.6 C32.2 12.6 38.5 20 38.5 30.5" />
      <path pathLength={1} d="M13.6 32.4 C13.6 23.6 18.3 17.5 24 17.5 C29.7 17.5 34.4 23.6 34.4 32.4" />
      <path pathLength={1} d="M17.5 34.2 C17.5 27.1 20.4 22.5 24 22.5 C27.6 22.5 30.5 27.1 30.5 34.2" />
      <path pathLength={1} d="M21.5 35 C21.5 30.2 22.6 27.4 24 27.4 C25.4 27.4 26.5 30.2 26.5 35" />
      <path pathLength={1} d="M24 27.4 L24 44" />
      <path pathLength={1} d="M13.6 32.4 C12.4 37.6 12.3 42.4 13 46" />
      <path pathLength={1} d="M34.4 32.4 C35.6 37.6 35.7 42.4 35 46" />
      <path pathLength={1} d="M9.5 30.5 C8 36.4 7.7 41.6 8.4 46" />
      <path pathLength={1} d="M38.5 30.5 C40 36.4 40.3 41.6 39.6 46" />
    </svg>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function ReadyToClock() {
  const [employees, setEmployees] = useState<EmployeeDirectoryEntry[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [employeeRef, setEmployeeRef] = useState<string>("");
  const [direction, setDirection] = useState<DirectionChoice>("AUTO");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PunchResult | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  const timers = useRef<number[]>([]);
  // Synchronous guard: blocks a second punch even before React re-renders the
  // disabled state (e.g. a fast double/triple click in the same tick).
  const inFlight = useRef(false);
  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

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

  const selected = employees.find((e) => e.erpUserId === employeeRef) ?? null;
  const ready = employees.length > 0 && !rosterError;

  async function punch() {
    if (inFlight.current || busy || !ready) return;

    inFlight.current = true;
    clearTimers();
    setBusy(true);
    setError(null);
    setResult(null);
    setPhase("scanning");

    const started = Date.now();
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
            punch?: PunchResult;
          }
        | null;
      if (!res.ok || !json?.ok || !json.punch) throw new Error(json?.error || `HTTP ${res.status}`);

      // Hold the scanning state for a readable minimum, then confirm success.
      // Success is only ever shown after the backend has replied.
      const wait = Math.max(0, MIN_SCAN_MS - (Date.now() - started));
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          timers.current.push(window.setTimeout(resolve, wait));
        });
      }

      setResult(json.punch);
      setPhase("success");
      timers.current.push(window.setTimeout(() => setPhase("idle"), SUCCESS_HOLD_MS));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
      timers.current.push(window.setTimeout(() => setPhase("idle"), ERROR_HOLD_MS));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const badge =
    phase === "scanning"
      ? { label: "PROCESSING", cls: "chip chip--muted", dot: "rtc-status-dot rtc-status-dot--scanning" }
      : phase === "success"
        ? { label: "RECORDED", cls: "chip chip--neon", dot: "rtc-status-dot" }
        : phase === "error"
          ? { label: "ACTION NEEDED", cls: "chip chip--danger", dot: "rtc-status-dot rtc-status-dot--error" }
          : { label: "SYSTEM READY", cls: "chip chip--neon", dot: "rtc-status-dot" };

  const successTitle =
    result?.direction === "IN" ? "CLOCK-IN SUCCESSFUL" : "CLOCK-OUT SUCCESSFUL";

  return (
    <section className="glass rtc-card relative flex flex-col overflow-hidden">
      <div className="accent-line" aria-hidden="true" />

      <header className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="rtc-beacon" aria-hidden="true" />
          <div>
            <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
              Biometric Attendance
            </h2>
            <p className="mt-1 text-[11px] text-muted">Secure employee clocking terminal</p>
          </div>
        </div>
        <span className={badge.cls}>
          <span className={badge.dot} aria-hidden="true" />
          {badge.label}
        </span>
      </header>

      <div className="flex-1 space-y-5 px-5 py-5">
        {rosterError ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            Roster unavailable — {rosterError}
          </p>
        ) : null}

        {/* Employee identity + selector ---------------------------------- */}
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
            <IconUsers className="h-3.5 w-3.5" />
            Employee
          </div>

          <div className="rtc-identity">
            <span className="rtc-avatar" aria-hidden="true">
              {selected ? initials(selected.fullName) : <IconUsers className="h-5 w-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">
                {selected ? selected.fullName : "No employee selected"}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                <span className="rtc-mono">{selected?.erpUserId ?? "—"}</span>
                {selected?.department ? <span className="rtc-sep">·</span> : null}
                {selected?.department ? <span className="truncate">{selected.department}</span> : null}
                {selected?.branch ? <span className="rtc-sep">·</span> : null}
                {selected?.branch ? <span className="truncate">{selected.branch}</span> : null}
              </p>
            </div>
            {selected ? (
              <span className={`chip ${selected.enrolled ? "chip--neon" : "chip--warn"}`}>
                {selected.enrolled ? "Enrolled" : "Not enrolled"}
              </span>
            ) : null}
          </div>

          <label className="sr-only" htmlFor="rtc-employee">
            Select employee
          </label>
          <select
            id="rtc-employee"
            className="rtc-select"
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

        {/* Biometric scanner -------------------------------------------- */}
        <div className="rtc-stage" data-phase={phase}>
          <span className="rtc-ring rtc-ring--1" aria-hidden="true" />
          <span className="rtc-ring rtc-ring--2" aria-hidden="true" />
          <span className="rtc-ring rtc-ring--3" aria-hidden="true" />
          {phase === "success" ? <span className="rtc-ripple-out" aria-hidden="true" /> : null}

          <button
            type="button"
            className="rtc-scanner"
            onClick={punch}
            disabled={busy || !ready}
            aria-label="Record attendance"
            aria-busy={phase === "scanning"}
          >
            <span className="rtc-halo" aria-hidden="true" />
            <span className="rtc-fp-wrap">
              <FingerprintGlyph className="rtc-fp" />
              <span className="rtc-scanline" aria-hidden="true" />
            </span>
            {phase === "success" ? <IconCheck className="rtc-check" /> : null}
          </button>
        </div>

        {/* Scanner caption ---------------------------------------------- */}
        <div className="space-y-1.5 text-center" role="status" aria-live="polite">
          {phase === "scanning" ? (
            <>
              <p className="rtc-caption rtc-caption--active">SCANNING…</p>
              <p className="text-[11px] text-muted">Reading your biometric sample</p>
              <div className="rtc-progress mx-auto mt-1.5" aria-hidden="true">
                <i />
              </div>
            </>
          ) : phase === "success" && result ? (
            <>
              <p className="rtc-caption rtc-caption--ok">{successTitle}</p>
              <p className="text-[11px] text-ink">
                {result.employeeName} · {formatClockTime(new Date(result.timestamp))}
              </p>
              <p className="text-[10px] text-muted">
                {result.terminalName ?? "No terminal"} · pending ERP sync
              </p>
            </>
          ) : phase === "error" ? (
            <>
              <p className="rtc-caption rtc-caption--error">CLOCKING FAILED</p>
              <p className="text-[11px] text-danger">{error ?? "Something went wrong."}</p>
            </>
          ) : (
            <>
              <p className="rtc-caption">PLACE FINGER TO CLOCK IN</p>
              <p className="text-[11px] text-muted">Tap the scanner to record your attendance</p>
              {result ? (
                <p className="pt-1 text-[10px] text-muted/80">
                  Last: {result.employeeName} · {result.direction === "IN" ? "In" : "Out"} ·{" "}
                  {formatClockTime(new Date(result.timestamp))}
                </p>
              ) : null}
            </>
          )}
        </div>

        {/* Direction control ------------------------------------------- */}
        <fieldset>
          <legend className="mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
            Punch direction
          </legend>
          <div className="rtc-seg" id="rtc-direction" role="radiogroup" aria-label="Punch direction">
            {DIRECTION_OPTIONS.map((opt) => (
              <label key={opt.value} className="rtc-seg-item">
                <input
                  type="radio"
                  className="rtc-seg-input"
                  id={`rtc-direction-${opt.value.toLowerCase()}`}
                  name="rtc-direction"
                  value={opt.value}
                  checked={direction === opt.value}
                  onChange={() => setDirection(opt.value)}
                />
                <span className="rtc-seg-label">
                  {opt.label}
                  <small>{opt.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {error && phase !== "error" ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="border-t border-white/[0.07] px-5 py-3.5">
        <p className="flex items-center gap-2 text-[10px] text-muted/80">
          <span className="rtc-status-dot" aria-hidden="true" />
          Terminal ready — admin test mode. Records a verified punch via the hardware listener path,
          not a real fingerprint scan.
        </p>
      </footer>
    </section>
  );
}
