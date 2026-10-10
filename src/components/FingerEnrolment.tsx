"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelative, initials } from "@/lib/format";
import type {
  EmployeeProfileResponse,
  FingersSaveResponse,
  TerminalDto,
  TerminalsResponse,
} from "@/lib/types";
import { IconFingerprint } from "./icons";

/**
 * Fingerprint Enrolment — five-finger hand map + device console.
 *
 * Left: a schematic right hand (back view). Each finger is clickable and
 * lights up neon once its template is stored; the purple glow marks the
 * finger currently under the sensor. Right: an enrolment console bound to a
 * registered terminal — pick the machine, press CAPTURE, and the console
 * walks the ADMS handshake ("place finger → ridges → template → store")
 * before POSTing the new finger set to /api/employees/[id]/fingers.
 *
 * Saving keeps Fingerprint_Enrolled in sync server-side, so the directory's
 * ✓ n/5 cell and the dashboard's "ready to clock" logic update immediately.
 */

/* ------------------------------------------------------------------ */
/* Finger model + hand geometry                                        */
/* ------------------------------------------------------------------ */

interface FingerDef {
  index: number;
  label: string;
  full: string;
}

const FINGERS: FingerDef[] = [
  { index: 0, label: "Thumb", full: "Thumb" },
  { index: 1, label: "Index", full: "Index finger" },
  { index: 2, label: "Middle", full: "Middle finger" },
  { index: 3, label: "Ring", full: "Ring finger" },
  { index: 4, label: "Little", full: "Little finger" },
];

interface FingerGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees + pivot for the thumb capsule. */
  rotate?: number;
  pivot?: [number, number];
}

/** Capsule coordinates for a schematic back-of-right-hand (viewBox 260×300). */
const GEOM: Record<number, FingerGeom> = {
  0: { x: 36, y: 128, w: 32, h: 96, rotate: -30, pivot: [52, 224] },
  1: { x: 76, y: 58, w: 32, h: 112 },
  2: { x: 114, y: 40, w: 32, h: 130 },
  3: { x: 152, y: 54, w: 32, h: 116 },
  4: { x: 188, y: 86, w: 28, h: 88 },
};

const PALM = { x: 58, y: 152, w: 160, h: 124, rx: 42 };

const NEON = "#00e676";
const PURPLE = "#a855f7";
const MUTED_STROKE = "rgba(160,174,192,0.55)";

/** Deterministic capture quality per employee/finger (90‥99). */
function qualityFor(employeeId: number, finger: number): number {
  return 90 + ((employeeId * 7 + finger * 13) % 10);
}

