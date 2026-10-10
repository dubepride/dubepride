"use client";

import { useEffect, useState } from "react";

/**
 * "Welcome back, Admin" toast (Objective 1).
 *
 * Shown once after a successful login: /login redirects to /?welcome=1,
 * this component detects the flag on mount, scrubs it from the URL (so a
 * refresh doesn't re-show it) and auto-dismisses after 6 seconds.
 */
export default function WelcomeToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("welcome") !== "1") return;

    // Remove the flag from the address bar without a navigation.
    window.history.replaceState(null, "", window.location.pathname);
    // Deferred so the effect body itself sets no state (React lint rule);
    // the toast appears on the very next tick.
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
      <div className="glass relative overflow-hidden p-4 shadow-[0_12px_40px_rgba(0,0,0,0.55)]">
        <div className="accent-line" aria-hidden="true" />
        <div className="flex items-start gap-3">
          <span className="grid h-8 w-8 flex-none place-items-center rounded-full border border-neon/50 bg-neon/10 text-sm font-bold text-neon">
            ✓
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-ink">Welcome back, Admin</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              Signed in to the HR console · session active for 12 hours.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setVisible(false)}
            aria-label="Dismiss welcome message"
            className="flex-none text-muted transition hover:text-ink"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
