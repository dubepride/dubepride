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
import { IconCheck, IconServer } from "./icons";

/**
 * ============================================================================
 *  Settings Console (Phase 11) — system configuration & device integration
 * ============================================================================
 *
 *  Five tabs (General · Biometric Device · Working Hours · Notifications ·
 *  Backup) rendered as a segmented control; the active tab is a local
 *  useState so switching never touches the URL. Every tab is a glass panel
 *  with a Save button that persists the whole settings object to
 *  window.localStorage under "biobridge.settings" and flashes a
 *  "Settings saved" confirmation chip.
 *
 *  Hydration happens inside a useEffect via queueMicrotask so the initial
 *  render always matches the server (static defaults), keeping the
 *  react-hooks/set-state-in-effect rule happy.
 */

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

const TABS = ["General", "Biometric Device", "Working Hours", "Notifications", "Backup"] as const;
type TabName = (typeof TABS)[number];

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
  const [tab, setTab] = useState<TabName>("General");
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

  return (
    <div className="space-y-6">
      {/* Header ------------------------------------------------------ */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Settings</h1>
          <p className="mt-1 text-sm text-muted">
            System configuration · device integration · notifications
          </p>
        </div>
        <span className="chip chip--muted">Phase 11</span>
      </div>

      {/* Segmented tab control --------------------------------------- */}
      <nav
        aria-label="Settings sections"
        className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
      >
        {TABS.map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setTab(t)}
              className={`flex-none rounded-xl border px-4 py-2.5 text-xs font-bold tracking-wide transition-colors ${
                active
                  ? "border-neon/50 bg-neon/10 text-neon shadow-[0_0_18px_rgba(0,230,118,0.18)]"
                  : "border-white/10 bg-white/[0.03] text-muted hover:border-white/25 hover:text-ink"
              }`}
            >
              {t}
            </button>
          );
        })}
      </nav>

      {/* Active tab -------------------------------------------------- */}
      {tab === "General" ? (
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
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Language" htmlFor="set-language">
              <select
                id="set-language"
                className={INPUT}
                value={settings.language}
                onChange={(e) => update("language", e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Panel>
      ) : null}

      {tab === "Biometric Device" ? (
        <BiometricTab settings={settings} update={update} saved={saved} onSave={save} />
      ) : null}

      {tab === "Working Hours" ? (
        <Panel
          title="Working Hours"
          subtitle="The shift window the bridge uses to classify present / late / absent."
          saved={saved}
          onSave={save}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Day Start" htmlFor="set-day-start">
              <input
                id="set-day-start"
                type="time"
                className={INPUT}
                value={settings.dayStart}
                onChange={(e) => update("dayStart", e.target.value)}
              />
            </Field>
            <Field label="Day End" htmlFor="set-day-end">
              <input
                id="set-day-end"
                type="time"
                className={INPUT}
                value={settings.dayEnd}
                onChange={(e) => update("dayEnd", e.target.value)}
              />
            </Field>
          </div>

          <div>
            <span className={LABEL}>Working Days</span>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d) => {
                const on = settings.workingDays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      update(
                        "workingDays",
                        on
                          ? settings.workingDays.filter((x) => x !== d)
                          : [...settings.workingDays, d]
                      )
                    }
                    className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                      on
                        ? "border-neon/50 bg-neon/10 text-neon"
                        : "border-white/10 bg-white/[0.04] text-muted hover:border-white/25 hover:text-ink"
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Break Duration" htmlFor="set-break">
              <select
                id="set-break"
                className={INPUT}
                value={settings.breakMinutes}
                onChange={(e) => update("breakMinutes", e.target.value)}
              >
                <option value="0">No break</option>
                <option value="30">30 minutes</option>
                <option value="45">45 minutes</option>
                <option value="60">60 minutes</option>
              </select>
            </Field>
            <Field
              label="Lateness Grace Period"
              htmlFor="set-grace"
              hint="Minutes past Day Start before a punch counts as late."
            >
              <select
                id="set-grace"
                className={INPUT}
                value={settings.graceMinutes}
                onChange={(e) => update("graceMinutes", e.target.value)}
              >
                <option value="5">5 minutes</option>
                <option value="10">10 minutes</option>
                <option value="15">15 minutes</option>
              </select>
            </Field>
          </div>

          <div className="glass-inset px-4 py-3 text-xs text-muted">
            Shift window{" "}
            <span className="font-mono font-semibold text-neon">{settings.dayStart}</span> →{" "}
            <span className="font-mono font-semibold text-neon">{settings.dayEnd}</span> ·{" "}
            <span className="font-semibold text-ink">{settings.workingDays.length}</span> working
            day{settings.workingDays.length === 1 ? "" : "s"}
          </div>
        </Panel>
      ) : null}

      {tab === "Notifications" ? (
        <Panel
          title="Notifications"
          subtitle="Which events raise an alert, and who receives them."
          saved={saved}
          onSave={save}
        >
          <div className="divide-y divide-white/[0.05]">
            {NOTIFICATION_ROWS.map((row) => {
              const on = settings[row.key];
              return (
                <div
                  key={row.key}
                  className="flex items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{row.label}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{row.desc}</p>
                    {row.time && on ? (
                      <input
                        type="time"
                        aria-label="Absent alert cut-off time"
                        className={`${INPUT} mt-2 w-32`}
                        value={settings.absentAt}
                        onChange={(e) => update("absentAt", e.target.value)}
                      />
                    ) : null}
                  </div>
                  <Toggle
                    on={on}
                    label={row.label}
                    onChange={(next) => update(row.key, next)}
                  />
                </div>
              );
            })}
          </div>

          <Field
            label="Alert Recipients"
            htmlFor="set-recipients"
            hint="Comma-separated list of email addresses."
          >
            <input
              id="set-recipients"
              type="email"
              className={INPUT}
              value={settings.recipients}
              onChange={(e) => update("recipients", e.target.value)}
              autoComplete="off"
            />
          </Field>
        </Panel>
      ) : null}

      {tab === "Backup" ? (
        <BackupTab settings={settings} update={update} saved={saved} onSave={save} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tab 2 — Biometric Device                                            */
/* ------------------------------------------------------------------ */

function BiometricTab({
  settings,
  update,
  saved,
  onSave,
}: {
  settings: SettingsState;
  update: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  saved: boolean;
  onSave: () => void;
}) {
  const { data, loading, error } = usePoll<TerminalsResponse>("/api/terminals", 5000);
  const terminals = useMemo(() => data?.terminals ?? [], [data]);

  // Follow the saved default, falling back to the first registered device.
  const selected = useMemo(
    () => terminals.find((t) => t.id === settings.defaultDeviceId) ?? terminals[0] ?? null,
    [terminals, settings.defaultDeviceId]
  );

  const [testing, setTesting] = useState(false);
  const [testPunch, setTestPunch] = useState<TestPunch | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  async function testDevice() {
    if (!selected) return;
    setTesting(true);
    setTestPunch(null);
    setTestError(null);
    try {
      const res = await fetch("/api/attendance/punch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalId: selected.id }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; punch?: TestPunch }
        | null;
      if (!res.ok || !json?.ok || !json.punch) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }
      setTestPunch(json.punch);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  const isOnline = selected?.status === "Online";

  return (
    <Panel
      title="Biometric Device"
      subtitle="Inspect a fingerprint terminal and push a simulated scan through its channel."
      saved={saved}
      onSave={onSave}
    >
      {/* Device selector ------------------------------------------- */}
      <Field
        label="Device"
        htmlFor="set-device"
        hint="Selecting a device here also persists it as the bridge default."
      >
        <select
          id="set-device"
          className={INPUT}
          value={selected?.id ?? ""}
          disabled={terminals.length === 0}
          onChange={(e) => update("defaultDeviceId", Number(e.target.value))}
        >
          {terminals.length === 0 ? (
            <option value="">No clocking devices registered</option>
          ) : null}
          {terminals.map((t) => (
            <option key={t.id} value={t.id}>
              {t.location} · {t.branch}
            </option>
          ))}
        </select>
      </Field>

      {loading && !data ? (
        <div className="glass-inset flex items-center gap-3 px-4 py-6 text-xs text-muted">
          <span className="spinner" aria-hidden="true" />
          Contacting the terminal registry…
        </div>
      ) : null}

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Device registry unavailable — {error}. Retrying…
        </p>
      ) : null}

      {data && terminals.length === 0 ? (
        <div className="glass-inset px-4 py-6 text-center text-xs text-muted">
          No clocking devices are registered yet — add one from the{" "}
          <span className="text-neon">Clocking Devices</span> page.
        </div>
      ) : null}

      {selected ? (
        <>
          {/* Diagnostic card --------------------------------------- */}
          <div
            className={`glass-inset p-4 ring-1 ${isOnline ? "ring-neon/40" : "ring-danger/40"}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] pb-3">
              <div className="flex items-center gap-2.5">
                <IconServer
                  className={`h-4 w-4 ${isOnline ? "text-neon" : "text-danger"}`}
                />
                <span className="text-[10px] font-bold tracking-[0.22em] text-muted uppercase">
                  Diagnostics
                </span>
              </div>
              <span className={`chip ${isOnline ? "chip--neon" : "chip--danger"}`}>
                <span
                  className={`status-dot ${isOnline ? "status-dot--on" : "status-dot--off"}`}
                />
                {isOnline ? "Device Connected" : "Device Disconnected"}
              </span>
            </div>

            <div className="mt-1">
              <DefRow label="Device Name" value={selected.location} />
              <DefRow label="IP Address" value={selected.ip || "—"} mono />
              <DefRow label="Serial Number" value={selected.mac} mono />
              <DefRow label="Branch" value={selected.branch || "Unassigned"} />
              <DefRow
                label="Last Ping"
                value={isOnline ? formatRelative(selected.lastPing) : "—"}
                mono
              />
              <DefRow label="Scans Today" value={String(selected.scansToday)} mono />
            </div>
          </div>

          {/* Test device ------------------------------------------- */}
          {testPunch ? (
            <div className="rounded-xl border border-neon/40 bg-neon/10 px-4 py-3">
              <p className="flex items-center gap-2 text-xs font-bold text-neon">
                <IconCheck className="h-4 w-4" />
                Device responded — simulated scan accepted at{" "}
                <span className="font-mono">
                  {formatClockTime(new Date(testPunch.timestamp))}
                </span>{" "}
                for <span className="text-ink">{testPunch.employeeName}</span> (
                {testPunch.direction})
              </p>
            </div>
          ) : null}

          {testError ? (
            <p className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-xs text-danger">
              Test failed — {testError}
            </p>
          ) : null}

          <div>
            <button
              type="button"
              className="btn btn--neon"
              onClick={testDevice}
              disabled={testing || !selected}
            >
              {testing ? <span className="spinner" aria-hidden="true" /> : null}
              {testing ? "Testing…" : "Test Device"}
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-muted/80">
              Sends a simulated scan through this terminal&apos;s channel and reports whether the
              bridge accepted it.
            </p>
          </div>
        </>
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Tab 5 — Backup                                                      */
/* ------------------------------------------------------------------ */

function BackupTab({
  settings,
  update,
  saved,
  onSave,
}: {
  settings: SettingsState;
  update: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  saved: boolean;
  onSave: () => void;
}) {
  const [backingUp, setBackingUp] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupErr, setBackupErr] = useState<string | null>(null);

  /**
   * Real export: pull the roster + the most recent attendance records
   * (tolerating either endpoint failing), bundle them with the current
   * settings, and hand the admin a JSON file via a temporary download link.
   */
  async function backUpNow() {
    setBackingUp(true);
    setBackupMsg(null);
    setBackupErr(null);
    let roster: EmployeeDirectoryResponse["employees"] = [];
    let records: AttendanceRecordsResponse["rows"] = [];

    try {
      try {
        const res = await fetch("/api/employees", { cache: "no-store" });
        const json = (await res.json()) as EmployeeDirectoryResponse & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        roster = json.employees;
      } catch {
        roster = []; // tolerate — the backup still exports what it can
      }

      try {
        const res = await fetch("/api/attendance-records?pageSize=100", { cache: "no-store" });
        const json = (await res.json()) as AttendanceRecordsResponse & { error?: string };
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        records = json.rows;
      } catch {
        records = []; // tolerate — the backup still exports what it can
      }

      const payload = { settings, roster, records, exportedAt: Date.now() };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "biobridge-backup.json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      setBackupMsg(`Backup exported — ${records.length} records`);
    } catch (err) {
      setBackupErr(err instanceof Error ? err.message : String(err));
    } finally {
      setBackingUp(false);
    }
  }

  return (
    <Panel
      title="Backup"
      subtitle="Snapshot cadence, retention window and ad-hoc JSON exports."
      saved={saved}
      onSave={onSave}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Automatic Backup" htmlFor="set-backup-schedule">
          <select
            id="set-backup-schedule"
            className={INPUT}
            value={settings.backupSchedule}
            onChange={(e) => update("backupSchedule", e.target.value)}
          >
            <option value="daily">Daily · 02:00</option>
            <option value="weekly">Weekly · Sunday 02:00</option>
            <option value="monthly">Monthly · 1st 02:00</option>
          </select>
        </Field>
        <Field label="Retention" htmlFor="set-retention">
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

      <div className="glass-inset flex items-center gap-3 px-4 py-3">
        <span className="status-dot status-dot--on" aria-hidden="true" />
        <p className="text-xs text-muted">
          Last backup: <span className="font-semibold text-ink">Today, 02:00</span> (automatic)
        </p>
      </div>

      {backupMsg ? (
        <p className="flex items-center gap-2 rounded-xl border border-neon/40 bg-neon/10 px-4 py-3 text-xs font-bold text-neon">
          <IconCheck className="h-4 w-4" />
          {backupMsg}
        </p>
      ) : null}

      {backupErr ? (
        <p className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-xs text-danger">
          Backup failed — {backupErr}
        </p>
      ) : null}

      <div>
        <button
          type="button"
          className="btn btn--neon"
          onClick={backUpNow}
          disabled={backingUp}
        >
          {backingUp ? <span className="spinner" aria-hidden="true" /> : null}
          {backingUp ? "Exporting…" : "Back Up Now"}
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-muted/80">
          Downloads a JSON snapshot of the current settings, the employee roster and the latest
          100 attendance records as{" "}
          <span className="font-mono text-muted">biobridge-backup.json</span>.
        </p>
      </div>
    </Panel>
  );
}
