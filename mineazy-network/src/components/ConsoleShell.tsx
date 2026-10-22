/**
 * ============================================================================
 *  ConsoleShell.tsx — the frame around every console screen
 * ============================================================================
 *
 *  Left rail with the eleven navigation sections, the signed-in account and
 *  the sign-out control. The shell also shows the two facts an operator
 *  needs before they trust anything else on screen:
 *
 *    • Whether the console is running in DEMO mode (the data is simulated).
 *    • Whether the collector is alive.
 * ============================================================================
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useState } from "react";
import { Icon } from "./Icon";
import { useAuth } from "./auth";
import { useApi } from "./useApi";
import { timeAgo } from "./format";
import type { PermissionKey } from "@/lib/rbac";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  permission?: PermissionKey;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    title: "Monitor",
    items: [
      { href: "/", label: "Overview", icon: "overview", permission: "can_view_topology" },
      { href: "/map", label: "Live Map", icon: "map", permission: "can_view_topology" },
    ],
  },
  {
    title: "Inventory",
    items: [
      { href: "/devices", label: "Devices", icon: "devices", permission: "can_view_topology" },
      { href: "/switches", label: "Switches & Ports", icon: "switches", permission: "can_view_topology" },
      { href: "/locations", label: "Locations", icon: "locations", permission: "can_view_topology" },
    ],
  },
  {
    title: "Operations",
    items: [
      { href: "/incidents", label: "Incidents", icon: "incidents", permission: "can_view_topology" },
      { href: "/traffic", label: "Traffic", icon: "traffic", permission: "can_view_traffic" },
      { href: "/events", label: "Event History", icon: "events", permission: "can_view_reports" },
    ],
  },
  {
    title: "Configure",
    items: [
      { href: "/discovery", label: "Discovery", icon: "discovery", permission: "can_run_discovery" },
      { href: "/reports", label: "Reports", icon: "reports", permission: "can_view_reports" },
      { href: "/settings", label: "Settings", icon: "settings", permission: "can_config_monitoring" },
    ],
  },
];

interface DemoState {
  enabled: boolean;
  mode: string;
}

interface Heartbeat {
  collector: { at: number; detail: string } | null;
}

interface NavLinkProps {
  href: string;
  icon: string;
  label: string;
}

/**
 * One navigation entry.
 *
 * `usePathname()` is URL data: for a dynamic route it is only known at
 * runtime, so this component is rendered inside a <Suspense> boundary. The
 * link itself belongs to the static shell; only the "active" decoration
 * streams in once the pathname is known.
 */
function NavLink({ href, icon, label }: NavLinkProps) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={`nav-link ${active ? "nav-link--active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <Icon name={icon} size={15} />
      {label}
    </Link>
  );
}

export function ConsoleShell({ children }: { children: React.ReactNode }) {
  const { user, loading, can, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  const demo = useApi<DemoState>("/api/demo", { pollMs: 60_000 });
  const heartbeat = useApi<Heartbeat>("/api/overview", { pollMs: 30_000 });

  // Only the sections the signed-in role may see are listed.
  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((section) => section.items.length > 0);

  const collectorAt = heartbeat.data?.collector?.at ?? null;
  // The age is measured against the moment the payload was fetched, not
  // against the clock — a component must not read the current time while it
  // renders, or two renders of the same data could disagree.
  const collectorStale =
    typeof collectorAt === "number" && heartbeat.loadedAt !== null
      ? heartbeat.loadedAt - collectorAt > 5 * 60_000
      : true;

  return (
    <div className="shell">
      {/* ---------------------------------------------------------- */}
      {/* Navigation rail                                             */}
      {/* ---------------------------------------------------------- */}
      <button
        type="button"
        className="glass fixed top-3 left-3 z-50 flex items-center gap-2 px-3 py-2 text-xs font-semibold lg:hidden"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Toggle navigation"
      >
        <Icon name="grid" size={14} />
        Mineazy
      </button>

      <nav
        className={`shell__nav ${open ? "block" : "hidden"} lg:block`}
        aria-label="Console sections"
      >
        <Link href="/" className="mb-4 flex items-center gap-2.5 px-2 pt-1">
          <span className="neon-box flex h-9 w-9 items-center justify-center rounded-xl bg-neon/15 text-neon">
            <Icon name="map" size={18} />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-extrabold tracking-[0.2em] text-white">MINEAZY</span>
            <span className="block text-[0.6rem] font-semibold tracking-[0.3em] text-neon uppercase">
              Network
            </span>
          </span>
        </Link>

        <Suspense
          fallback={
            <>
              {sections.map((section) => (
                <div key={section.title}>
                  <div className="nav-section">{section.title}</div>
                  {section.items.map((item) => (
                    <Link key={item.href} href={item.href} className="nav-link">
                      <Icon name={item.icon} size={15} />
                      {item.label}
                    </Link>
                  ))}
                </div>
              ))}
            </>
          }
        >
          {sections.map((section) => (
            <div key={section.title}>
              <div className="nav-section">{section.title}</div>
              {section.items.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon} label={item.label} />
              ))}
            </div>
          ))}
        </Suspense>

        <div className="nav-section">Status</div>
        <div className="px-2">
          {demo.data?.enabled ? (
            <div className="chip chip--purple mb-2 w-full justify-center" title="All data on this console is simulated. No real hardware is being polled.">
              DEMO MODE · SIMULATED
            </div>
          ) : null}
          <div
            className="glass-inset px-2.5 py-2 text-[0.68rem] leading-relaxed text-muted"
            title={
              collectorAt
                ? `Last collector cycle: ${timeAgo(collectorAt)}. ${heartbeat.data?.collector?.detail ?? ""}`
                : "The collector has never reported a heartbeat."
            }
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`status-dot ${
                  collectorAt && !collectorStale ? "status-dot--on" : "status-dot--idle"
                }`}
              />
              <span className="font-semibold text-white">Collector</span>
            </div>
            <div className="mt-0.5">
              {collectorAt
                ? `${collectorStale ? "last cycle" : "cycle"} ${timeAgo(collectorAt)}`
                : "never run"}
            </div>
          </div>
        </div>

        <div className="mt-5 border-t border-white/8 px-2 pt-3">
          {loading ? (
            <div className="text-xs text-muted">Loading account…</div>
          ) : user ? (
            <>
              <div className="truncate text-sm font-semibold text-white">{user.displayName}</div>
              <div className="truncate text-[0.7rem] text-muted">{user.username}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="chip chip--muted">{user.role}</span>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="btn btn--ghost btn--sm ml-auto"
                >
                  <Icon name="signout" size={13} />
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <div className="text-xs text-muted">Not signed in.</div>
          )}
        </div>
      </nav>

      {/* ---------------------------------------------------------- */}
      {/* Screen                                                     */}
      {/* ---------------------------------------------------------- */}
      <main className="shell__main pt-14 lg:pt-0">
        <div className="mx-auto w-full max-w-[110rem]">{children}</div>
      </main>
    </div>
  );
}
