"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  IconAlert,
  IconBriefcase,
  IconCalendar,
  IconChart,
  IconClock,
  IconEye,
  IconFingerprint,
  IconHome,
  IconScan,
  IconSchedule,
  IconSettings,
  IconSync,
  IconUsers,
  IconX,
} from "@/components/icons";

/* ------------------------------------------------------------------ */
/* Navigation model                                                    */
/* ------------------------------------------------------------------ */

interface SidebarItem {
  label: string;
  /** Absent href = planned module — rendered disabled with a SOON chip. */
  href?: string;
  icon: ReactNode;
  soon?: boolean;
}

/** Required primary labels — exact wording from the redesign spec. */
const PRIMARY: SidebarItem[] = [
  { label: "Dashboard", href: "/", icon: <IconHome /> },
  { label: "My Portal", icon: <IconBriefcase />, soon: true },
  { label: "Employees", href: "/employees", icon: <IconUsers /> },
  { label: "Attendance Records", href: "/attendance-records", icon: <IconScan /> },
  { label: "Shifts", href: "/shifts", icon: <IconSchedule /> },
  { label: "Reports", href: "/reports", icon: <IconChart /> },
  // Phase 7: every rail item now maps to its own route.
  { label: "Exceptions", href: "/exceptions", icon: <IconAlert /> },
  { label: "Timesheets", href: "/timesheets", icon: <IconCalendar /> },
  { label: "Who's In", href: "/whos-in", icon: <IconEye /> },
  { label: "Clocking Devices", href: "/clocking-devices", icon: <IconClock /> },
];

/** Keeps existing Phase-1/2 system pages reachable from the new rail. */
const SYSTEM: SidebarItem[] = [
  { label: "ERP Sync Logs", href: "/sync", icon: <IconSync /> },
  { label: "Settings", href: "/settings", icon: <IconSettings /> },
];

/** Exact-route items highlight on their page; "/" is the dashboard's exact match. */
function isActive(item: SidebarItem, pathname: string): boolean {
  if (!item.href || item.soon) return false;
  if (item.href === "/") return pathname === "/";
  return pathname.startsWith(item.href);
}

/* ------------------------------------------------------------------ */
/* Rail content (shared by the desktop rail and the mobile drawer)     */
/* ------------------------------------------------------------------ */

function NavItem({
  item,
  pathname,
  onNavigate,
}: {
  item: SidebarItem;
  pathname: string;
  onNavigate: () => void;
}) {
  const base =
    "relative flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors";

  if (item.soon || !item.href) {
    return (
      <span
        title="Coming Soon — planned module, not available yet"
        className={`${base} cursor-not-allowed border-transparent text-muted/50 select-none`}
      >
        {item.icon}
        <span className="flex-1">{item.label}</span>
        <span className="rounded border border-white/10 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.16em] uppercase">
          Soon
        </span>
      </span>
    );
  }

  const active = isActive(item, pathname);
  const skin = active
    ? "border-neon/40 bg-neon/10 text-neon shadow-[0_0_14px_rgba(0,230,118,0.14)]"
    : "border-transparent text-muted hover:border-white/10 hover:bg-white/[0.05] hover:text-ink";

  return (
    <Link
      href={item.href}
      prefetch={true}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`${base} ${skin}`}
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {active ? (
        <span className="h-1.5 w-1.5 rounded-full bg-neon shadow-[0_0_8px_rgba(0,230,118,0.9)]" />
      ) : null}
    </Link>
  );
}

function RailContent({
  onLogin,
  pathname,
  onNavigate,
}: {
  onLogin: boolean;
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <>
      {/* Brand ---------------------------------------------------- */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <span className="grid h-10 w-10 flex-none place-items-center rounded-xl border border-neon/40 bg-panel-deep/60 text-neon shadow-[0_0_18px_rgba(0,230,118,0.25)]">
          <IconFingerprint className="h-5 w-5" />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-extrabold tracking-[0.3em] text-ink">
            BIOBRIDGE
          </span>
          <span className="block text-[10px] tracking-[0.22em] text-muted uppercase">
            T&amp;A · ERP Connector
          </span>
        </span>
      </div>

      {/* Navigation (withheld on the login wall) ------------------- */}
      {onLogin ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <span className="text-[10px] font-bold tracking-[0.24em] text-muted uppercase">
            Secure area
          </span>
          <p className="text-[11px] leading-relaxed text-muted/70">
            Authorised administrators only. Sign in to reach the HR console.
          </p>
        </div>
      ) : (
        <>
          <nav className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3 py-4">
            {PRIMARY.map((item) => (
              <NavItem
                key={item.label}
                item={item}
                pathname={pathname}
                onNavigate={onNavigate}
              />
            ))}

            <div className="px-3 pt-5 pb-1.5">
              <span className="text-[9px] font-bold tracking-[0.24em] text-muted/70 uppercase">
                System
              </span>
            </div>
            {SYSTEM.map((item) => (
              <NavItem
                key={item.label}
                item={item}
                pathname={pathname}
                onNavigate={onNavigate}
              />
            ))}
          </nav>

          {/* Rail footer ------------------------------------------- */}
          <div className="space-y-1 border-t border-white/[0.06] px-5 py-4">
            <p className="flex items-center gap-2 text-[10px] font-bold tracking-[0.18em] text-neon uppercase">
              <span className="status-dot status-dot--on" />
              Bridge online
            </p>
            <p className="text-[10px] tracking-[0.14em] text-muted uppercase">
              17 branches · Biometric T&amp;A
            </p>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

interface SidebarProps {
  /** Mobile drawer visibility (owned by AppChrome). */
  open: boolean;
  onClose: () => void;
  /** True while on /login — the rail then shows brand only. */
  onLogin: boolean;
  /** Current pathname for active-state highlighting. */
  activePath: string;
}

/**
 * Fixed left navigation rail (desktop) + slide-over drawer (mobile).
 *
 * On the login wall the rail degrades to a brand plate so the sign-in
 * screen keeps its split-layout look without leaking the admin nav
 * pre-authentication. The rail always occupies 16rem at lg+, which is
 * what the `lg:pl-64` content offset in the root layout clears.
 */
export default function Sidebar({ open, onClose, onLogin, activePath }: SidebarProps) {
  const content = (
    <RailContent onLogin={onLogin} pathname={activePath} onNavigate={onClose} />
  );

  return (
    <>
      {/* Desktop rail --------------------------------------------- */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-white/[0.06] bg-gradient-to-b from-panel-deep/45 via-void/95 to-void backdrop-blur-xl lg:flex">
        {content}
      </aside>

      {/* Mobile drawer -------------------------------------------- */}
      <div
        className={`fixed inset-0 z-50 lg:hidden ${open ? "" : "pointer-events-none"}`}
        aria-hidden={!open}
        inert={!open}
      >
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity ${
            open ? "opacity-100" : "opacity-0"
          }`}
        />
        <aside
          aria-label="Navigation"
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/[0.08] bg-void transition-transform duration-300 ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            className="absolute top-3 right-3 z-10 rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-muted transition hover:text-ink"
          >
            <IconX className="h-4 w-4" />
          </button>
          {content}
        </aside>
      </div>
    </>
  );
}
