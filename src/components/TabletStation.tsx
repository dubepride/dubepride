"use client";

/**
 * ============================================================================
 *  TabletStation.tsx — Shared Work Tablet / Phone Clocking Station
 * ============================================================================
 *
 *  A touch-optimised, kiosk-style attendance terminal designed for:
 *    1. Work tablets or stationary phones mounted at site entrances / reception / exits.
 *    2. Employees clocking in/out rapidly with minimal friction and zero screen flickering.
 *
 *  Features:
 *    • Station Modes:
 *        - AUTO (Smart Two-Way): Automatically resolves IN / OUT based on current status.
 *        - CLOCK IN ONLY (Entrance Tablet): Dedicated station for incoming workers.
 *        - CLOCK OUT ONLY (Exit Tablet): Dedicated station for departing workers.
 *      Persisted in localStorage per physical tablet.
 *    • Rock-Solid Lifecycle: Decoupled countdown timer eliminates ghost screen rebounding.
 *    • Instant Acoustic Feedback: Web Audio confirmation chime and haptics.
 *    • Debounce Shield: Prevents accidental touchscreen double-taps between phase transitions.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { formatClockTime, formatRelative } from "@/lib/format";
import {
  IconCheck,
  IconClock,
  IconScan,
  IconUsers,
} from "./icons";

export type TabletStationMode = "AUTO" | "IN" | "OUT";

interface EmployeeProfile {
  id: number;
  erpUserId: string;
  fullName: string;
  department: string;
  position: string;
  branch: string;
  shiftName: string;
  shiftHours: string;
  hasPin: boolean;
}

interface PunchStatus {
  clockedIn: boolean;
  lastPunchAt: number | null;
  lastDirection: "IN" | "OUT" | null;
  nextDirection: "IN" | "OUT";
}

interface LookupResponse {
  ok: boolean;
  employee?: EmployeeProfile;
  status?: PunchStatus;
  stationBranch?: string | null;
  serverTime?: number;
  error?: string;
}

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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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
      // Pleasant rising melody: D5 (587Hz) -> A5 (880Hz)
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
    } else {
      // Pleasant tone: A5 (880Hz) -> F#5 (739.99Hz)
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(739.99, now + 0.12);
    }

    gain.gain.setValueAtTime(0.18, now);
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
  const [stationMode, setStationMode] = useState<TabletStationMode>("AUTO");
  const [empInput, setEmpInput] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phases: 'idle' (enter ID) | 'profile' (confirm clocking) | 'confirmed' (success screen)
  const [phase, setPhase] = useState<"idle" | "profile" | "confirmed">("idle");
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [status, setStatus] = useState<PunchStatus | null>(null);
  const [confirmedPunch, setConfirmedPunch] = useState<ClockResponse["punch"] | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  // Restore saved station mode from localStorage on device
  useEffect(() => {
    try {
      const saved = localStorage.getItem("biobridge_tablet_station_mode") as TabletStationMode | null;
      if (saved === "AUTO" || saved === "IN" || saved === "OUT") {
        setStationMode(saved);
      }
    } catch {}
  }, []);

  const changeStationMode = (mode: TabletStationMode) => {
    setStationMode(mode);
    try {
      localStorage.setItem("biobridge_tablet_station_mode", mode);
    } catch {}
  };

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

  // Clean, atomic reset back to standby for next employee
  const resetKiosk = useCallback(() => {
    busyRef.current = false;
    setPhase("idle");
    setEmpInput("");
    setPinInput("");
    setProfile(null);
    setStatus(null);
    setConfirmedPunch(null);
    setError(null);
    setBusy(false);
  }, []);

  // Autofocus input when in idle state
  useEffect(() => {
    if (phase === "idle") {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  // Inactivity timeout (25s) when viewing profile card
  useEffect(() => {
    if (phase !== "profile") return;
    const timer = setTimeout(() => {
      resetKiosk();
    }, 25_000);
    return () => clearTimeout(timer);
  }, [phase, resetKiosk]);

  // Snappy 3-second countdown on confirmed punch (clean decoupled timer)
  useEffect(() => {
    if (phase !== "confirmed") return;
    setCountdown(3);
    const interval = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // Clean trigger when countdown reaches 0 — completely decoupled from state updater
  useEffect(() => {
    if (phase === "confirmed" && countdown === 0) {
      resetKiosk();
    }
  }, [phase, countdown, resetKiosk]);

  // Lookup employee by EMP Number
  const handleLookup = async (targetRef?: string) => {
    if (busyRef.current) return;
    const refToLookup = (targetRef ?? empInput).trim();
    if (!refToLookup) return;

    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/tablet/lookup?ref=${encodeURIComponent(refToLookup)}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as LookupResponse;

      if (!res.ok || !data.ok || !data.employee || !data.status) {
        setError(data.error ?? "Employee not found. Please check your ID.");
        busyRef.current = false;
        setBusy(false);
        return;
      }

      setProfile(data.employee);
      setStatus(data.status);
      setPhase("profile");
    } catch {
      setError("Bridge offline or unreachable. Check tablet connection.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Determine target direction based on station mode & employee status
  const resolveTargetDirection = (override?: "IN" | "OUT"): "IN" | "OUT" => {
    if (override) return override;
    if (stationMode === "IN") return "IN";
    if (stationMode === "OUT") return "OUT";
    return status?.clockedIn ? "OUT" : "IN";
  };

  // Record Attendance Punch
  const handleClock = async (overrideDirection?: "IN" | "OUT") => {
    if (!profile || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);

    const dirToUse = resolveTargetDirection(overrideDirection);

    try {
      const res = await fetch("/api/tablet/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeRef: profile.erpUserId,
          direction: dirToUse,
          pin: pinInput.trim() || undefined,
        }),
      });
      const data = (await res.json()) as ClockResponse;

      if (!res.ok || !data.ok || !data.punch) {
        setError(data.error ?? "Failed to commit clock record.");
        busyRef.current = false;
        setBusy(false);
        return;
      }

      // Success feedback: play acoustic chime & haptic pulse
      playPunchChime(data.punch.direction);
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate([100, 50, 100]);
        } catch {}
      }

      setConfirmedPunch(data.punch);
      setPhase("confirmed");
    } catch {
      setError("Failed to reach attendance bridge.");
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
    } else if (val === "BACK") {
      setEmpInput((prev) => prev.slice(0, -1));
    } else if (val === "EMP") {
      if (!empInput.toUpperCase().startsWith("EMP")) {
        setEmpInput(`EMP${empInput}`);
      }
    } else if (val === "ENTER") {
      void handleLookup();
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

  const targetDir = resolveTargetDirection();

  return (
    <div className="relative min-h-[82vh] w-full rounded-2xl border border-white/10 bg-void/80 p-4 shadow-2xl backdrop-blur-2xl sm:p-7 md:p-9">
      {/* ── Top Station Status Bar ─────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-5">
        <div className="flex items-center gap-3.5">
          <span className={`grid h-12 w-12 place-items-center rounded-xl border shadow-lg ${
            stationMode === "OUT"
              ? "border-amber-400/50 bg-amber-500/10 text-amber-400 shadow-[0_0_16px_rgba(251,191,36,0.25)]"
              : "border-neon/40 bg-neon/10 text-neon shadow-[0_0_16px_rgba(0,230,118,0.25)]"
          }`}>
            <IconScan className="h-6 w-6" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-extrabold tracking-[0.22em] text-ink uppercase sm:text-base">
                BIOBRIDGE · WORK TABLET STATION
              </h1>
              {/* Station Mode Badge */}
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                stationMode === "IN"
                  ? "border-neon/50 bg-neon/15 text-neon shadow-[0_0_10px_rgba(0,230,118,0.3)]"
                  : stationMode === "OUT"
                    ? "border-amber-400/50 bg-amber-500/15 text-amber-300 shadow-[0_0_10px_rgba(251,191,36,0.3)]"
                    : "border-white/20 bg-white/[0.06] text-ink"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${
                  stationMode === "OUT" ? "bg-amber-400" : "bg-neon"
                }`} />
                {stationMode === "IN"
                  ? "CLOCK IN ONLY STATION"
                  : stationMode === "OUT"
                    ? "CLOCK OUT ONLY STATION"
                    : "AUTO TWO-WAY STATION"}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              Station Site: <span className="font-semibold text-ink">{stationBranch}</span> · Logged in as{" "}
              <span className="text-muted/80">{account?.name ?? "Work Tablet"}</span>
            </p>
          </div>
        </div>

        {/* Live Digital Clock, Mode Selector & Fullscreen Toggle */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Station Direction Mode Selector */}
          <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.03] p-1" title="Set tablet function for this physical device">
            <button
              type="button"
              onClick={() => changeStationMode("AUTO")}
              className={`rounded-lg px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase transition ${
                stationMode === "AUTO"
                  ? "bg-white/15 text-ink shadow-sm"
                  : "text-muted hover:text-ink"
              }`}
            >
              Auto Mode
            </button>
            <button
              type="button"
              onClick={() => changeStationMode("IN")}
              className={`rounded-lg px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase transition ${
                stationMode === "IN"
                  ? "bg-neon text-black font-extrabold shadow-[0_0_12px_rgba(0,230,118,0.4)]"
                  : "text-muted hover:text-neon"
              }`}
            >
              ● Clock In
            </button>
            <button
              type="button"
              onClick={() => changeStationMode("OUT")}
              className={`rounded-lg px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase transition ${
                stationMode === "OUT"
                  ? "bg-amber-400 text-black font-extrabold shadow-[0_0_12px_rgba(251,191,36,0.4)]"
                  : "text-muted hover:text-amber-400"
              }`}
            >
              ● Clock Out
            </button>
          </div>

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
            <div className={`font-mono text-2xl font-black tracking-wider sm:text-3xl ${
              stationMode === "OUT" ? "text-amber-300" : "text-neon"
            }`}>
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
        {/* PHASE 1: IDLE / STANDBY — ENTER EMPLOYEE NUMBER                   */}
        {/* ================================================================= */}
        {phase === "idle" && (
          <div className="w-full max-w-lg">
            <div className="text-center">
              <span className={`mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl border ${
                stationMode === "OUT"
                  ? "border-amber-400/40 bg-amber-500/10 text-amber-300"
                  : "border-neon/40 bg-neon/10 text-neon"
              }`}>
                <IconUsers className="h-7 w-7" />
              </span>
              <h2 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                {stationMode === "IN"
                  ? "Employee Clock In"
                  : stationMode === "OUT"
                    ? "Employee Clock Out"
                    : "Employee Attendance Sign In"}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {stationMode === "IN"
                  ? "Enter your Employee ID to record your Clock In punch."
                  : stationMode === "OUT"
                    ? "Enter your Employee ID to record your Clock Out punch."
                    : "Enter your Employee ID to view your profile and clock attendance."}
              </p>
            </div>

            {/* Input Box */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleLookup();
              }}
              className="mt-6 space-y-4"
            >
              <div className="relative">
                <input
                  ref={inputRef}
                  type="text"
                  value={empInput}
                  onChange={(e) => setEmpInput(e.target.value.toUpperCase())}
                  placeholder="e.g. EMP1003 or 1003"
                  autoFocus
                  disabled={busy}
                  className={`w-full rounded-2xl border-2 bg-panel-deep/90 px-5 py-4 text-center font-mono text-xl font-bold tracking-wider text-ink uppercase placeholder:text-muted/40 focus:bg-white/[0.06] focus:outline-none sm:text-2xl ${
                    stationMode === "OUT"
                      ? "border-amber-400/30 focus:border-amber-400 focus:ring-4 focus:ring-amber-400/20"
                      : "border-white/10 focus:border-neon focus:ring-4 focus:ring-neon/20"
                  }`}
                />
              </div>

              {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-center text-xs font-semibold text-rose-300">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={busy || !empInput.trim()}
                className={`w-full rounded-2xl py-4 text-base font-extrabold tracking-widest uppercase transition disabled:opacity-50 active:scale-[0.99] ${
                  stationMode === "OUT"
                    ? "bg-amber-400 text-black shadow-[0_0_24px_rgba(251,191,36,0.3)] hover:bg-amber-300"
                    : "btn btn--neon shadow-[0_0_24px_rgba(0,230,118,0.25)]"
                }`}
              >
                {busy
                  ? "LOOKING UP EMPLOYEE…"
                  : stationMode === "IN"
                    ? "PROCEED TO CLOCK IN →"
                    : stationMode === "OUT"
                      ? "PROCEED TO CLOCK OUT →"
                      : "PROCEED TO CLOCK →"}
              </button>
            </form>

            {/* On-Screen Touch Keypad */}
            <div className="mt-7">
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
        {/* PHASE 2: "MY PROFILE" CARD & ONE-TAP CLOCKING INTERFACE           */}
        {/* ================================================================= */}
        {phase === "profile" && profile && status && (
          <div className="w-full max-w-xl animate-in fade-in zoom-in-95 duration-150">
            {/* Profile Hero Card */}
            <div className="relative overflow-hidden rounded-3xl border border-white/15 bg-gradient-to-b from-panel-deep to-void p-6 shadow-2xl sm:p-8">
              <div className="accent-line" aria-hidden="true" />

              {/* Identity Header */}
              <div className="flex flex-col items-center text-center sm:flex-row sm:items-start sm:text-left sm:gap-5">
                <span className={`grid h-20 w-20 shrink-0 place-items-center rounded-2xl border-2 font-mono text-2xl font-black ${
                  targetDir === "OUT"
                    ? "border-amber-400/50 bg-amber-500/15 text-amber-300 shadow-[0_0_24px_rgba(251,191,36,0.3)]"
                    : "border-neon/50 bg-neon/15 text-neon shadow-[0_0_24px_rgba(0,230,118,0.3)]"
                }`}>
                  {initials(profile.fullName)}
                </span>
                <div className="mt-4 flex-1 sm:mt-0">
                  <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                    <h2 className="text-2xl font-black tracking-tight text-ink sm:text-3xl">
                      {profile.fullName}
                    </h2>
                    <span className="rounded-md border border-white/20 bg-white/[0.06] px-2 py-0.5 font-mono text-xs font-bold text-ink">
                      {profile.erpUserId}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-muted">
                    {profile.position} · {profile.department} · {profile.branch}
                  </p>
                  <p className="mt-0.5 text-xs text-muted/70">
                    Assigned Shift: <span className="font-semibold text-ink">{profile.shiftName}</span> ({profile.shiftHours})
                  </p>
                </div>
              </div>

              {/* Current Day Punch Status */}
              <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4.5">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-bold tracking-[0.2em] text-muted uppercase">
                      Current Status Today
                    </span>
                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          status.clockedIn ? "animate-pulse bg-neon shadow-[0_0_8px_#00e676]" : "bg-amber-400"
                        }`}
                      />
                      <span
                        className={`text-base font-extrabold tracking-wide ${
                          status.clockedIn ? "text-neon" : "text-amber-400"
                        }`}
                      >
                        {status.clockedIn ? "CURRENTLY CLOCKED IN" : "CURRENTLY CLOCKED OUT"}
                      </span>
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-[10px] font-bold tracking-[0.2em] text-muted uppercase">
                      Last Punch
                    </span>
                    <p className="mt-1 text-xs font-semibold text-ink">
                      {status.lastPunchAt
                        ? `${formatClockTime(status.lastPunchAt)} (${formatRelative(status.lastPunchAt)})`
                        : "No punch yet today"}
                    </p>
                  </div>
                </div>
              </div>

              {/* Optional PIN Prompt if employee has PIN configured */}
              {profile.hasPin && (
                <div className="mt-5">
                  <label className="block text-center text-xs font-bold tracking-wider text-muted uppercase">
                    Security Verification: Enter 4-Digit Employee PIN
                  </label>
                  <input
                    type="password"
                    maxLength={6}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value.replace(/\D+/g, ""))}
                    placeholder="Enter PIN (if required)"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-center font-mono text-lg font-bold text-ink tracking-widest placeholder:text-muted/40 focus:border-neon focus:outline-none"
                  />
                </div>
              )}

              {error && (
                <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-center text-xs font-semibold text-rose-300">
                  {error}
                </div>
              )}

              {/* Primary Clock In / Clock Out Action Button */}
              <div className="mt-7 space-y-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleClock(targetDir)}
                  className={`group relative flex w-full items-center justify-center gap-3 rounded-2xl py-5 text-xl font-black tracking-widest uppercase transition active:scale-[0.98] ${
                    targetDir === "OUT"
                      ? "border border-amber-400/50 bg-amber-400 text-black shadow-[0_0_35px_rgba(251,191,36,0.35)] hover:bg-amber-300"
                      : "border border-neon/50 bg-neon text-black shadow-[0_0_35px_rgba(0,230,118,0.4)] hover:bg-neon/90"
                  }`}
                >
                  <IconClock className="h-6 w-6" />
                  <span>
                    {busy
                      ? "RECORDING PUNCH…"
                      : targetDir === "OUT"
                        ? "TAP TO CLOCK OUT"
                        : "TAP TO CLOCK IN"}
                  </span>
                </button>

                {/* Alternate Direction Toggle if worker needs to correct sequence */}
                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    onClick={resetKiosk}
                    className="text-xs font-semibold text-muted hover:text-ink"
                  >
                    ← Not you? Cancel
                  </button>

                  <button
                    type="button"
                    onClick={() => handleClock(targetDir === "IN" ? "OUT" : "IN")}
                    className="text-[11px] font-medium text-muted/70 underline underline-offset-4 hover:text-muted"
                  >
                    {targetDir === "IN" ? "Clock OUT instead?" : "Clock IN instead?"}
                  </button>
                </div>
              </div>
            </div>

            <p className="mt-4 text-center text-xs text-muted/60">
              Station auto-resets if inactive for 25 seconds.
            </p>
          </div>
        )}

        {/* ================================================================= */}
        {/* PHASE 3: CONFIRMATION & Snappy 3-SECOND AUTO-RESET                */}
        {/* ================================================================= */}
        {phase === "confirmed" && confirmedPunch && (
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

              {/* Snappy countdown timer badge */}
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
                  className={`w-full rounded-2xl py-3.5 text-xs font-black tracking-widest uppercase transition ${
                    confirmedPunch.direction === "OUT"
                      ? "bg-amber-400 text-black hover:bg-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.3)]"
                      : "btn btn--neon"
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
