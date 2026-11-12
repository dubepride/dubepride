"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/**
 * Split-Screen Executive Showcase Sign-In (Option B).
 *
 * Left Pane: Highlights active site capabilities — Work Tablet Kiosk (/tablet),
 *            Mobile GPS Geofence attendance, and automated shift intelligence.
 * Right Pane: Focused, high-contrast credential form for the Attendance console.
 */
export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() || undefined, password }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        home?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Sign-in failed.");
        setBusy(false);
        return;
      }
      window.dispatchEvent(new Event("biobridge:auth"));
      router.push(data.home ?? "/?welcome=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bridge unreachable.");
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen w-full flex-col lg:flex-row bg-void text-ink overflow-x-hidden">
      {/* ── LEFT SHOWCASE PANE (Desktop & Tablets 1024px+) ──────────────── */}
      <section className="relative hidden lg:flex lg:w-1/2 xl:w-7/12 flex-col justify-between border-r border-white/[0.08] bg-gradient-to-br from-panel-deep/90 via-void to-void p-10 xl:p-14 overflow-hidden">
        {/* Ambient atmospheric glows */}
        <div
          className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-neon/15 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl"
          aria-hidden="true"
        />

        {/* Brand Bar */}
        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <span className="grid h-11 w-11 place-items-center rounded-xl border border-neon/40 bg-panel-deep text-neon shadow-[0_0_20px_rgba(0,230,118,0.25)]">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="h-6 w-6"
                aria-hidden="true"
              >
                <path d="M12 4.2a7.8 7.8 0 0 0-7.8 7.8c0 1.1-.1 2.2-.3 3.2" />
                <path d="M12 7.4a4.6 4.6 0 0 0-4.6 4.6c0 1.9.2 3.4.7 5" />
                <path d="M12 10.6a1.4 1.4 0 0 0-1.4 1.4c0 2.6.5 4.7 1.3 6.4" />
                <path d="M15.4 12A3.4 3.4 0 0 0 12 8.6" />
                <path d="M19.8 12A7.8 7.8 0 0 0 16 5" />
                <path d="M15.8 15.6c.4 1.5.6 3 .6 4.6" />
                <path d="M20.4 15.4c.3 1.1.4 2.2.4 3.4" />
              </svg>
            </span>
            <div>
              <span className="block text-sm font-extrabold tracking-[0.28em] text-ink uppercase">
                BIOBRIDGE
              </span>
              <span className="block text-[10px] tracking-[0.2em] text-muted uppercase">
                Time &amp; Attendance Portal
              </span>
            </div>
          </div>

          <div className="inline-flex items-center gap-2 rounded-full border border-neon/30 bg-neon/10 px-3 py-1 text-xs font-semibold text-neon">
            <span className="h-2 w-2 rounded-full bg-neon animate-pulse" />
            Live Cloud Active
          </div>
        </div>

        {/* Center Feature Highlights */}
        <div className="relative z-10 my-auto py-8">
          <div className="inline-block rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1 text-[11px] font-bold tracking-widest text-muted uppercase">
            Workforce Attendance Infrastructure
          </div>
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-ink xl:text-4xl">
            Smart Site Tablet Kiosks &amp; <br />
            <span className="text-neon">GPS Geofenced Field Punches.</span>
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
            Centralised time &amp; attendance management engineered for precision site clocking,
            geofenced mobile field tracking, and real-time automated shift calculations.
          </p>

          {/* 3 Active Capabilities */}
          <div className="mt-8 grid gap-4 max-w-xl">
            {/* Capability 1: Tablet Station */}
            <div className="group rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4.5 transition hover:border-neon/40 hover:bg-white/[0.05]">
              <div className="flex items-start gap-4">
                <span className="grid h-10 w-10 flex-none place-items-center rounded-xl border border-neon/30 bg-neon/10 text-neon">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <rect x="4" y="2" width="16" height="20" rx="2" />
                    <line x1="12" y1="18" x2="12.01" y2="18" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-ink">Tablet Clocking Station</h3>
                    <span className="rounded-md border border-neon/30 bg-neon/10 px-2 py-0.5 text-[10px] font-bold tracking-wider text-neon uppercase">
                      /tablet
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Touch-optimised kiosk station for shared work tablets. Fast employee ID lookup,
                    instant state detection, and fast PIN clocking.
                  </p>
                </div>
              </div>
            </div>

            {/* Capability 2: Geofenced Mobile */}
            <div className="group rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4.5 transition hover:border-emerald-500/40 hover:bg-white/[0.05]">
              <div className="flex items-start gap-4">
                <span className="grid h-10 w-10 flex-none place-items-center rounded-xl border border-emerald-400/30 bg-emerald-400/10 text-emerald-400">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-ink">Mobile GPS Geofence Punch</h3>
                    <span className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-bold tracking-wider text-emerald-400 uppercase">
                      Active Radar
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Multi-OEM GPS location accuracy (Samsung, Redmi, Huawei) with live site perimeter
                    validation, anti-spoofing radar, and offline buffering.
                  </p>
                </div>
              </div>
            </div>

            {/* Capability 3: Automated Shifts */}
            <div className="group rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4.5 transition hover:border-cyan-500/40 hover:bg-white/[0.05]">
              <div className="flex items-start gap-4">
                <span className="grid h-10 w-10 flex-none place-items-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-400">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-ink">Automated Shift Calculations</h3>
                    <span className="rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-bold tracking-wider text-cyan-400 uppercase">
                      Real-time
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Instant shift hours reconciliation, grace period enforcement, anomaly detection,
                    and automated daily/monthly payroll reports.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Telemetry Strip */}
        <div className="relative z-10 flex items-center justify-between border-t border-white/[0.06] pt-5 text-[11px] text-muted">
          <span>Tablet Kiosk: <span className="font-mono text-neon">/tablet</span></span>
          <span>Mobile Engine: <span className="text-ink">GPS v1.4.0</span></span>
          <span>Deployment: <span className="text-ink">biobridge-attendance.vercel.app</span></span>
        </div>
      </section>

      {/* ── RIGHT SIGN-IN PANE (All screen sizes) ────────────────────────── */}
      <section className="relative flex flex-1 flex-col items-center justify-center p-6 sm:p-10 lg:p-12 xl:p-16">
        {/* Subtle center ambient glow */}
        <div
          className="pointer-events-none absolute h-80 w-80 rounded-full bg-neon/10 blur-3xl"
          aria-hidden="true"
        />

        {/* Mobile Header (only visible on screens < 1024px) */}
        <div className="mb-8 text-center lg:hidden">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-neon/40 bg-panel-deep/80 text-neon shadow-[0_0_20px_rgba(0,230,118,0.25)]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className="h-6 w-6"
              aria-hidden="true"
            >
              <path d="M12 4.2a7.8 7.8 0 0 0-7.8 7.8c0 1.1-.1 2.2-.3 3.2" />
              <path d="M12 7.4a4.6 4.6 0 0 0-4.6 4.6c0 1.9.2 3.4.7 5" />
              <path d="M12 10.6a1.4 1.4 0 0 0-1.4 1.4c0 2.6.5 4.7 1.3 6.4" />
              <path d="M15.4 12A3.4 3.4 0 0 0 12 8.6" />
              <path d="M19.8 12A7.8 7.8 0 0 0 16 5" />
              <path d="M15.8 15.6c.4 1.5.6 3 .6 4.6" />
              <path d="M20.4 15.4c.3 1.1.4 2.2.4 3.4" />
            </svg>
          </span>
          <h2 className="mt-3 text-lg font-extrabold tracking-[0.24em] text-ink uppercase">
            BIOBRIDGE
          </h2>
          <p className="mt-1 text-[11px] font-medium tracking-[0.18em] text-muted uppercase">
            Time &amp; Attendance Portal
          </p>
        </div>

        {/* The Sign-in Card */}
        <div className="relative w-full max-w-md rounded-3xl border border-white/10 bg-panel-deep/60 p-7 sm:p-9 shadow-2xl backdrop-blur-2xl">
          <div className="text-center">
            <span className="mx-auto hidden lg:grid h-12 w-12 place-items-center rounded-2xl border border-neon/40 bg-panel-deep text-neon shadow-[0_0_22px_rgba(0,230,118,0.25)]">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="h-6 w-6"
                aria-hidden="true"
              >
                <path d="M12 4.2a7.8 7.8 0 0 0-7.8 7.8c0 1.1-.1 2.2-.3 3.2" />
                <path d="M12 7.4a4.6 4.6 0 0 0-4.6 4.6c0 1.9.2 3.4.7 5" />
                <path d="M12 10.6a1.4 1.4 0 0 0-1.4 1.4c0 2.6.5 4.7 1.3 6.4" />
                <path d="M15.4 12A3.4 3.4 0 0 0 12 8.6" />
                <path d="M19.8 12A7.8 7.8 0 0 0 16 5" />
                <path d="M15.8 15.6c.4 1.5.6 3 .6 4.6" />
                <path d="M20.4 15.4c.3 1.1.4 2.2.4 3.4" />
              </svg>
            </span>
            <h2 className="mt-3 text-xl font-extrabold tracking-tight text-ink">
              Welcome back
            </h2>
            <p className="mt-1 text-xs text-muted">
              Sign in to reach the Attendance console
            </p>
          </div>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold tracking-[0.2em] text-muted uppercase">
                Work Email
              </span>
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="admin@biobridge.com"
                className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-ink placeholder:text-muted/40 focus:border-neon focus:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-neon/20 transition"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold tracking-[0.2em] text-muted uppercase">
                Password
              </span>
              <div className="relative">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  autoComplete="current-password"
                  placeholder="Enter password"
                  className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 pr-16 text-sm text-ink placeholder:text-muted/40 focus:border-neon focus:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-neon/20 transition"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-muted uppercase transition hover:text-neon"
                  aria-label={show ? "Hide password" : "Show password"}
                >
                  {show ? "Hide" : "Show"}
                </button>
              </div>
            </label>

            {error ? (
              <p
                role="alert"
                className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-xs text-danger"
              >
                ✕ {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy || (password.trim().length === 0 && email.trim().length === 0)}
              className="btn btn--neon w-full justify-center py-3.5 text-xs font-black tracking-widest uppercase shadow-[0_0_24px_rgba(0,230,118,0.25)] transition hover:shadow-[0_0_32px_rgba(0,230,118,0.4)] disabled:opacity-50"
            >
              {busy ? (
                <>
                  <span className="spinner" />
                  Verifying…
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-[10px] tracking-[0.18em] text-muted/60 uppercase">
            Secure Portal · Authorized Personnel Only
          </p>
        </div>

        {/* Security / Tablet Link Footer */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3 text-center text-[11px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            🔒 <span>Encrypted Session</span>
          </span>
          <span>·</span>
          <a
            href="/tablet"
            className="text-muted/80 transition hover:text-neon underline-offset-4 hover:underline"
          >
            Open Tablet Kiosk Station →
          </a>
        </div>
      </section>
    </div>
  );
}
