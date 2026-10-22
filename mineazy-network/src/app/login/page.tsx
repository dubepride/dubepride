/**
 * ============================================================================
 *  Login — sign in to the console
 * ============================================================================
 *
 *  The browser posts the credentials to `/api/auth/login`; the server sets an
 *  HttpOnly session cookie and never returns the password (or a hash of it)
 *  to the client.
 * ============================================================================
 */

"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { apiPost } from "@/components/api";
import { Icon } from "@/components/Icon";
import { Notice } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const next = params.get("next") ?? "/";

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/login", { username, password });
      router.replace(next.startsWith("/") ? next : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="glass relative w-full max-w-md px-6 py-7">
      <span className="accent-line" />
      <div className="mb-6 flex items-center gap-3">
        <span className="neon-box flex h-11 w-11 items-center justify-center rounded-xl bg-neon/15 text-neon">
          <Icon name="map" size={20} />
        </span>
        <div>
          <div className="text-sm font-extrabold tracking-[0.24em] text-white">MINEAZY</div>
          <div className="text-[0.62rem] font-semibold tracking-[0.34em] text-neon uppercase">
            Network Console
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="label">Username</span>
          <input
            className="field"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input
            className="field"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <button type="submit" className="btn btn--neon w-full" disabled={busy}>
          {busy ? <span className="spinner" /> : <Icon name="shield" size={15} />}
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="mt-5 text-xs leading-relaxed text-muted">
        Mineazy Network runs entirely on this machine. Credentials are checked against the local
        database and the session is held in an HttpOnly cookie — nothing is sent to a third party.
      </p>
      <p className="mt-2 text-xs text-muted">
        First time here?{" "}
        <a href="/setup" className="font-semibold text-neon hover:underline">
          Run the setup checklist
        </a>
        .
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Suspense
        fallback={
          <div className="glass w-full max-w-md px-6 py-7 text-sm text-muted">Loading…</div>
        }
      >
        <LoginForm />
      </Suspense>
    </main>
  );
}
