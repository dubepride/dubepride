"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IconFingerprint, IconMenu } from "@/components/icons";

interface NavProps {
  /** True while on /login — session controls are withheld there. */
  onLogin: boolean;
  /** Current page title (sidebar label wording) shown on desktop. */
  title: string;
  /** Opens the mobile navigation drawer (owned by AppChrome). */
  onMenu: () => void;
}

/**
 * Top bar: compact wall clock, page title and the admin session controls.
 *
 * Navigation itself moved to the fixed left rail (Sidebar.tsx) — this
 * bar keeps only the mobile affordances: the drawer toggle and the
 * compact brand plate (the rail's brand plate owns the desktop space).
 * Presentational — pathname and drawer state are computed by AppChrome.
 */
export default function Nav({ onLogin, title, onMenu }: NavProps) {
  const router = useRouter();
  const [clock, setClock] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Compact wall clock in the top bar (the big Master Clock lives on the
  // dashboard). null on the server → avoids hydration mismatches.
  useEffect(() => {
    const tick = () =>
      setClock(
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date())
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Sign out: clear the HttpOnly session cookie, notify the AuthContext,
  // then fall back to /login.
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.dispatchEvent(new Event("biobridge:auth"));
      router.push("/login");
      setSigningOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-void/75 backdrop-blur-xl lg:pl-64">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        {/* Left: drawer toggle (mobile) · brand (mobile) · title (desktop) */}
        <div className="flex min-w-0 items-center gap-3">
          {!onLogin ? (
            <button
              type="button"
              onClick={onMenu}
              aria-label="Open navigation"
              className="flex-none rounded-lg border border-white/10 bg-white/[0.03] p-2 text-muted transition hover:text-ink lg:hidden"
            >
              <IconMenu className="h-4 w-4" />
            </button>
          ) : null}

          <Link href="/" className="group flex min-w-0 items-center gap-3 lg:hidden">
            <span className="grid h-10 w-10 flex-none place-items-center rounded-xl border border-neon/40 bg-panel-deep/60 text-neon shadow-[0_0_18px_rgba(0,230,118,0.25)] transition group-hover:shadow-[0_0_26px_rgba(0,230,118,0.45)]">
              <IconFingerprint className="h-5 w-5" />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-sm font-extrabold tracking-[0.3em] text-ink">
                BIOBRIDGE
              </span>
              <span className="block text-[10px] tracking-[0.22em] text-muted uppercase">
                T&amp;A · ERP Connector
              </span>
            </span>
          </Link>

          <span className="hidden min-w-0 items-center gap-2.5 lg:flex">
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-neon shadow-[0_0_8px_rgba(0,230,118,0.8)]" />
            <span className="truncate text-[11px] font-bold tracking-[0.26em] text-muted uppercase">
              {title}
            </span>
          </span>
        </div>

        {/* Session status ------------------------------------------- */}
        <div className="flex items-center gap-3 md:gap-4">
          {!onLogin ? (
            <>
              <span className="hidden items-center gap-2 rounded-full border border-neon/30 bg-neon/[0.07] px-3 py-1.5 text-[10px] font-bold tracking-[0.18em] text-neon uppercase lg:flex">
                <span className="status-dot status-dot--on" />
                Admin Session
              </span>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                className="btn btn--ghost px-3! py-1.5! text-[11px] tracking-[0.14em] uppercase"
                title="End the HR admin session"
              >
                {signingOut ? "Signing out…" : "Sign Out"}
              </button>
            </>
          ) : null}
          <span className="hidden font-mono text-sm text-muted tabular-nums md:inline">
            {clock ?? "--:--:--"}
          </span>
        </div>
      </div>
    </header>
  );
}
