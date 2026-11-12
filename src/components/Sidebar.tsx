"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAuth } from "@/components/AuthProvider";
import { BrandMark } from "@/components/BrandMark";
import type { PermissionKey } from "@/lib/rbac";
import {
  IconAlert,
  IconBriefcase,
  IconChart,
  IconClock,
  IconEye,
  IconHome,
  IconLocate,
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
  href: string;
  icon: ReactNode;
  perm?: PermissionKey;
}

const PRIMARY: SidebarItem[] = [
  { label: "Dashboard", href: "/", icon: <IconHome />, perm: "can_view_dashboard" },
  { label: "My Portal", href: "/my-portal", icon: <IconBriefcase />, perm: "can_view_my_portal" },
  { label: "Tablet Station", href: "/tablet", icon: <IconScan />, perm: "can_view_tablet_station" },
  { label: "Employees", href: "/employees", icon: <IconUsers />, perm: "can_view_employees" },
  { label: "Attendance Records", href: "/attendance-records", icon: <IconScan />, perm: "can_view_attendance" },
  { label: "Shifts", href: "/shifts", icon: <IconSchedule />, perm: "can_manage_shifts" },
  { label: "Reports", href: "/reports", icon: <IconChart />, perm: "can_view_reports" },
  { label: "Exceptions", href: "/exceptions", icon: <IconAlert />, perm: "can_view_exceptions" },
  { label: "Who's In", href: "/whos-in", icon: <IconEye />, perm: "can_view_whos_in" },
  { label: "Field Tracker", href: "/field-tracker", icon: <IconLocate />, perm: "can_view_live_map" },
  { label: "Clocking Devices", href: "/clocking-devices", icon: <IconClock />, perm: "can_view_devices" },
];

const SYSTEM: SidebarItem[] = [
  { label: "ERP Sync Logs", href: "/sync", icon: <IconSync />, perm: "can_view_sync" },
  { label: "Settings", href: "/settings", icon: <IconSettings />, perm: "can_view_settings" },
];

function initials(name?: string | null): string {
  if (!name) return "AD";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function isActive(item: SidebarItem, pathname: string): boolean {
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavItem({
  item,
  pathname,
  onNavigate,
}: {
  item: SidebarItem;
  pathname: string;
  onNavigate: () => void;
}) {
  const active = isActive(item, pathname);
  const base =
    "group relative flex items-center gap-3 rounded-xl border px-3 py-2.5 text-xs font-semibold tracking-wide transition-all duration-200";

  const skin = active
    ? "border-neon/30 bg-neon/10 text-neon shadow-[0_0_16px_rgba(0,230,118,0.12)]"
    : "border-transparent text-muted/80 hover:border-white/10 hover:bg-white/[0.04] hover:text-ink";

  return (
    <Link
      href={item.href}
      prefetch={true}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`${base} ${skin}`}
    >
      <span className={active ? "text-neon" : "text-muted group-hover:text-ink transition"}>
        {item.icon}
      </span>
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
  const { status, account, can } = useAuth();
  const ready = status === "ready" && account !== null;

  return (
    <>
      {/* Brand Bar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <span className="grid h-10 w-10 flex-none place-items-center rounded-xl border border-neon/40 bg-panel-deep/60 text-neon shadow-[0_0_18px_rgba(0,230,118,0.25)]">
          <BrandMark className="h-6 w-6" />
        </span>
        <div className="leading-tight">
          <span className="block text-xs font-extrabold tracking-[0.24em] text-ink uppercase">
            BIOBRIDGE
          </span>
          <span className="block text-[9px] tracking-[0.18em] text-muted uppercase">
            Time &amp; Attendance
          </span>
        </div>
      </div>

      {/* Navigation */}
      {onLogin ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <span className="text-[10px] font-bold tracking-[0.24em] text-muted uppercase">
            Secure area
          </span>
          <p className="text-[11px] leading-relaxed text-muted/70">
            Authorised administrators only. Sign in to reach the Attendance console.
          </p>
        </div>
      ) : (
        <>
          {!ready ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <span className="text-[10px] font-bold tracking-[0.24em] text-muted uppercase">
                Access control
              </span>
              <p className="text-[11px] leading-relaxed text-muted/70">
                Loading permission profile…
              </p>
            </div>
          ) : (
            <nav className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3 py-4">
              {PRIMARY.filter((item) => !item.perm || can(item.perm)).map((item) => (
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
              {SYSTEM.filter((item) => !item.perm || can(item.perm)).map((item) => (
                <NavItem
                  key={item.label}
                  item={item}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ))}
            </nav>
          )}

          {/* User Profile & System Status Tile */}
          <div className="border-t border-white/[0.06] p-3.5">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3 backdrop-blur-md">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 flex-none place-items-center rounded-xl border border-neon/30 bg-neon/10 font-mono text-[11px] font-bold text-neon shadow-[0_0_10px_rgba(0,230,118,0.2)]">
                  {initials(account?.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-bold text-ink">
                    {account?.name ?? "Administrator"}
                  </p>
                  <p className="truncate text-[9px] font-semibold text-neon tracking-wider uppercase">
                    {account?.levelName ?? "IT Admin"}
                  </p>
                </div>
              </div>
              <div className="mt-2.5 flex items-center justify-between border-t border-white/[0.06] pt-2 text-[10px]">
                <span className="flex items-center gap-1.5 font-medium text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Bridge Online
                </span>
                <span className="font-mono text-[9px] text-muted/50">Live Cloud</span>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onLogin: boolean;
  activePath: string;
}

export default function Sidebar({ open, onClose, onLogin, activePath }: SidebarProps) {
  const content = (
    <RailContent onLogin={onLogin} pathname={activePath} onNavigate={onClose} />
  );

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-white/[0.06] bg-gradient-to-b from-panel-deep/50 via-void/95 to-void backdrop-blur-xl lg:flex">
        {content}
      </aside>

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
