"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatDateTime, formatRelative } from "@/lib/format";
import type {
  EmployeeDirectoryEntry,
  EmployeeDirectoryResponse,
  ShiftRow,
} from "@/lib/types";
import TimesheetReport from "./TimesheetReport";
import { IconEdit, IconEye, IconFingerprint, IconPrint, IconSearch, IconTrash, IconX } from "./icons";

/**
 * Employee Directory (Phase 5 → 11) — searchable master table of every row
 * in the Employees table, annotated with Branch_Name (the branch of the
 * employee's most recent punch) and Last_Seen (most recent punch from
 * Attendance_Logs). Rows are clickable and route straight to the
 * employee's timesheet at /employees/[id]; every row also carries inline
 * View / Edit / Delete actions backed by POST / PUT / DELETE
 * /api/employees (glassmorphism modals, same shell as ClockingDevices).
 *
 * Data flow: debounced (250 ms) search box → GET /api/employees?q=… →
 * table. An empty query lists the whole roster alphabetically. Successful
 * mutations bump `nonce`, which re-runs the same fetch (the refresh()).
 *
 * /timesheets (Phase 7) redirects here with ?focus=search — the mount
 * effect below hands the admin a ready-to-type box. The flag is read
 * from window.location so the page stays statically prerendered.
 */

type ModalMode = "add" | "edit" | "delete";

interface ModalState {
  mode: ModalMode;
  employee: EmployeeDirectoryEntry | null;
}

/* ------------------------------------------------------------------ */
/* Modal shell — glassmorphism panel (Escape / backdrop / header ✕)    */
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

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

/* ------------------------------------------------------------------ */
/* Add / Edit employee form                                            */
/* ------------------------------------------------------------------ */

