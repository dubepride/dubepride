"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatClockTime, formatRelative } from "@/lib/format";
import type {
  AttendanceRecordsResponse,
  EmployeeDirectoryResponse,
  PunchDirection,
  TerminalsResponse,
} from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import { useAuth } from "@/components/AuthProvider";
import type { PermissionKey } from "@/lib/rbac";
import {
  AccessLevelsTab,
  BranchesTab,
  SystemAccountsTab,
} from "./AccessControlPanel";
import { IconCheck, IconServer } from "./icons";

/* ------------------------------------------------------------------ */
/* Shared form styling                                                 */
/* ------------------------------------------------------------------ */

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

/* ------------------------------------------------------------------ */
/* Settings model                                                      */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "biobridge.settings";

type BooleanKey =
  | "lateAlerts"
  | "absentAlerts"
  | "offlineAlerts"
  | "dailyDigest"
  | "erpFailureAlerts";

interface SettingsState {
  // General
  systemName: string;
  organisation: string;
  timeZone: string;
  dateFormat: string;
  language: string;
  // Biometric device
  defaultDeviceId: number | null;
  // Working hours
  dayStart: string;
  dayEnd: string;
  workingDays: string[]; // subset of DAYS
  breakMinutes: string;
  graceMinutes: string;
  // Notifications
  lateAlerts: boolean;
  absentAlerts: boolean;
  absentAt: string;
  offlineAlerts: boolean;
  dailyDigest: boolean;
  erpFailureAlerts: boolean;
  recipients: string;
  // Backup
  backupSchedule: string; // "daily" | "weekly" | "monthly"
  retentionDays: string; // "7" | "30" | "90"
}

const DEFAULTS: SettingsState = {
  systemName: "BIOBRIDGE T&A Bridge",
  organisation: "BIOBRIDGE Industries",
  timeZone: "Africa/Nairobi",
  dateFormat: "DD/MM/YYYY",
  language: "English",
  defaultDeviceId: null,
  dayStart: "08:00",
  dayEnd: "17:00",
  workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  breakMinutes: "30",
  graceMinutes: "10",
  lateAlerts: true,
  absentAlerts: true,
  absentAt: "09:30",
  offlineAlerts: true,
  dailyDigest: false,
  erpFailureAlerts: true,
  recipients: "hr@biobridge.example",
  backupSchedule: "daily",
  retentionDays: "30",
};

/**
 * All eight tabs in their presentation order. Each carries the capability
 * that unlocks it (Phase 14). An account lacking the capability never sees
 * the tab, and the server-side proxy refuses the route entirely.
 */
interface TabDef {
  id: string;
  label: string;
  perm: PermissionKey;
}

/** Order mirrors the spec's requested sequence: Branches / Access Levels / System Accounts / Biometric Device first. */
const TABS: TabDef[] = [
  { id: "general", label: "General", perm: "can_edit_settings" },
  { id: "branches", label: "Branches", perm: "can_manage_branches" },
  { id: "access-levels", label: "Access Levels", perm: "can_manage_access_levels" },
  { id: "accounts", label: "System Accounts", perm: "can_add_accounts" },
  { id: "device", label: "Biometric Device", perm: "can_config_devices" },
  { id: "working-hours", label: "Working Hours", perm: "can_edit_settings" },
  { id: "notifications", label: "Notifications", perm: "can_edit_settings" },
  { id: "backup", label: "Backup", perm: "can_edit_settings" },
];

const TIME_ZONES = ["Africa/Nairobi", "Europe/London", "America/New_York", "Asia/Dubai", "UTC"];
const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];
const LANGUAGES = ["English", "French", "Swahili"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const NOTIFICATION_ROWS: {
  key: BooleanKey;
  label: string;
  desc: string;
  time?: boolean;
}[] = [
  {
    key: "lateAlerts",
    label: "Late arrival alerts",
    desc: "Flag anyone clocking in after the shift start + grace period.",
  },
  {
    key: "absentAlerts",
    label: "Absent employee alerts",
    desc: "Raise an alert when an expected employee has no punch by the cut-off.",
    time: true,
  },
  {
    key: "offlineAlerts",
    label: "Device offline alerts",
    desc: "Warn when a terminal stops responding to heartbeat pings.",
  },
  {
    key: "dailyDigest",
    label: "Daily attendance digest",
    desc: "Email a summary of the day's attendance at shift end.",
  },
  {
    key: "erpFailureAlerts",
    label: "ERP sync failure alerts",
    desc: "Notify immediately when a batch push to the ERP is rejected.",
  },
];

/** Shape of the `punch` object returned by POST /api/attendance/punch. */
interface TestPunch {
  employeeName: string;
  timestamp: number;
  direction: PunchDirection;
  terminalName: string | null;
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className={LABEL} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-[11px] text-muted/80">{hint}</p> : null}
    </div>
  );
}

/** Definition row used by the device diagnostics card. */
function DefRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] py-2.5 last:border-0">
      <span className="text-[10px] font-bold tracking-[0.16em] text-muted uppercase">{label}</span>
      <span className={`text-sm text-ink ${mono ? "font-mono" : "font-semibold"}`}>{value}</span>
    </div>
  );
}

