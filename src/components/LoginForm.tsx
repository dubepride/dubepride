"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/**
 * System Account sign-in (Phase 13/14).
 *
 * POSTs to /api/auth/login with an optional Company Email + password. On
 * success the server sets an HttpOnly signed session cookie and returns the
 * account's `home` page — the dashboard for admin roles, My Portal for a
 * Worker — and we signal the AuthContext (via the `biobridge:auth` event)
 * so the sidebar renders the exactly-permitted links, then navigate there.
 *
 * The email field is optional: leaving it blank signs into the built-in
 * Bridge administrator, so the app's long-standing single-password demo
 * flow (type `biobridge-admin`) keeps working unchanged.
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
      // Client navigation — the Set-Cookie above is already stored, and the
      // proxy validates it on the RSC request that router.push() issues.
      // Tell the AuthContext to re-read /api/auth/me with the new cookie so
      // the sidebar is permission-correct the instant the page mounts.
      window.dispatchEvent(new Event("biobridge:auth"));
      router.push(data.home ?? "/?welcome=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bridge unreachable.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center py-10">
      <section className="glass rise relative w-full max-w-md overflow-hidden px-6 py-8 sm:px-8">
        <div className="accent-line" aria-hidden="true" />

        {/* Brand mark ------------------------------------------------- */}
        <div className="text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-neon/40 bg-panel-deep/70 text-neon shadow-[0_0_26px_rgba(0,230,118,0.3)]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
              className="h-7 w-7"
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

          <h1 className="mt-5 text-xl font-extrabold tracking-[0.28em] text-ink uppercase">
            BIOBRIDGE
          </h1>
          <p className="mt-1.5 text-xs font-medium tracking-[0.24em] text-muted uppercase">
            Time &amp; Attendance Management Portal
          </p>
        </div>

        {/* Credential form --------------------------------------------- */}
        <form onSubmit={submit} className="mt-7 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-bold tracking-[0.2em] text-muted uppercase">
              Work Email <span className="text-muted/50">(optional)</span>
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="admin@biobridge.example"
              className="glass-inset w-full rounded-xl px-4 py-3 text-sm text-ink placeholder:text-muted/60 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-bold tracking-[0.2em] text-muted uppercase">
              Administrator Password
            </span>
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
                placeholder="Enter password"
                className="glass-inset w-full rounded-xl px-4 py-3 pr-16 text-sm text-ink placeholder:text-muted/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-[10px] font-bold tracking-widest text-muted uppercase transition hover:text-neon"
                aria-label={show ? "Hide password" : "Show password"}
              >
                {show ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger"
            >
              ✕ {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy || password.length === 0}
            className="btn btn--neon w-full justify-center"
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

        <p className="mt-5 text-center text-[10px] tracking-[0.18em] text-muted/70 uppercase">
          Secure HR Portal · Authorized Personnel Only
        </p>
      </section>
    </div>
  );
}