function EmployeeForm({
  mode,
  employee,
  departments,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  employee: EmployeeDirectoryEntry | null;
  departments: string[];
  onClose: () => void;
  /** Called after a successful save — receives the id when just created. */
  onSaved: (id?: number) => void;
}) {
  const router = useRouter();
  const [erpUserId, setErpUserId] = useState(employee?.erpUserId ?? "");
  const [fullName, setFullName] = useState(employee?.fullName ?? "");
  const [department, setDepartment] = useState(employee?.department ?? "");
  const [position, setPosition] = useState(employee?.position ?? "");
  const [branch, setBranch] = useState(employee?.assignedBranch ?? "");
  const [shiftId, setShiftId] = useState(
    employee?.shiftId !== null && employee?.shiftId !== undefined ? String(employee.shiftId) : ""
  );
  const [enrolled, setEnrolled] = useState(employee?.enrolled ?? false);
  const [status, setStatus] = useState(employee?.status === "Inactive" ? "Inactive" : "Active");
  const [shifts, setShifts] = useState<ShiftRow[] | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isAdd = mode === "add";

  // Shift catalogue + branch list are only needed while the modal is open —
  // fetch lazily (branches come from the registered terminal sites).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [shiftsRes, terminalsRes] = await Promise.all([
          fetch("/api/shifts", { cache: "no-store" }),
          fetch("/api/terminals", { cache: "no-store" }),
        ]);
        if (!shiftsRes.ok || !terminalsRes.ok) {
          throw new Error(`HTTP ${shiftsRes.status}/${terminalsRes.status}`);
        }
        const shiftsJson = (await shiftsRes.json()) as { shifts?: ShiftRow[] };
        const terminalsJson = (await terminalsRes.json()) as {
          terminals?: { branch?: string }[];
        };
        if (cancelled) return;
        setShifts(shiftsJson.shifts ?? []);
        setBranches(
          Array.from(
            new Set(
              (terminalsJson.terminals ?? [])
                .map((t) => (t.branch ?? "").trim())
                .filter((b) => b.length > 0)
            )
          ).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
          )
        );
      } catch {
        if (!cancelled) {
          setShifts([]);
          setBranches([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the selects honest if the saved value is missing from the catalogue.
  const shiftKnown =
    shiftId === "" || (shifts ?? []).some((s) => String(s.Shift_ID) === shiftId);
  const branchKnown = branch === "" || branches.includes(branch);

  async function submit(e: React.FormEvent | null, enrolAfter = false) {
    e?.preventDefault();
    const erp = erpUserId.trim();
    const name = fullName.trim();
    if (!erp || !name) {
      setFormError("ERP user ID and full name are required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/employees", {
        method: isAdd ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isAdd || !employee ? {} : { id: employee.id }),
          erpUserId: erp,
          fullName: name,
          department: department.trim(),
          position: position.trim(),
          branch: branch.trim(),
          shiftId: shiftId === "" ? null : Number(shiftId),
          enrolled,
          status,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        id?: number;
        error?: string;
      } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);

      // "Save & Enrol Prints" — straight into the five-finger console.
      const createdId = isAdd ? json.id : employee?.id;
      if (enrolAfter && createdId) {
        onClose();
        router.push(`/employees/${createdId}/fingerprints`);
        return;
      }
      onSaved(isAdd ? json.id : undefined);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={isAdd ? "Add Employee" : "Edit Employee"}
      subtitle={
        isAdd
          ? "Register a new employee on the bridge — ERP ID and name are required."
          : `Editing ${employee?.fullName ?? ""} — update their record, shift or enrolment.`
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4 px-5 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="emp-erp">
              ERP User ID
            </label>
            <input
              id="emp-erp"
              className={`${INPUT} font-mono`}
              value={erpUserId}
              onChange={(e) => setErpUserId(e.target.value)}
              placeholder="ERP-1016"
              autoComplete="off"
              required
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="emp-name">
              Full Name
            </label>
            <input
              id="emp-name"
              className={INPUT}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Amara Okafor"
              autoComplete="off"
              required
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="emp-dept">
              Department
            </label>
            <input
              id="emp-dept"
              list="emp-departments"
              className={INPUT}
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="Operations"
              autoComplete="off"
            />
            <datalist id="emp-departments">
              {departments.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </div>

          <div>
            <label className={LABEL} htmlFor="emp-position">
              Position
            </label>
            <input
              id="emp-position"
              className={INPUT}
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="Field Officer"
              autoComplete="off"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="emp-branch">
              Branch
            </label>
            <select
              id="emp-branch"
              className={INPUT}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            >
              <option value="">Unassigned</option>
              {!branchKnown && branch !== "" ? (
                <option value={branch}>{branch}</option>
              ) : null}
              {branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-muted/70">
              Home branch — where this employee is based.
            </p>
          </div>

          <div>
            <label className={LABEL} htmlFor="emp-shift">
              Shift
            </label>
            <select
              id="emp-shift"
              className={INPUT}
              value={shiftId}
              onChange={(e) => setShiftId(e.target.value)}
            >
              <option value="">None</option>
              {!shiftKnown && shiftId !== "" ? (
                <option value={shiftId}>Shift #{shiftId}</option>
              ) : null}
              {(shifts ?? []).map((s) => (
                <option key={s.Shift_ID} value={String(s.Shift_ID)}>
                  {`${s.Name} · ${s.Start_Time}→${s.End_Time}`}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={LABEL} htmlFor="emp-status">
              Status
            </label>
            <select
              id="emp-status"
              className={INPUT}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <span className={LABEL}>Fingerprint Enrolled</span>
            <label
              htmlFor="emp-enrolled"
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 transition hover:border-neon/40"
            >
              <input
                id="emp-enrolled"
                type="checkbox"
                checked={enrolled}
                onChange={(e) => setEnrolled(e.target.checked)}
                className="h-4 w-4 flex-none accent-neon"
              />
              <span className="text-sm text-ink">
                {enrolled ? "Enrolled on a terminal" : "Not enrolled yet"}
              </span>
            </label>
            {!isAdd && employee ? (
              <Link
                href={`/employees/${employee.id}/fingerprints`}
                className="mt-2 inline-flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-neon uppercase transition hover:text-white"
              >
                ✋ Manage all five fingerprints →
              </Link>
            ) : (
              <p className="mt-2 text-[11px] text-muted">
                After saving, capture all five fingerprints on the hand
                enrolment page — or use “Add &amp; Enrol Prints” below.
              </p>
            )}
          </div>
        </div>

        {formError ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.07] pt-4">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            Cancel
          </button>
          {isAdd ? (
            <button
              type="button"
              onClick={() => submit(null, true)}
              className="btn"
              disabled={saving}
              style={{ background: "#2d1b4e", color: "#ffffff" }}
            >
              {saving ? <span className="spinner" aria-hidden="true" /> : null}
              Add &amp; Enrol Prints
            </button>
          ) : null}
          <button type="submit" className="btn btn--neon" disabled={saving}>
            {saving ? <span className="spinner" aria-hidden="true" /> : null}
            {isAdd ? "Add Employee" : "Save Changes"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Delete confirmation                                                 */
/* ------------------------------------------------------------------ */

function EmployeeDeleteConfirm({
  employee,
  onClose,
  onDeleted,
}: {
  employee: EmployeeDirectoryEntry;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/employees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: employee.id }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
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
      title="Delete Employee"
      subtitle="This removes them from the bridge — their punch history goes too."
      onClose={onClose}
      width="max-w-md"
    >
      <div className="space-y-4 px-5 py-5">
        <div className="glass-inset rounded-xl p-4">
          <p className="text-sm font-semibold text-ink">{employee.fullName}</p>
          <p className="mt-1 font-mono text-xs text-muted">{employee.erpUserId}</p>
          <p className="mt-1 text-xs text-muted">
            {employee.department || "No department"} · {employee.position || "No position"}
          </p>
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Punches already captured stay in the attendance history and the ERP buffer — only
          this directory record and its enrolment are removed.
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
            Delete Employee
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function EmployeeDirectory() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [data, setData] = useState<EmployeeDirectoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by successful mutations so the roster re-fetches immediately. */
  const [nonce, setNonce] = useState(0);
  const [modal, setModal] = useState<ModalState | null>(null);
  /** Timesheet Report overlay (custom period → print / save as PDF). */
  const [reportOpen, setReportOpen] = useState(false);

  // /timesheets → /employees?focus=search: focus the search box once.
  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("focus") === "search"
    ) {
      inputRef.current?.focus();
    }
  }, []);

  // Debounce keystrokes before hitting the API (mirrors the dashboard
  // search bar's 250 ms cadence).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(
          `/api/employees?q=${encodeURIComponent(debounced)}`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as EmployeeDirectoryResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, nonce]);

  const employees = data?.employees ?? [];
  const searching = query.trim().length > 0;

  // Departments already present in the loaded roster — the edit/add modal
  // datalist source (pure derivation, safe to compute during render).
  const departments = Array.from(
    new Set(
      employees
        .map((e) => e.department.trim())
        .filter((d) => d.length > 0)
    )
  ).sort();

  /** Re-run the GET above after a successful mutation. */
  const refresh = () => setNonce((n) => n + 1);

  const open = (id: number) => router.push(`/employees/${id}`);

  /** Row-level clicks ignore anything originating from a row action button. */
  const fromButton = (ev: React.SyntheticEvent) =>
    ev.target instanceof Element && ev.target.closest("button") !== null;

  return (
    <div className="space-y-6">
      {/* Page header -------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            Employee Directory
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every employee enrolled in the bridge — search by name or ERP ID
            and open anyone&apos;s weekly timesheet.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="chip chip--muted">
            {searching
              ? `${employees.length} ${employees.length === 1 ? "MATCH" : "MATCHES"}`
              : `${employees.length} REGISTERED`}
          </span>
          <button
            type="button"
            className="btn btn--ghost px-3! py-2! text-[11px]! tracking-[0.14em]! uppercase"
            onClick={() => setReportOpen(true)}
          >
            <IconPrint className="h-4 w-4" />
            Timesheet Report
          </button>
          <button
            type="button"
            className="btn btn--neon"
            onClick={() => setModal({ mode: "add", employee: null })}
          >
            + Add Employee
          </button>
        </div>
      </div>

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Directory unavailable — {error}. Retrying…
        </p>
      ) : null}

      {/* Directory table ---------------------------------------------- */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />

        {/* Search bar --------------------------------------------------- */}
        <div className="border-b border-white/[0.06] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <IconSearch className="h-4 w-4 flex-none text-neon" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search for ID or Name"
              aria-label="Search for ID or Name"
              className="w-full bg-transparent text-sm text-ink placeholder:text-muted/70 focus:outline-none"
            />
          </div>
        </div>

        <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            All Employees
          </h2>
          <span className="hidden font-mono text-[10px] tracking-wider text-muted sm:inline">
            CLICK A ROW TO OPEN THE TIMESHEET
          </span>
        </header>

        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse">
            <thead className="tbl-head">
              <tr>
                <th>Employee ID</th>
                <th>Full Name</th>
                <th>Branch</th>
                <th>ERP User ID</th>
                <th>Department</th>
                <th>Position</th>
                <th>Status</th>
                <th>Fingerprint</th>
                <th>Last Seen</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && employees.length === 0 ? (
                [0, 1, 2, 3, 4].map((i) => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={10} className="h-[57px] bg-white/[0.03]" />
                  </tr>
                ))
              ) : employees.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-5 py-10 text-center">
                    <span className="text-sm text-muted">
                      {searching
                        ? `No employee matches “${query.trim()}”.`
                        : "No employees registered yet."}
                    </span>
                  </td>
                </tr>
              ) : (
                employees.map((e) => (
                  <tr
                    key={e.id}
                    className="tbl-row cursor-pointer transition-colors"
                    tabIndex={0}
                    title={`Open ${e.fullName}'s timesheet`}
                    onClick={(ev) => {
                      if (fromButton(ev)) return;
                      open(e.id);
                    }}
                    onKeyDown={(ev) => {
                      if (fromButton(ev)) return;
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        open(e.id);
                      }
                    }}
                  >
                    <td>
                      <span className="font-mono text-xs text-muted tabular-nums">
                        {e.id}
                      </span>
                    </td>
                    <td>
                      <span className="font-semibold text-ink">{e.fullName}</span>
                    </td>
                    <td>
                      {e.branch !== null ? (
                        <span className="text-xs font-medium text-ink">
                          {e.branch}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className="font-mono text-xs text-muted">
                        {e.erpUserId}
                      </span>
                    </td>
                    <td>
                      {e.department ? (
                        <span className="text-xs font-medium text-ink">
                          {e.department}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                    <td>
                      {e.position ? (
                        <span className="text-xs font-medium text-ink">
                          {e.position}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`chip ${
                          e.status === "Active" ? "chip--neon" : "chip--muted"
                        }`}
                      >
                        {e.status || "—"}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`text-sm font-bold ${
                          e.enrolled ? "text-neon" : "text-danger"
                        }`}
                        title={
                          e.enrolled
                            ? `${e.fingers.length} of 5 fingerprints enrolled`
                            : "No fingerprint enrolled"
                        }
                      >
                        {e.enrolled ? `✓ ${e.fingers.length}/5` : "✗"}
                      </span>
                      <span className="sr-only">
                        {e.enrolled
                          ? `${e.fingers.length} of 5 fingerprints enrolled`
                          : "Not enrolled"}
                      </span>
                    </td>
                    <td>
                      {e.lastSeen !== null ? (
                        <>
                          <span
                            className="font-mono text-xs text-ink"
                            title={new Date(e.lastSeen).toString()}
                          >
                            {formatRelative(e.lastSeen)}
                          </span>
                          <span className="ml-2 hidden font-mono text-[10px] text-muted/70 xl:inline">
                            {formatDateTime(e.lastSeen)}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono text-xs text-muted">
                          — never —
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          aria-label={`View ${e.fullName}`}
                          title="View timesheet"
                          className="rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-muted transition hover:border-neon/40 hover:text-neon"
                          onClick={() => open(e.id)}
                        >
                          <IconEye className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Enrol fingerprints for ${e.fullName}`}
                          title="Fingerprint enrolment — hand map"
                          className="rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-muted transition hover:border-neon/40 hover:text-neon"
                          onClick={() => router.push(`/employees/${e.id}/fingerprints`)}
                        >
                          <IconFingerprint className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Edit ${e.fullName}`}
                          title="Edit employee"
                          className="rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-muted transition hover:border-neon/40 hover:text-neon"
                          onClick={() => setModal({ mode: "edit", employee: e })}
                        >
                          <IconEdit className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${e.fullName}`}
                          title="Delete employee"
                          className="rounded-lg border border-white/10 bg-white/[0.04] p-1.5 text-muted transition hover:border-danger/50 hover:text-danger"
                          onClick={() => setModal({ mode: "delete", employee: e })}
                        >
                          <IconTrash className="h-4 w-4" />
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

      {/* Modals ------------------------------------------------------ */}
      {modal?.mode === "add" || modal?.mode === "edit" ? (
        <EmployeeForm
          key={`${modal.mode}-${modal.employee?.id ?? "new"}`}
          mode={modal.mode}
          employee={modal.employee}
          departments={departments}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      ) : null}

      {modal?.mode === "delete" && modal.employee ? (
        <EmployeeDeleteConfirm
          key={`delete-${modal.employee.id}`}
          employee={modal.employee}
          onClose={() => setModal(null)}
          onDeleted={refresh}
        />
      ) : null}

      {reportOpen ? (
        <TimesheetReport
          query={query.trim()}
          scopeLabel={
            searching
              ? `Scoped to ${employees.length} ${employees.length === 1 ? "match" : "matches"} for “${query.trim()}”`
              : `All ${employees.length} employees`
          }
          onClose={() => setReportOpen(false)}
        />
      ) : null}
    </div>
  );
}
