"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import Sidebar from "@/components/Sidebar";
import MapOverlay from "@/components/MapOverlay";

/** Header title per route — mirrors the sidebar's label wording. */
const TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/login": "Secure Area",
  "/tablet": "Tablet Clocking Station",
  "/my-portal": "My Portal",
  "/employees": "Employee Directory",
  "/exceptions": "Exceptions",
  "/timesheets": "Timesheets",
  "/whos-in": "Who's In",
  "/terminals": "Time Clocks",
  "/sync": "ERP Sync Logs",
};

/**
 * App chrome: the fixed left rail (Sidebar) + the sticky top bar (Nav),
 * bound to one piece of pathname state so active highlighting and the
 * mobile drawer stay consistent.
 *
 * Lives inside the layout's Suspense boundary — usePathname() suspends
 * on routes that can't be fully prerendered (e.g. /employees/[id]),
 * exactly like the old Nav-only arrangement, so the static shell falls
 * back to a same-size rail + header placeholder.
 *
 * Drawer hygiene: closes on route change, on Escape, when the viewport
 * grows past the lg breakpoint, and locks background scroll while open.
 */
export default function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const onLogin = pathname === "/login";

  // Close the mobile drawer on route change — React's render-phase
  // adjustment pattern (state derived from a changed prop), not an
  // effect, so back/forward navigation can't strand an open drawer.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  // While open: lock background scroll, honour Escape, auto-close at lg+.
  useEffect(() => {
    if (!drawerOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    const mq = window.matchMedia("(min-width: 1024px)");
    const onMq = () => {
      if (mq.matches) setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onMq);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onMq);
    };
  }, [drawerOpen]);

  if (onLogin) {
    return (
      <div className="flex min-h-screen flex-col bg-void text-ink">
        {children}
      </div>
    );
  }

  const title =
    TITLES[pathname] ??
    (pathname.startsWith("/employees") ? "Employee Timesheet" : "Dashboard");

  return (
    <>
      <Sidebar
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onLogin={false}
        activePath={pathname}
      />
      <Nav onLogin={false} title={title} onMenu={() => setDrawerOpen(true)} />
      <MapOverlay hidden={false} />
      <div className="flex flex-1 flex-col lg:pl-64">
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-7 sm:px-6 lg:px-8">
          {children}
        </main>
        <footer className="border-t border-white/[0.06] px-4 py-5 text-center text-[11px] tracking-[0.16em] text-muted/60 uppercase">
          BIOBRIDGE · Enterprise Time &amp; Attendance Platform · All Systems Operational
        </footer>
      </div>
    </>
  );
}
