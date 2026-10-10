"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  EmployeeDirectoryEntry,
  EmployeeDirectoryResponse,
  ShiftRow,
  ShiftsResponse,
} from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import { IconEdit, IconSchedule, IconTrash, IconX } from "./icons";

/**
 * ============================================================================
 *  Shifts Console — Phase 11 /shifts (tabbed page)
 * ============================================================================
 *
 *  Two views behind one segmented header control (local state — no route
 *  change):
 *
 *  · "Shifts"             — the shift-definition CRUD table. Add/Edit happen
 *    in a glassmorphism modal (7 day pills composing "Mon,Tue,…" ), Remove in
 *    a confirm dialog; every mutation POSTs/PUTs/DELETEs against /api/shifts
 *    and then refreshes the 5s poll.
 *  · "Employee Schedules" — a visual roster: one glass card per shift (ordered
 *    by Shift_ID) listing the employees whose shiftId matches, plus a final
 *    "Unassigned" card for shiftId == null. Names deep-link to /employees/[id].
 */

/* ------------------------------------------------------------------ */
/* Constants & helpers                                                 */
/* ------------------------------------------------------------------ */

/** Canonical weekday order used by both the table and the day pills. */
const ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** 480 → "8h 0m", 540 → "9h 0m" (duration is pre-computed server-side). */
function formatShiftDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

