"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { IconFingerprint, IconMenu } from "@/components/icons";

interface NavProps {
  /** True while on /login — session controls are withheld there. */
  onLogin: boolean;
  /** Current page title (sidebar label wording) shown on desktop. */
  title: string;
  /** Opens the mobile navigation drawer (owned by AppChrome). */
  onMenu: () => void;
}

function initials(name?: string | null): string {
  if (!name) return "AD";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Top bar: compact wall clock, page title, user account identity, and session controls.
 */
export default function Nav({ onLogin, title, onMenu }: NavProps) {
  const router = useRouter();
  const { account } = useAuth();
  const [clock, setClock] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

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
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-void/80 backdrop-blur-xl lg:pl-64">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        {/* Left: drawer toggle (mobile) · brand (mobile) · page title (desktop) */}
        <div className="flex min-w-0 items-center gap-3">
          {!onLogin ? (
            <button
              type="button"
              onClick={onMenu}
              aria-label="Open navigation"
              className="flex-none rounded-xl border border-white/10 bg-white/[0.03] p-2 text-muted transition hover:border-white/20 hover:text-ink lg:hidden"
            >
              <IconMenu className="h-4 w-4" />
            </button>
          ) : null}

          <Link href="/" className="group flex min-w-0 items-center gap-3 lg:hidden">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-xl border border-neon/40 bg-panel-deep/60 text-neon shadow-[0_0_16px_rgba(0,230,118,0.2)] transition group-hover:shadow-[0_0_24px_rgba(0,230,118,0.4)]">
              <IconFingerprint className="h-5 w-5" />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-xs font-extrabold tracking-[0.24em] text-ink uppercase">
                BIOBRIDGE
              </span>
              <span className="block text-[9px] tracking-[0.18em] text-muted uppercase">
                Time &amp; Attendance
              </span>
            </span>
          </Link>

          <span className="hidden min-w-0 items-center gap-2.5 lg:flex">
            <span className="h-1.5 w-1.5 flex-none rounded-full bg-neon shadow-[0_0_8px_rgba(0,230,118,0.8)]" />
            <span className="text-[10px] font-semibold text-muted/60 uppercase tracking-widest">
              Console
            </span>
            <span className="text-muted/40">/</span>
            <span className="truncate text-xs font-bold tracking-[0.2em] text-ink uppercase">
              {title}
            </span>
          </span>
        </div>

        {/* Right: Clock & User Session ------------------------------ */}
        <div className="flex items-center gap-3 md:gap-4">
          <div className="hidden items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 font-mono text-xs tabular-nums text-muted sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-neon animate-pulse" />
            <span>{clock ?? "--:--:--"}</span>
            <span className="font-sans text-[10px] font-bold tracking-wider text-muted/60 uppercase">
              SAST
            </span>
          </div>

          {!onLogin ? (
            <>
              {/* User Profile Pill */}
              <div className="hidden items-center gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] py-1 pl-1.5 pr-3 lg:flex">
                <span className="grid h-7 w-7 place-items-center rounded-lg border border-neon/30 bg-neon/10 font-mono text-[10px] font-bold text-neon">
                  {initials(account?.name)}
                </span>
                <div className="text-left leading-none">
                  <span className="block text-xs font-bold text-ink">
                    {account?.name ?? "Administrator"}
                  </span>
                  <span className="block text-[9px] font-semibold text-neon tracking-wider uppercase mt-0.5">
                    {account?.levelName ?? "IT Admin"}
                  </span>
                </div>
              </div>

              {/* Sign Out Button */}
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger active:scale-95 disabled:opacity-50"
                title="Sign out of Attendance console"
              >
                {signingOut ? "Signing out…" : "Sign Out"}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
