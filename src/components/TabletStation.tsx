"use client";

/**
 * ============================================================================
 *  TabletStation.tsx — Shared Work Tablet Attendance Terminal
 * ============================================================================
 *
 *  A touch-optimised, high-speed attendance terminal designed for:
 *    • Work tablets mounted at site entrances / exits / reception.
 *    • Rapid queue processing: Enter Employee ID -> One-Tap CLOCK IN or CLOCK OUT.
 *    • Direct, single-screen execution with zero intermediate screen flickering.
 *    • Clear visual & acoustic confirmation, auto-resetting for the next person.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  IconCheck,
  IconClock,
  IconScan,
  IconUsers,
} from "./icons";

interface ClockResponse {
  ok: boolean;
  punch?: {
    employeeName: string;
    timestamp: number;
    direction: "IN" | "OUT";
    branch: string;
    clockTime: string;
  };
  message?: string;
  error?: string;
}

/** Pleasant dual-tone acoustic chime confirming a recorded punch */
function playPunchChime(direction: "IN" | "OUT") {
  if (typeof window === "undefined") return;
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    if (direction === "IN") {
      // Pleasant rising chime: D5 (587.33Hz) -> A5 (880Hz)
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
    } else {
      // Pleasant descending chime: A5 (880Hz) -> F#5 (739.99Hz)
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(739.99, now + 0.12);
    }

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.3);
  } catch {
    // Audio Context policy requires user gesture or browser denied audio
  }
}