/** Split the stored "Mon,Tue,…" list, dropping blanks. */
function splitDays(days: string): string[] {
  return days
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

type TabId = "shifts" | "schedules";
type ModalMode = "add" | "edit" | "delete";

interface ModalState {
  mode: ModalMode;
  shift: ShiftRow | null;
}

/* ------------------------------------------------------------------ */
/* Modal shell — copied glassmorphism panel (backdrop + Escape + close) */
/* ------------------------------------------------------------------ */

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  width = "max-w-lg",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  // Escape closes; the page behind the veil stays scroll-locked by overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-md"
      />
      <div
        className={`glass rise absolute top-1/2 left-1/2 w-[calc(100vw-2rem)] ${width} -translate-x-1/2 -translate-y-1/2 overflow-hidden`}
      >
        <div className="accent-line" aria-hidden="true" />
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
          <div>
            <h3 className="text-sm font-bold tracking-[0.18em] text-ink uppercase">{title}</h3>
            {subtitle ? <p className="mt-1 text-xs text-muted">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border border-white/10 bg-white/[0.04] p-2 text-muted transition hover:border-white/25 hover:text-ink"
          >
            <IconX className="h-4 w-4" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add / Edit shift form                                               */
/* ------------------------------------------------------------------ */

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

function ShiftForm({
  mode,
  shift,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  shift: ShiftRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(shift?.Name ?? "");
  const [start, setStart] = useState(shift?.Start_Time ?? "09:00");
  const [end, setEnd] = useState(shift?.End_Time ?? "17:00");
  const [days, setDays] = useState<string[]>(
    shift ? splitDays(shift.Days) : ["Mon", "Tue", "Wed", "Thu", "Fri"]
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isAdd = mode === "add";

  const toggleDay = (day: string) =>
    setDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const daysStr = ALL_DAYS.filter((d) => days.includes(d)).join(",");
    if (!name.trim()) {
      setFormError("Shift name is required.");
      return;
    }
    if (!daysStr) {
      setFormError("Pick at least one day for this shift.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/shifts", {
        method: isAdd ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isAdd
            ? { name: name.trim(), startTime: start, endTime: end, days: daysStr }
            : { id: shift?.Shift_ID, name: name.trim(), startTime: start, endTime: end, days: daysStr }
        ),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; id?: number; error?: string }
        | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);

      onSaved();
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={isAdd ? "Add Shift" : "Edit Shift"}
      subtitle={
        isAdd
          ? "Define a new shift window and the weekdays it repeats on."
          : `Editing “${shift?.Name ?? ""}” — rename it, move its window or change its days.`
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4 px-5 py-5">
        <div>
          <label className={LABEL} htmlFor="shift-name">
            Shift Name
          </label>
          <input
            id="shift-name"
            className={INPUT}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Swing"
            autoComplete="off"
            required
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="shift-start">
              Start
            </label>
            <input
              id="shift-start"
              type="time"
              className={`${INPUT} font-mono`}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="shift-end">
              End
            </label>
            <input
              id="shift-end"
              type="time"
              className={`${INPUT} font-mono`}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </div>
        </div>

        <fieldset>
          <legend className={LABEL}>Days</legend>
          <div className="flex flex-wrap gap-2">
            {ALL_DAYS.map((day) => {
              const on = days.includes(day);
              return (
                <label
                  key={day}
                  className={`cursor-pointer rounded-full border px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase transition ${
                    on
                      ? "border-neon/50 bg-neon/10 text-neon"
                      : "border-white/10 bg-white/[0.04] text-muted hover:border-white/25 hover:text-ink"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() => toggleDay(day)}
                  />
                  {day}
                </label>
              );
            })}
          </div>
        </fieldset>

        {formError ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.07] pt-4">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            Cancel
          </button>
          <button type="submit" className="btn btn--neon" disabled={saving}>
            {saving ? <span className="spinner" aria-hidden="true" /> : null}
            {isAdd ? "Add Shift" : "Save Changes"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Delete confirmation                                                 */
/* ------------------------------------------------------------------ */

function DeleteConfirm({
  shift,
  onClose,
  onDeleted,
}: {
  shift: ShiftRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/shifts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: shift.Shift_ID }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);

      onDeleted();
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title="Delete Shift"
      subtitle="Employees assigned to it will be released (moved to Unassigned)."
      onClose={onClose}
      width="max-w-md"
    >
      <div className="space-y-4 px-5 py-5">
        <div className="glass-inset rounded-xl p-4">
          <p className="text-sm font-semibold text-ink">{shift.Name}</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {shift.Start_Time} → {shift.End_Time} · {formatShiftDuration(shift.Duration_Minutes)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {splitDays(shift.Days).map((d) => (
              <span key={d} className="chip chip--muted">
                {d}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            {shift.Assigned} employee{shift.Assigned === 1 ? "" : "s"} currently assigned.
          </p>
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Deleting a shift only affects this bridge — punches already captured stay in the
          attendance history and the ERP buffer.
        </p>

        {formError ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.07] pt-4">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            className="btn"
            disabled={saving}
            style={{ background: "#ff5252", color: "#1b0505" }}
          >
            {saving ? <span className="spinner" aria-hidden="true" /> : null}
            Delete Shift
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function ShiftsConsole() {
  const [tab, setTab] = useState<TabId>("shifts");
  const [modal, setModal] = useState<ModalState | null>(null);

  // Shift definitions poll — shared by both tabs (the roster cards need them too).
  const { data, loading, error, refresh } = usePoll<ShiftsResponse>("/api/shifts", 5000);

  // Roster loads once — the schedules tab is a static mapping view.
  const [roster, setRoster] = useState<EmployeeDirectoryEntry[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/employees", { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as
          | (EmployeeDirectoryResponse & { error?: string })
          | null;
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        if (!cancelled) setRoster(json?.employees ?? []);
      } catch (err) {
        if (!cancelled) setRosterError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const shifts = useMemo(
    () => [...(data?.shifts ?? [])].sort((a, b) => a.Shift_ID - b.Shift_ID),
    [data]
  );

  const handleSaved = () => refresh();
  const handleDeleted = () => refresh();

  return (
    <div className="space-y-6">
      {/* Header ------------------------------------------------------ */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Shifts</h1>
          <p className="mt-1 text-sm text-muted">
            Shift definitions and the employee-to-shift roster across the bridge.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Segmented tab control — local state, no route change. */}
          <div
            role="tablist"
            aria-label="Shift views"
            className="glass-inset flex items-center gap-1 rounded-xl p-1"
          >
            {(
              [
                { id: "shifts", label: "Shifts" },
                { id: "schedules", label: "Employee Schedules" },
              ] as { id: TabId; label: string }[]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-lg border px-4 py-2 text-[11px] font-bold tracking-[0.14em] uppercase transition ${
                  tab === t.id
                    ? "border-neon/50 bg-neon/10 text-neon shadow-[0_0_16px_rgba(0,230,118,0.18)]"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "shifts" ? (
            <button
              type="button"
              className="btn btn--neon"
              onClick={() => setModal({ mode: "add", shift: null })}
            >
              + Add Shift
            </button>
          ) : null}
        </div>
      </div>

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Shift catalogue unavailable — {error}. Retrying…
        </p>
      ) : null}

      {tab === "shifts" ? (
        /* ============================================================ */
        /* TAB 1 — Shift definitions                                   */
        /* ============================================================ */
        <section className="glass relative overflow-hidden">
          <div className="accent-line" aria-hidden="true" />
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
            <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
              Shift Definitions
            </h2>
            <span className="font-mono text-[11px] tracking-wider text-muted">
              {shifts.length} SHIFTS
            </span>
          </header>

          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead className="tbl-head">
                <tr>
                  <th>Shift</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Duration</th>
                  <th>Days</th>
                  <th>Assigned</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data ? (
                  <tr>
                    <td colSpan={7} className="h-32 text-center">
                      <span className="spinner text-neon" aria-hidden="true" />
                      <span className="sr-only">Loading shifts…</span>
                    </td>
                  </tr>
                ) : shifts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-muted">
                      No shifts defined yet — use{" "}
                      <span className="text-neon">+ Add Shift</span> to create the first one.
                    </td>
                  </tr>
                ) : (
                  shifts.map((s) => (
                    <tr key={s.Shift_ID} className="tbl-row transition-colors">
                      <td className="font-semibold text-ink">{s.Name}</td>
                      <td className="font-mono text-muted">{s.Start_Time}</td>
                      <td className="font-mono text-muted">{s.End_Time}</td>
                      <td className="font-mono text-ink tabular-nums">
                        {formatShiftDuration(s.Duration_Minutes)}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1.5">
                          {splitDays(s.Days).map((d) => (
                            <span key={d} className="chip chip--muted">
                              {d}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <span className={`chip ${s.Assigned > 0 ? "chip--neon" : "chip--muted"}`}>
                          {s.Assigned}
                        </span>
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            aria-label={`Edit ${s.Name}`}
                            title="Edit shift"
                            className="rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-muted transition hover:border-neon/40 hover:text-neon"
                            onClick={() => setModal({ mode: "edit", shift: s })}
                          >
                            <IconEdit className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${s.Name}`}
                            title="Delete shift"
                            className="rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-muted transition hover:border-danger/50 hover:text-danger"
                            onClick={() => setModal({ mode: "delete", shift: s })}
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        /* ============================================================ */
        /* TAB 2 — Employee Schedules                                   */
        /* ============================================================ */
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-xs font-bold tracking-[0.24em] text-ink uppercase">
              <IconSchedule className="h-4 w-4 text-neon" aria-hidden="true" />
              People → Shifts
            </h2>
            <span className="font-mono text-[11px] tracking-wider text-muted">
              {roster ? `${roster.length} EMPLOYEES` : "LOADING ROSTER…"}
            </span>
          </div>

          {rosterError ? (
            <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
              Roster unavailable — {rosterError}.
            </p>
          ) : roster === null ? (
            <div className="glass flex items-center justify-center gap-3 px-5 py-14">
              <span className="spinner text-neon" aria-hidden="true" />
              <span className="text-sm text-muted">Loading roster…</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
              {shifts.map((s) => {
                const people = roster.filter((e) => e.shiftId === s.Shift_ID);
                return (
                  <article key={s.Shift_ID} className="glass rise relative overflow-hidden">
                    <div className="accent-line" aria-hidden="true" />
                    <header className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold text-ink">{s.Name}</h3>
                        <p className="mt-1 font-mono text-xs text-muted">
                          {s.Start_Time} → {s.End_Time}
                        </p>
                      </div>
                      <span className={`chip ${people.length > 0 ? "chip--neon" : "chip--muted"}`}>
                        {people.length}
                      </span>
                    </header>

                    <div className="divide-y divide-white/[0.05]">
                      {people.length === 0 ? (
                        <p className="px-5 py-6 text-center text-xs text-muted">
                          No employees assigned to this shift.
                        </p>
                      ) : (
                        people.map((p) => (
                          <div key={p.id} className="flex items-center gap-3 px-5 py-3">
                            <div className="min-w-0 flex-1">
                              <Link
                                href={`/employees/${p.id}`}
                                className="block truncate text-sm font-semibold text-ink transition hover:text-neon"
                              >
                                {p.fullName}
                              </Link>
                              <p className="mt-0.5 truncate text-xs text-muted">
                                {p.department} · {p.position}
                              </p>
                            </div>
                            <span className="flex-none font-mono text-[11px] text-muted">
                              {p.erpUserId}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </article>
                );
              })}

              {/* Unassigned bucket ------------------------------------ */}
              {(() => {
                const loose = roster.filter((e) => e.shiftId == null);
                return (
                  <article className="glass rise relative overflow-hidden">
                    <div className="accent-line" aria-hidden="true" />
                    <header className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-bold text-ink">Unassigned</h3>
                        <p className="mt-1 font-mono text-xs text-muted">no shift selected</p>
                      </div>
                      <span className="chip chip--warn">{loose.length}</span>
                    </header>

                    <div className="divide-y divide-white/[0.05]">
                      {loose.length === 0 ? (
                        <p className="px-5 py-6 text-center text-xs text-muted">
                          Every employee has a shift assigned.
                        </p>
                      ) : (
                        loose.map((p) => (
                          <div key={p.id} className="flex items-center gap-3 px-5 py-3">
                            <div className="min-w-0 flex-1">
                              <Link
                                href={`/employees/${p.id}`}
                                className="block truncate text-sm font-semibold text-ink transition hover:text-neon"
                              >
                                {p.fullName}
                              </Link>
                              <p className="mt-0.5 truncate text-xs text-muted">
                                {p.department} · {p.position}
                              </p>
                            </div>
                            <span className="flex-none font-mono text-[11px] text-muted">
                              {p.erpUserId}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </article>
                );
              })()}
            </div>
          )}
        </section>
      )}

      {/* Modals ------------------------------------------------------ */}
      {modal?.mode === "add" || modal?.mode === "edit" ? (
        <ShiftForm
          key={`${modal.mode}-${modal.shift?.Shift_ID ?? "new"}`}
          mode={modal.mode}
          shift={modal.shift}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      ) : null}

      {modal?.mode === "delete" && modal.shift ? (
        <DeleteConfirm
          key={`delete-${modal.shift.Shift_ID}`}
          shift={modal.shift}
          onClose={() => setModal(null)}
          onDeleted={handleDeleted}
        />
      ) : null}
    </div>
  );
}
