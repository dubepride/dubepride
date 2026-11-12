"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";

/**
 * "Welcome back" post-login banner.
 *
 * Shown once after a successful login: /login redirects to /?welcome=1,
 * this component detects the flag on mount, scrubs it from the URL (so a
 * refresh doesn't re-show it) and auto-dismisses after 6 seconds.
 */
export default function WelcomeToast() {
  const { account } = useAuth();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("welcome") !== "1") return;

    window.history.replaceState(null, "", window.location.pathname);
    const show = setTimeout(() => setVisible(true), 0);
    const hide = setTimeout(() => setVisible(false), 6000);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      className="rise fixed top-20 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] sm:right-6"
    >
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-panel-deep/95 p-4 shadow-2xl backdrop-blur-2xl">
        <div className="accent-line" aria-hidden="true" />
        <div className="flex items-start gap-3">
          <span className="grid h-8 w-8 flex-none place-items-center rounded-xl border border-neon/40 bg-neon/10 text-sm font-bold text-neon shadow-[0_0_12px_rgba(0,230,118,0.25)]">
            ✓
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-ink">
              Welcome back, {account?.name ?? "Administrator"}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              Signed in to the Attendance console · session active.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setVisible(false)}
            aria-label="Dismiss welcome message"
            className="flex-none rounded-lg p-1 text-muted transition hover:bg-white/[0.06] hover:text-ink"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