export default function TabletStation() {
  const { account, can } = useAuth();

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    window.location.href = "/login?switch=1";
  };

  const [now, setNow] = useState<Date | null>(null);
  const [empInput, setEmpInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Confirmed punch state (when active, displays the punch confirmation screen)
  const [confirmedPunch, setConfirmedPunch] = useState<ClockResponse["punch"] | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  // Live ticking clock
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Listen for fullscreen change
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Reset back to standby for next employee
  const resetKiosk = useCallback(() => {
    busyRef.current = false;
    setConfirmedPunch(null);
    setEmpInput("");
    setError(null);
    setBusy(false);
  }, []);

  // Autofocus input when in standby state
  useEffect(() => {
    if (!confirmedPunch) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [confirmedPunch]);

  // Snappy 3-second countdown on confirmed punch
  useEffect(() => {
    if (!confirmedPunch) return;
    setCountdown(3);
    const interval = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [confirmedPunch]);

  // Auto-reset when countdown hits 0
  useEffect(() => {
    if (confirmedPunch && countdown === 0) {
      resetKiosk();
    }
  }, [confirmedPunch, countdown, resetKiosk]);

  // Record Attendance Punch directly (CLOCK IN or CLOCK OUT)
  const handleClock = async (direction?: "IN" | "OUT") => {
    const refToUse = empInput.trim();
    if (!refToUse || busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/tablet/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeRef: refToUse,
          direction: direction, // "IN", "OUT", or undefined for auto
        }),
      });
      const data = (await res.json()) as ClockResponse;

      if (!res.ok || !data.ok || !data.punch) {
        setError(data.error ?? "Failed to commit clock record.");
        busyRef.current = false;
        setBusy(false);
        return;
      }

      // Success feedback: acoustic chime & vibration
      playPunchChime(data.punch.direction);
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate([100, 50, 100]);
        } catch {}
      }

      setConfirmedPunch(data.punch);
    } catch {
      setError("Bridge offline or unreachable. Check tablet connection.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // On-screen touch keypad press
  const handleKeypadPress = (val: string) => {
    if (busy) return;
    if (val === "CLEAR") {
      setEmpInput("");
      setError(null);
    } else if (val === "BACK") {
      setEmpInput((prev) => prev.slice(0, -1));
    } else if (val === "EMP") {
      if (!empInput.toUpperCase().startsWith("EMP")) {
        setEmpInput(`EMP${empInput}`);
      }
    } else if (val === "ENTER") {
      void handleClock();
    } else {
      setEmpInput((prev) => `${prev}${val}`.toUpperCase());
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const stationBranch = account?.branchName || "Main Office";
  const timeFormatted = now
    ? now.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "--:--:--";
  const dateFormatted = now
    ? now.toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "Live Attendance Station";

  return (
    <div className="relative min-h-[82vh] w-full rounded-2xl border border-white/10 bg-void/80 p-4 shadow-2xl backdrop-blur-2xl sm:p-7 md:p-9">
      {/* ── Top Station Status Bar ─────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div className="flex items-center gap-3.5">
          <span className="grid h-12 w-12 place-items-center rounded-xl border border-neon/40 bg-neon/10 text-neon shadow-[0_0_16px_rgba(0,230,118,0.25)]">
            <IconScan className="h-6 w-6" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-extrabold tracking-[0.22em] text-ink uppercase sm:text-base">
                BIOBRIDGE · WORK TABLET STATION
              </h1>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-neon/50 bg-neon/15 px-2.5 py-0.5 text-[10px] font-bold text-neon shadow-[0_0_10px_rgba(0,230,118,0.3)]">
                <span className="h-1.5 w-1.5 rounded-full animate-pulse bg-neon" />
                ONLINE
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Station Site: <span className="font-semibold text-ink">{stationBranch}</span> · Logged in as{" "}
              <span className="text-muted/80">{account?.name ?? "Work Tablet"}</span>
            </p>
          </div>
        </div>

        {/* Live Digital Clock, Navigation & Fullscreen Toggle */}
        <div className="flex flex-wrap items-center gap-3">
          {can("can_view_dashboard") ? (
            <a
              href="/"
              className="rounded-xl border border-neon/40 bg-neon/10 px-3 py-1.5 text-xs font-bold tracking-wider text-neon uppercase transition hover:bg-neon/20"
            >
              ← Admin
            </a>
          ) : null}

          <button
            type="button"
            onClick={handleLogout}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-muted transition hover:border-danger/40 hover:text-danger"
            title="Sign out or switch to Admin account"
          >
            Sign Out
          </button>

          <div className="text-right">
            <div className="font-mono text-2xl font-black tracking-wider text-neon sm:text-3xl">
              {timeFormatted}
            </div>
            <div className="text-[11px] font-medium tracking-wide text-muted uppercase">
              {dateFormatted}
            </div>
          </div>

          <button
            type="button"
            onClick={toggleFullscreen}
            className="hidden rounded-xl border border-white/10 bg-white/[0.04] p-2.5 text-muted transition hover:border-white/20 hover:bg-white/[0.08] hover:text-ink sm:block"
            title={isFullscreen ? "Exit Fullscreen" : "Enter Kiosk Fullscreen"}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              {isFullscreen ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M9 9L4 4m0 0l5 0m-5 0l0 5m11 0l5-5m0 0l-5 0m5 0l0 5M9 15l-5 5m0 0l5 0m-5 0l0-5m11 0l5 5m0 0l-5 0m5 0l0-5"
                />
              ) : (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                />
              )}
            </svg>
          </button>
        </div>
      </header>

      {/* ── Main Station Content Area ─────────────────────────────────────── */}
      <div className="mt-8 flex flex-col items-center justify-center">
        {/* ================================================================= */}
        {/* STANDBY / INPUT VIEW: ENTER ID & TAP CLOCK IN / CLOCK OUT        */}
        {/* ================================================================= */}
        {!confirmedPunch && (
          <div className="w-full max-w-lg animate-in fade-in duration-150">
            <div className="text-center">
              <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-neon/40 bg-neon/10 text-neon shadow-[0_0_16px_rgba(0,230,118,0.2)]">
                <IconUsers className="h-7 w-7" />
              </span>
              <h2 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                Employee Attendance
              </h2>
              <p className="mt-1 text-sm text-muted">
                Enter your Employee ID and tap <span className="font-bold text-neon">CLOCK IN</span> or <span className="font-bold text-amber-400">CLOCK OUT</span>.
              </p>
            </div>

            {/* Input Box */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleClock();
              }}
              className="mt-6 space-y-4"
            >
              <div className="relative">
                <input
                  ref={inputRef}
                  type="text"
                  value={empInput}
                  onChange={(e) => {
                    setEmpInput(e.target.value.toUpperCase());
                    if (error) setError(null);
                  }}
                  placeholder="e.g. EMP1003 or 1003"
                  autoFocus
                  disabled={busy}
                  className="w-full rounded-2xl border-2 border-white/10 bg-panel-deep/90 px-5 py-4 text-center font-mono text-xl font-bold tracking-wider text-ink uppercase placeholder:text-muted/40 focus:border-neon focus:bg-white/[0.06] focus:outline-none focus:ring-4 focus:ring-neon/20 sm:text-2xl"
                />
              </div>

              {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-center text-xs font-semibold text-rose-300 animate-in fade-in">
                  {error}
                </div>
              )}

              {/* Direct Action Buttons: CLOCK IN & CLOCK OUT */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  disabled={busy || !empInput.trim()}
                  onClick={() => handleClock("IN")}
                  className="flex items-center justify-center gap-2 rounded-2xl border border-neon/50 bg-neon py-4 text-base font-black tracking-widest text-black uppercase shadow-[0_0_24px_rgba(0,230,118,0.3)] transition active:scale-[0.98] hover:bg-neon/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconClock className="h-5 w-5" />
                  <span>{busy ? "RECORDING…" : "CLOCK IN"}</span>
                </button>

                <button
                  type="button"
                  disabled={busy || !empInput.trim()}
                  onClick={() => handleClock("OUT")}
                  className="flex items-center justify-center gap-2 rounded-2xl border border-amber-400/50 bg-amber-400 py-4 text-base font-black tracking-widest text-black uppercase shadow-[0_0_24px_rgba(251,191,36,0.3)] transition active:scale-[0.98] hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconClock className="h-5 w-5" />
                  <span>{busy ? "RECORDING…" : "CLOCK OUT"}</span>
                </button>
              </div>
            </form>

            {/* On-Screen Touch Keypad */}
            <div className="mt-6">
              <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", "EMP", "0", "CLEAR"].map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleKeypadPress(key)}
                    className="flex h-14 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] font-mono text-lg font-bold text-ink transition active:scale-95 hover:border-white/25 hover:bg-white/[0.08]"
                  >
                    {key}
                  </button>
                ))}
              </div>
              <div className="mt-2.5 flex gap-2.5">
                <button
                  type="button"
                  onClick={() => handleKeypadPress("BACK")}
                  className="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.02] text-xs font-bold text-muted transition hover:bg-white/[0.06] hover:text-ink"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.5-6.5a2 2 0 011.4-.5H20a2 2 0 012 2v10a2 2 0 01-2 2h-9.1a2 2 0 01-1.4-.5L3 12z" />
                  </svg>
                  BACKSPACE
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* CONFIRMATION SCREEN: PUNCH RECORDED & AUTO-RESET                  */}
        {/* ================================================================= */}
        {confirmedPunch && (
          <div className="w-full max-w-lg text-center animate-in zoom-in-95 duration-150">
            <div className={`relative overflow-hidden rounded-3xl border p-8 shadow-2xl ${
              confirmedPunch.direction === "OUT"
                ? "border-amber-400/40 bg-gradient-to-b from-amber-500/10 via-panel-deep to-void shadow-[0_0_50px_rgba(251,191,36,0.2)]"
                : "border-neon/40 bg-gradient-to-b from-neon/10 via-panel-deep to-void shadow-[0_0_50px_rgba(0,230,118,0.2)]"
            }`}>
              <span className={`mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full border-2 ${
                confirmedPunch.direction === "OUT"
                  ? "border-amber-400 bg-amber-400/20 text-amber-300 shadow-[0_0_30px_rgba(251,191,36,0.5)]"
                  : "border-neon bg-neon/20 text-neon shadow-[0_0_30px_rgba(0,230,118,0.5)]"
              }`}>
                <IconCheck className="h-10 w-10 stroke-[2.5]" />
              </span>

              <h2 className="text-3xl font-black tracking-tight text-ink">
                Punch Recorded!
              </h2>

              <p className={`mt-2 text-base font-bold ${
                confirmedPunch.direction === "OUT" ? "text-amber-300" : "text-neon"
              }`}>
                {confirmedPunch.employeeName} clocked{" "}
                <span className="font-black underline">
                  {confirmedPunch.direction === "IN" ? "IN" : "OUT"}
                </span>{" "}
                at {confirmedPunch.clockTime}
              </p>

              <p className="mt-1 text-xs text-muted">
                Recorded at <span className="font-bold text-ink">{confirmedPunch.branch}</span> · Stored safely in system.
              </p>

              {/* Countdown timer badge & Next Person button */}
              <div className="mt-8 flex flex-col items-center justify-center gap-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-bold text-muted">
                  <span className={`h-2 w-2 rounded-full animate-ping ${
                    confirmedPunch.direction === "OUT" ? "bg-amber-400" : "bg-neon"
                  }`} />
                  Resetting for next person in{" "}
                  <span className={`font-mono text-sm font-bold ${
                    confirmedPunch.direction === "OUT" ? "text-amber-300" : "text-neon"
                  }`}>{countdown}s</span>
                </div>

                <button
                  type="button"
                  onClick={resetKiosk}
                  className={`w-full rounded-2xl py-3.5 text-xs font-black tracking-widest uppercase transition active:scale-[0.99] ${
                    confirmedPunch.direction === "OUT"
                      ? "bg-amber-400 text-black hover:bg-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.3)]"
                      : "btn btn--neon shadow-[0_0_20px_rgba(0,230,118,0.3)]"
                  }`}
                >
                  DONE / NEXT PERSON IN LINE →
                </button>
              </div>
            </div>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-muted/60">
          Work Tablet Attendance Station · Need administrative console?{" "}
          <button
            type="button"
            onClick={handleLogout}
            className="text-neon hover:underline cursor-pointer font-medium"
          >
            Sign In as Admin
          </button>
        </p>
      </div>
    </div>
  );
}