/** Rounded-full pill switch — neon when on, muted when off. */
function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 flex-none rounded-full border transition-colors ${
        on ? "border-neon/50 bg-neon/25" : "border-white/15 bg-white/[0.06]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${
          on ? "left-[26px] bg-neon shadow-[0_0_10px_rgba(0,230,118,0.6)]" : "left-0.5 bg-muted"
        }`}
        aria-hidden="true"
      />
    </button>
  );
}

/** Glass panel shell shared by every tab. */
function Panel({
  title,
  subtitle,
  saved,
  onSave,
  children,
}: {
  title: string;
  subtitle: string;
  saved: boolean;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="glass rise relative overflow-hidden">
      <div className="accent-line" aria-hidden="true" />
      <header className="border-b border-white/[0.07] px-5 py-4">
        <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">{title}</h2>
        <p className="mt-1 text-[11px] text-muted">{subtitle}</p>
      </header>

      <div className="space-y-5 px-5 py-5">{children}</div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] px-5 py-4">
        {saved ? (
          <span className="chip chip--neon">
            <IconCheck className="h-3.5 w-3.5" />
            Settings saved
          </span>
        ) : (
          <span className="text-[11px] text-muted/70">
            Persisted to this browser&apos;s local storage.
          </span>
        )}
        <button type="button" className="btn btn--neon" onClick={onSave}>
          Save
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function SettingsConsole() {
  const { can, permissions } = useAuth();
  const [tab, setTab] = useState<string>("general");
  const [settings, setSettings] = useState<SettingsState>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  // Hydrate from localStorage without touching state synchronously in the
  // effect body (queueMicrotask defers the read + merge to a microtask).
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) setSettings((prev) => ({ ...prev, ...JSON.parse(raw) }));
      } catch {
        /* ignore malformed / unavailable storage */
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-clear the confirmation banner; clean the pending timer on unmount.
  useEffect(() => {
    return () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  /** Patch one or more fields and clear any stale confirmation banner. */
  const update = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const save = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage full / blocked — the in-memory state still holds */
    }
    setSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 3500);
  };

  // Filter tabs by the signed-in account's permissions. When the active tab
  // is not in the permitted set, fall back to the first permitted tab.
  const visibleTabs = useMemo(() => TABS.filter((t) => can(t.perm)), [can]);
  if (visibleTabs.length > 0 && !visibleTabs.some((t) => t.id === tab)) {
    // Render-phase adjustment — safe because `setTab` runs before paint.
    setTab(visibleTabs[0].id);
  }

  // Build the tab content based on permissions
  const renderTab = () => {
    if (permissions === null) {
      return (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <span className="spinner" /> Loading permission profile…
        </div>
      );
    }
    if (visibleTabs.length === 0) {
      return (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-muted">
          No settings sections are permitted for this access level.
        </p>
      );
    }

    switch (tab) {
      case "general":
        return (
          <Panel
            title="General"
            subtitle="Identity of this bridge — how it names itself and formats time."
            saved={saved}
            onSave={save}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="System Name" htmlFor="set-system-name">
                <input
                  id="set-system-name"
                  className={INPUT}
                  value={settings.systemName}
                  onChange={(e) => update("systemName", e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Organisation" htmlFor="set-org">
                <input
                  id="set-org"
                  className={INPUT}
                  value={settings.organisation}
                  onChange={(e) => update("organisation", e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Time Zone" htmlFor="set-tz">
                <select
                  id="set-tz"
                  className={INPUT}
                  value={settings.timeZone}
                  onChange={(e) => update("timeZone", e.target.value)}
                >
                  {TIME_ZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Date Format" htmlFor="set-date-format">
                <select
                  id="set-date-format"
                  className={INPUT}
                  value={settings.dateFormat}
                  onChange={(e) => update("dateFormat", e.target.value)}
                >
                  {DATE_FORMATS.map((fmt) => (
                    <option key={fmt} value={fmt}>
                      {fmt}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Language" htmlFor="set-lang">
                <select
                  id="set-lang"
                  className={INPUT}
                  value={settings.language}
                  onChange={(e) => update("language", e.target.value)}
                >
                  {LANGUAGES.map((lng) => (
                    <option key={lng} value={lng}>
                      {lng}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Panel>
        );

      case "branches":
        return <BranchesTab />;

      case "access-levels":
        return <AccessLevelsTab />;

      case "accounts":
        return <SystemAccountsTab />;

      case "device":
        return (
          <Panel
            title="Biometric Device"
            subtitle="Default terminal for the simulator & test widget — the live bridge polls every terminal independently."
            saved={saved}
            onSave={save}
          >
            <div className="space-y-4">
              <p className="text-sm text-muted">
                The bridge discovers all 17 branches&apos; terminals automatically via the
                ADMS push channel (see <code className="font-mono text-neon">/api/biometrics/push</code>). The
                selector below only sets which terminal the dashboard&apos;s &apos;Test Clock In&apos;
                widget pretends to be when you press it.
              </p>
              <Field label="Default Device" htmlFor="set-default-device">
                <select
                  id="set-default-device"
                  className={INPUT}
                  value={settings.defaultDeviceId ?? ""}
                  onChange={(e) => update("defaultDeviceId", e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Use the first online terminal</option>
                </select>
              </Field>
            </div>
          </Panel>
        );

      case "working-hours":
        return (
          <Panel
            title="Working Hours"
            subtitle="Shift window, week pattern and grace periods — these drive the exception engine and the daily digest."
            saved={saved}
            onSave={save}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Day Starts" htmlFor="set-day-start">
                <input
                  id="set-day-start"
                  type="time"
                  className={INPUT}
                  value={settings.dayStart}
                  onChange={(e) => update("dayStart", e.target.value)}
                />
              </Field>
              <Field label="Day Ends" htmlFor="set-day-end">
                <input
                  id="set-day-end"
                  type="time"
                  className={INPUT}
                  value={settings.dayEnd}
                  onChange={(e) => update("dayEnd", e.target.value)}
                />
              </Field>
              <Field label="Break (minutes)" htmlFor="set-break">
                <input
                  id="set-break"
                  type="number"
                  min="0"
                  className={INPUT}
                  value={settings.breakMinutes}
                  onChange={(e) => update("breakMinutes", e.target.value)}
                />
              </Field>
              <Field label="Grace (minutes)" htmlFor="set-grace">
                <input
                  id="set-grace"
                  type="number"
                  min="0"
                  className={INPUT}
                  value={settings.graceMinutes}
                  onChange={(e) => update("graceMinutes", e.target.value)}
                />
              </Field>
              <Field label="Working Days" htmlFor="set-days">
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5 text-[11px] font-bold tracking-[0.14em] text-ink/90 cursor-pointer transition hover:border-white/20">
                      <input
                        type="checkbox"
                        checked={settings.workingDays.includes(d)}
                        onChange={(e) =>
                          update(
                            "workingDays",
                            e.target.checked
                              ? [...settings.workingDays, d]
                              : settings.workingDays.filter((wd) => wd !== d)
                          )
                        }
                        className="h-4 w-4 accent-[#00E676]"
                      />
                      {d}
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          </Panel>
        );

      case "notifications":
        return (
          <Panel
            title="Notifications"
            subtitle="Alert rules + recipients — these are consumed by the exception engine and the ERP sync monitor."
            saved={saved}
            onSave={save}
          >
            <div className="space-y-5">
              {NOTIFICATION_ROWS.map((row) => (
                <div key={row.key} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <Toggle
                      on={settings[row.key]}
                      label={row.label}
                      onChange={(next) => update(row.key, next)}
                    />
                    <div>
                      <p className="text-sm font-medium text-ink">{row.label}</p>
                      <p className="text-[11px] text-muted">{row.desc}</p>
                    </div>
                  </div>
                  {row.time && (
                    <label className="flex items-center gap-2 text-[11px] text-muted">
                      Cut-off
                      <input
                        type="time"
                        className={INPUT}
                        value={settings.absentAt}
                        onChange={(e) => update("absentAt", e.target.value)}
                        style={{ width: "100px" }}
                      />
                    </label>
                  )}
                </div>
              ))}
              <Field label="Recipients" htmlFor="set-recipients">
                <input
                  id="set-recipients"
                  className={INPUT}
                  value={settings.recipients}
                  onChange={(e) => update("recipients", e.target.value)}
                  placeholder="hr@biobridge.example, it@biobridge.example"
                />
              </Field>
            </div>
          </Panel>
        );

      case "backup":
        return (
          <Panel
            title="Backup"
            subtitle="SQLite file rotation — the bridge keeps a dated copy of data/ta-bridge.db on the server."
            saved={saved}
            onSave={save}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Schedule" htmlFor="set-backup-schedule">
                <select
                  id="set-backup-schedule"
                  className={INPUT}
                  value={settings.backupSchedule}
                  onChange={(e) => update("backupSchedule", e.target.value)}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </Field>
              <Field label="Retention (days)" htmlFor="set-retention">
                <select
                  id="set-retention"
                  className={INPUT}
                  value={settings.retentionDays}
                  onChange={(e) => update("retentionDays", e.target.value)}
                >
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </select>
              </Field>
            </div>
          </Panel>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header ------------------------------------------------------ */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Settings</h1>
          <p className="mt-1 text-sm text-muted">
            System configuration · device integration · notifications · access control
          </p>
        </div>
        <span className="chip chip--muted">Phase 13/14</span>
      </div>

      {/* Segmented tab control --------------------------------------- */}
      <nav
        aria-label="Settings sections"
        className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
      >
        {visibleTabs.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setTab(t.id)}
              className={`flex-none rounded-xl border px-4 py-2.5 text-xs font-bold tracking-wide transition-colors ${
                active
                  ? "border-neon/50 bg-neon/10 text-neon shadow-[0_0_18px_rgba(0,230,118,0.18)]"
                  : "border-white/10 bg-white/[0.03] text-muted hover:border-white/25 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* Active tab content ------------------------------------------ */}
      {renderTab()}
    </div>
  );
}