/** Union helper — the API wants the full desired set, not a delta. */
function withFinger(fingers: number[], finger: number, present: boolean): number[] {
  const set = new Set(fingers);
  if (present) set.add(finger);
  else set.delete(finger);
  return [...set].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* Console log                                                         */
/* ------------------------------------------------------------------ */

type LogKind = "sys" | "cmd" | "ok" | "warn" | "err";

interface LogLine {
  id: number;
  time: string;
  kind: LogKind;
  text: string;
}

const LOG_TONE: Record<LogKind, string> = {
  sys: "text-muted",
  cmd: "text-[#b794f4]",
  ok: "text-neon",
  warn: "text-warn",
  err: "text-danger",
};

function clockNow(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function FingerEnrolment() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [data, setData] = useState<EmployeeProfileResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalDto[] | null>(null);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [fingers, setFingers] = useState<number[]>([]);
  const [selected, setSelected] = useState(2); // middle finger default
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);

  const logSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);
  const deadRef = useRef(false);
  const bootedRef = useRef(false);
  /**
   * Synchronous mirror of `fingers`/`busy`. Batch runs ("Enrol all missing")
   * call capture() several times inside one closure — reading React state
   * there would rebuild each POST from the set as it was when the click
   * happened, silently dropping the fingers captured moments earlier.
   */
  const fingersRef = useRef<number[]>([]);
  const busyRef = useRef(false);

  const applyFingers = useCallback((next: number[]) => {
    fingersRef.current = next;
    setFingers(next);
  }, []);

  const setBusyBoth = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  /* ── Data loading ─────────────────────────────────────────────── */
  useEffect(() => {
    deadRef.current = false;
    let cancelled = false;
    (async () => {
      try {
        const [profileRes, terminalsRes] = await Promise.all([
          fetch(`/api/employees/${id}`, { cache: "no-store" }),
          fetch("/api/terminals", { cache: "no-store" }),
        ]);
        if (!profileRes.ok) {
          const j = (await profileRes.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error || `HTTP ${profileRes.status}`);
        }
        const profile = (await profileRes.json()) as EmployeeProfileResponse;
        const terms = terminalsRes.ok
          ? ((await terminalsRes.json()) as TerminalsResponse).terminals ?? []
          : [];
        if (cancelled) return;
        setData(profile);
        applyFingers(profile.employee.fingers);
        setTerminals(terms);
        // Default console = first Online terminal (else first registered).
        const preferred =
          terms.find((t) => t.status === "Online")?.id ?? terms[0]?.id ?? null;
        setDeviceId(preferred);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      deadRef.current = true;
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current = [];
    };
  }, [id, applyFingers]);

  const pushLog = useCallback((kind: LogKind, text: string) => {
    setLog((prev) => {
      const line: LogLine = { id: ++logSeq.current, time: clockNow(), kind, text };
      const next = [...prev, line];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  const sleep = useCallback((ms: number) => {
    return new Promise<void>((resolve) => {
      const t = window.setTimeout(() => {
        timersRef.current = timersRef.current.filter((x) => x !== t);
        resolve();
      }, ms);
      timersRef.current.push(t);
    });
  }, []);

  /* ── Console boot banner (once) ───────────────────────────────── */
  useEffect(() => {
    if (!data || bootedRef.current) return;
    bootedRef.current = true;
    const e = data.employee;
    pushLog("sys", "BIOBRIDGE enrolment console v1.0 — ready");
    pushLog("sys", "protocol: ADMS HTTP push · endpoint /api/biometrics/push");
    pushLog(
      "sys",
      `${e.fullName} (${e.erpUserId}) — ${e.fingers.length}/5 fingers already captured`
    );
  }, [data, pushLog]);

  /* ── Device link banner ───────────────────────────────────────── */
  useEffect(() => {
    if (!terminals || deviceId === null) return;
    const device = terminals.find((t) => t.id === deviceId);
    if (!device) return;
    if (device.status === "Online") {
      pushLog("ok", `console linked: ${device.mac} @ ${device.ip} — ${device.location}`);
    } else {
      pushLog(
        "warn",
        `console OFFLINE: ${device.mac} @ ${device.ip} — ${device.location} (capture disabled)`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- log once per selection
  }, [deviceId, terminals]);

  /* ── Auto-scroll the console ──────────────────────────────────── */
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const device = terminals?.find((t) => t.id === deviceId) ?? null;
  const online = device?.status === "Online";
  const enrolledNow = fingers.includes(selected);
  const missing = FINGERS.map((f) => f.index).filter((i) => !fingers.includes(i));

  /* ── Save the full set through the API ────────────────────────── */
  const persist = useCallback(
    async (next: number[]): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(`/api/employees/${id}/fingers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fingers: next }),
        });
        const json = (await res.json().catch(() => null)) as
          | (FingersSaveResponse & { error?: string })
          | null;
        if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        applyFingers(json.fingers);
        return true;
      } catch (err) {
        pushLog("err", `✗ store failed — ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [id, pushLog, applyFingers]
  );

  /* ── Device capture sequence ──────────────────────────────────── */
  const capture = useCallback(
    async (finger: number): Promise<boolean> => {
      if (!device || !online || busyRef.current) return false;
      const def = FINGERS[finger];
      const e = data?.employee;
      setBusyBoth(true);
      try {
        pushLog("cmd", `→ TARGET FINGER #${finger + 1} — ${def.full.toUpperCase()}`);
        await sleep(350);
        if (deadRef.current) return false;
        pushLog("sys", "place finger on the sensor…");
        await sleep(650);
        if (deadRef.current) return false;
        pushLog("sys", "contact detected · pressure OK — capturing ridges (32 frames)");
        await sleep(800);
        if (deadRef.current) return false;
        const q = qualityFor(e?.id ?? 1, finger);
        pushLog("ok", `template captured — quality ${q}%`);
        await sleep(350);
        if (deadRef.current) return false;
        pushLog("cmd", `→ POST /api/employees/${id}/fingers {finger:${finger}}`);
        // fingersRef (not state) — batch runs would otherwise rebuild each
        // POST from the set as it looked when the button was clicked.
        const next = withFinger(fingersRef.current, finger, true);
        const ok = await persist(next);
        if (ok) {
          pushLog("ok", `✓ ${def.label} enrolled — ${next.length}/5 on record`);
        }
        return ok;
      } finally {
        if (!deadRef.current) setBusyBoth(false);
      }
    },
    [device, online, data, id, sleep, pushLog, persist, setBusyBoth]
  );

  const onCapture = useCallback(async () => {
    await capture(selected);
  }, [capture, selected]);

  const onCaptureMissing = useCallback(async () => {
    for (const f of missing) {
      setSelected(f);
      // Sequential device sessions — one capture fully settles before the next.
      const ok = await capture(f);
      if (!ok) break;
    }
  }, [capture, missing]);

  const onClear = useCallback(async () => {
    if (busyRef.current || !enrolledNow) return;
    const def = FINGERS[selected];
    setBusyBoth(true);
    try {
      pushLog("cmd", `→ CLEAR template — finger #${selected + 1} ${def.label}`);
      const next = withFinger(fingersRef.current, selected, false);
      const ok = await persist(next);
      if (ok) pushLog("warn", `template removed — ${next.length}/5 on record`);
    } finally {
      if (!deadRef.current) setBusyBoth(false);
    }
  }, [enrolledNow, selected, pushLog, persist, setBusyBoth]);

  /* ── Loading / error states ───────────────────────────────────── */
  if (loadError && !data) {
    return (
      <div className="glass rise space-y-4 p-8 text-center">
        <p className="text-sm text-danger">✕ {loadError}</p>
        <Link href="/employees" className="btn btn--ghost mx-auto">
          ← Back to employees
        </Link>
      </div>
    );
  }
  if (!data || terminals === null) return <EnrolmentSkeleton />;

  const e = data.employee;

  return (
    <div className="space-y-6">
      {/* ── Breadcrumb ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/employees"
            className="text-[11px] font-bold tracking-[0.16em] text-neon uppercase transition hover:text-white"
          >
            ← Employees
          </Link>
          <Link
            href={`/employees/${id}`}
            className="text-[11px] font-bold tracking-[0.16em] text-muted uppercase transition hover:text-white"
          >
            ← Timesheet
          </Link>
        </div>
        <span className="chip chip--muted">FINGERPRINT ENROLMENT</span>
      </div>

      {/* ── Employee header ────────────────────────────────────────── */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <div className="flex flex-col gap-5 px-5 py-6 sm:flex-row sm:items-center sm:px-6">
          <span className="grid h-14 w-14 flex-none place-items-center rounded-2xl border border-neon/50 bg-panel-deep text-lg font-bold text-neon shadow-[0_0_24px_rgba(0,230,118,0.22)]">
            {initials(e.fullName)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-ink">{e.fullName}</h1>
              <span className="chip chip--muted">{e.erpUserId}</span>
              <span className="chip chip--muted">{e.department || "Unassigned"}</span>
              <span className={`chip ${fingers.length > 0 ? "chip--neon" : "chip--warn"}`}>
                {fingers.length > 0 ? `${fingers.length}/5 enrolled` : "Not enrolled"}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-muted">
              Capture all five fingerprints on the connected console — templates save
              straight to the employee record.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:flex-none">
            <span className="glass-inset rounded-xl px-4 py-2.5 text-center">
              <span className="block font-mono text-xl font-bold text-neon tabular-nums">
                {fingers.length}/5
              </span>
              <span className="block text-[10px] font-bold tracking-[0.16em] text-muted uppercase">
                Enrolled
              </span>
            </span>
            <span className="glass-inset rounded-xl px-4 py-2.5 text-center">
              <span className="block font-mono text-xl font-bold text-ink tabular-nums">
                {5 - fingers.length}
              </span>
              <span className="block text-[10px] font-bold tracking-[0.16em] text-muted uppercase">
                Remaining
              </span>
            </span>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Hand map ──────────────────────────────────────────────── */}
        <section className="glass relative overflow-hidden">
          <div className="accent-line" aria-hidden="true" />
          <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
            <h2 className="flex items-center gap-2 text-xs font-bold tracking-[0.24em] text-ink uppercase">
              <IconFingerprint className="h-4 w-4 text-neon" />
              Hand Map · Right Hand
            </h2>
            <span className="font-mono text-[10px] tracking-wider text-muted">
              TAP A FINGER TO TARGET IT
            </span>
          </header>

          <div className="px-5 py-5">
            <svg
              viewBox="0 0 260 300"
              className="mx-auto block h-auto w-full max-w-[300px]"
              aria-label={`Hand map — ${fingers.length} of 5 fingers enrolled`}
            >
              {/* Palm */}
              <rect
                x={PALM.x}
                y={PALM.y}
                width={PALM.w}
                height={PALM.h}
                rx={PALM.rx}
                fill="rgba(45,27,78,0.55)"
                stroke="rgba(160,174,192,0.35)"
                strokeWidth={1.5}
              />

              {FINGERS.map((f) => {
                const g = GEOM[f.index];
                const enrolled = fingers.includes(f.index);
                const isSelected = selected === f.index;
                const cx = g.x + g.w / 2;
                const stroke = isSelected
                  ? PURPLE
                  : enrolled
                    ? NEON
                    : MUTED_STROKE;
                return (
                  <g
                    key={f.index}
                    transform={
                      g.rotate && g.pivot
                        ? `rotate(${g.rotate} ${g.pivot[0]} ${g.pivot[1]})`
                        : undefined
                    }
                    className="cursor-pointer"
                    style={{
                      filter: isSelected
                        ? "drop-shadow(0 0 7px rgba(168,85,247,0.85))"
                        : enrolled
                          ? "drop-shadow(0 0 4px rgba(0,230,118,0.35))"
                          : undefined,
                    }}
                    onClick={() => setSelected(f.index)}
                  >
                    <title>{`${f.full} — ${enrolled ? "enrolled" : "empty"}`}</title>
                    <rect
                      x={g.x}
                      y={g.y}
                      width={g.w}
                      height={g.h}
                      rx={g.w / 2}
                      fill={enrolled ? "rgba(0,230,118,0.13)" : "rgba(255,255,255,0.04)"}
                      stroke={stroke}
                      strokeWidth={isSelected ? 2.5 : enrolled ? 2 : 1.5}
                      strokeDasharray={enrolled ? undefined : "6 5"}
                      className={busy && isSelected ? "animate-pulse" : undefined}
                    />
                    {enrolled ? (
                      /* Fingerprint ridges at the tip */
                      <g fill="none" stroke={NEON} strokeWidth={1.4} opacity={0.9}>
                        <path
                          d={`M ${cx - 10} ${g.y + 32} A 10 10 0 0 1 ${cx + 10} ${g.y + 32}`}
                        />
                        <path
                          d={`M ${cx - 5.5} ${g.y + 34} A 5.5 5.5 0 0 1 ${cx + 5.5} ${g.y + 34}`}
                        />
                      </g>
                    ) : null}
                  </g>
                );
              })}
            </svg>

            {/* Finger chips */}
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {FINGERS.map((f) => {
                const enrolled = fingers.includes(f.index);
                const isSelected = selected === f.index;
                return (
                  <button
                    key={f.index}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setSelected(f.index)}
                    className={`rounded-lg border px-1.5 py-2 text-center text-[10px] font-bold tracking-[0.1em] uppercase transition ${
                      isSelected
                        ? "border-[#a855f7] bg-[#a855f7]/15 text-ink"
                        : enrolled
                          ? "border-neon/40 bg-neon/10 text-neon"
                          : "border-white/10 bg-white/[0.04] text-muted hover:border-white/25"
                    }`}
                  >
                    <span className="block">{f.label}</span>
                    <span className="mt-0.5 block text-[9px] font-normal tracking-normal opacity-80">
                      {enrolled ? "✓ captured" : "· empty"}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
              <span className="text-xs text-muted">
                Target:{" "}
                <span className="font-semibold text-ink">
                  {FINGERS[selected].full}
                </span>{" "}
                — {enrolledNow ? "template on record" : "no template yet"}
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-neon" aria-hidden="true" />
                <span className="font-mono text-[11px] text-neon">
                  {fingers.length}/5 ENROLLED
                </span>
              </span>
            </div>
          </div>
        </section>

        {/* ── Enrolment console ─────────────────────────────────────── */}
        <section className="glass relative overflow-hidden">
          <div className="accent-line" aria-hidden="true" />
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] px-5 py-4">
            <h2 className="flex items-center gap-2 text-xs font-bold tracking-[0.24em] text-ink uppercase">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  online ? "animate-pulse bg-neon" : "bg-warn"
                }`}
                aria-hidden="true"
              />
              Enrolment Console
            </h2>
            <span className="font-mono text-[10px] tracking-wider text-muted">
              {device ? (online ? "DEVICE ONLINE" : "DEVICE OFFLINE") : "NO DEVICE"}
            </span>
          </header>

          <div className="space-y-4 px-5 py-5">
            {/* Device picker */}
            <div>
              <label
                className="mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase"
                htmlFor="enrol-device"
              >
                Connected fingerprint machine
              </label>
              <select
                id="enrol-device"
                className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition focus:border-neon/50"
                value={deviceId ?? ""}
                onChange={(ev) => setDeviceId(Number(ev.target.value))}
              >
                {terminals.length === 0 ? <option value="">No devices</option> : null}
                {terminals.map((t) => (
                  <option key={t.id} value={t.id}>
                    {`${t.location} — ${t.branch || "No branch"}`}
                  </option>
                ))}
              </select>
              {device ? (
                <p className="mt-1.5 font-mono text-[10px] break-all text-muted">
                  {device.mac} · {device.ip} ·{" "}
                  <span className={online ? "text-neon" : "text-warn"}>
                    {device.status.toUpperCase()}
                  </span>{" "}
                  · last ping {device.lastPing ? formatRelative(device.lastPing) : "never"}
                </p>
              ) : (
                <p className="mt-1.5 text-[11px] text-warn">
                  No console connected —{" "}
                  <Link href="/clocking-devices" className="underline hover:text-ink">
                    register a device
                  </Link>
                  .
                </p>
              )}
            </div>

            {/* Console screen */}
            <div
              ref={logRef}
              className="scroll-thin h-64 overflow-y-auto rounded-xl border border-white/10 bg-black/60 p-3 font-mono text-[11px] leading-relaxed"
              role="log"
              aria-live="polite"
            >
              {log.map((l) => (
                <p key={l.id} className="whitespace-pre-wrap break-words">
                  <span className="text-muted/60">[{l.time}]</span>{" "}
                  <span className={LOG_TONE[l.kind]}>{l.text}</span>
                </p>
              ))}
              {busy || saving ? (
                <p className="text-neon">
                  <span className="animate-pulse">▊</span>
                </p>
              ) : null}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onCapture}
                className="btn btn--neon"
                disabled={busy || saving || !online}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                {enrolledNow ? "Re-capture finger" : "Capture on device"}
              </button>
              <button
                type="button"
                onClick={onCaptureMissing}
                className="btn btn--ghost"
                disabled={busy || saving || !online || missing.length === 0}
              >
                Enrol all missing
              </button>
              <button
                type="button"
                onClick={onClear}
                className="btn btn--ghost"
                disabled={busy || saving || !enrolledNow}
                style={{ color: "#ff5252" }}
              >
                Clear finger
              </button>
            </div>

            {!online && device ? (
              <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                The selected machine is offline — pick an Online device to capture.
              </p>
            ) : null}
            {fingers.length === 5 ? (
              <p className="rounded-xl border border-neon/40 bg-neon/10 px-3 py-2 text-xs text-neon">
                ✓ All five fingerprints enrolled — {e.erpUserId} is ready to clock.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading skeleton (also the Suspense fallback)                       */
/* ------------------------------------------------------------------ */

export function EnrolmentSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-4 w-40 animate-pulse rounded bg-white/10" />
      <div className="glass h-32 animate-pulse" />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="glass h-[480px] animate-pulse" />
        <div className="glass h-[480px] animate-pulse" />
      </div>
    </div>
  );
}
