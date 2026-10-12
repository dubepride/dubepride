"use client";

/**
 * ============================================================================
 *  Access Control panels (Phase 13) — the three relational Settings tabs:
 *  Branches · Access Level Matrix · System Accounts
 * ============================================================================
 *
 *  BranchesTab        CRUD against the Branches table (add / rename /
 *                     delete). Deleting a site falls employees + terminals
 *                     back to "Unassigned".
 *
 *  AccessLevelsTab    "+ Add Access Level" + the Matrix: each level expands
 *                     into an accordion showing every system function
 *                     grouped by module, with checkboxes. "Save matrix"
 *                     PATCHes the full permissions object.
 *
 *  SystemAccountsTab  one unified "Add / Edit System Account" form (name /
 *                     surname / company email / password + confirm) with
 *                     access level + branch dropdowns fetched from their
 *                     tables, plus an optional linked employee (drives the My
 *                     Portal worker demo). Clicking a table row loads that
 *                     account into the form for editing — no modal, no
 *                     per-row password control. The table lists every account
 *                     with its level + branch.
 *
 *  Every panel fetches its data on mount and re-fetches after each CRUD
 *  call so the views always mirror the SQLite tables.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  PERMISSION_GROUPS,
  type PermissionKey,
  type PermissionsMap,
} from "@/lib/rbac";
import type {
  AccessLevelDto,
  AccessLevelsResponse,
  BranchesResponse,
  BranchDto,
  EmployeeDirectoryEntry,
  SystemAccountDto,
  SystemAccountsResponse,
} from "@/lib/types";
import { IconCheck, IconChevronDown, IconEdit, IconPlus } from "./icons";

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";
const ROW_ACTION =
  "rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] uppercase transition hover:border-white/25 hover:text-ink";
/** Minimum login password length enforced by the API (db.createSystemAccount). */
const MIN_PASSWORD = 6;

/** Glass panel shell shared by the three access-control tabs. */
function SlatePanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
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
    </section>
  );
}

/** Inline "delete → confirm" two-step so nothing is ever removed on one click. */
function ConfirmDelete({
  label,
  onConfirm,
  busy,
}: {
  label: string;
  onConfirm: () => void;
  busy: boolean;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (armed) onConfirm();
        else setArmed(true);
      }}
      onBlur={() => setArmed(false)}
      className={`rounded-lg border px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] uppercase transition ${
        armed
          ? "border-danger/60 bg-danger/15 text-danger"
          : "border-white/10 bg-white/[0.04] text-muted hover:border-danger/40 hover:text-danger"
      }`}
    >
      {busy ? "Deleting…" : armed ? `Confirm · ${label}` : "Delete"}
    </button>
  );
}

/* ================================================================== */
/* Tab 1 — Branches                                                    */
/* ================================================================== */

export function BranchesTab() {
  const [branches, setBranches] = useState<BranchDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/branches", { cache: "no-store" });
      const json = (await res.json()) as BranchesResponse;
      if (res.ok && json.branches) setBranches(json.branches);
      else setError(json && "error" in json ? String((json as { error?: string }).error ?? "") : "Could not load branches.");
    } catch {
      setError("Could not reach the branch list.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  async function addBranch() {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not add the branch.");
        return;
      }
      setNewName("");
      await load();
    } catch {
      setError("Could not add the branch.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <SlatePanel
      title="Branches"
      subtitle="The global site list — Employees & Terminals select branches from here."
    >
      {/* Add branch ------------------------------------------------- */}
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void addBranch();
        }}
        className="flex gap-2"
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New branch name, e.g. Branch 18"
          className={INPUT}
          aria-label="New branch name"
          autoComplete="off"
        />
        <button type="submit" disabled={adding || newName.trim().length === 0} className="btn btn--neon flex-none">
          <IconPlus className="h-4 w-4" />
          Add Branch
        </button>
      </form>

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          ✕ {error}
        </p>
      ) : null}

      {/* Branch list ------------------------------------------------- */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <span className="spinner" /> Loading branches…
        </div>
      ) : branches.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-muted">
          No branches yet — add the first site above.
        </p>
      ) : (
        <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-xl border border-white/[0.08]">
          {branches.map((b) => (
            <BranchRow key={b.id} branch={b} onChanged={load} />
          ))}
        </ul>
      )}
    </SlatePanel>
  );
}

/** One branch row: identity + headcounts + inline rename / confirm-delete. */
function BranchRow({ branch, onChanged }: { branch: BranchDto; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(branch.name);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function saveRename() {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/settings/branches/${branch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setRowError(json.error ?? "Could not rename the branch.");
        return;
      }
      setRenaming(false);
      onChanged();
    } catch {
      setRowError("Could not rename the branch.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/settings/branches/${branch.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        setRowError(json.error ?? "Could not delete the branch.");
        return;
      }
      onChanged();
    } catch {
      setRowError("Could not delete the branch.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="bg-white/[0.02] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{branch.name}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            {branch.employeeCount} employee{branch.employeeCount === 1 ? "" : "s"} ·{" "}
            {branch.terminalCount} terminal{branch.terminalCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {renaming ? (
            <button
              type="button"
              className="rounded-lg border border-neon/40 bg-neon/10 px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] text-neon uppercase transition hover:bg-neon/20"
              onClick={() => void saveRename()}
              disabled={busy}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          ) : (
            <button type="button" className={ROW_ACTION} onClick={() => setRenaming(true)}>
              Rename
            </button>
          )}
          <ConfirmDelete label="remove" onConfirm={() => void remove()} busy={busy} />
        </div>
      </div>
      {renaming ? (
        <div className="mt-3">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveRename();
              if (e.key === "Escape") {
                setValue(branch.name);
                setRenaming(false);
              }
            }}
            className={INPUT}
            aria-label={`Rename ${branch.name}`}
            autoFocus
          />
        </div>
      ) : null}
      {rowError ? <p className="mt-2 text-[11px] text-danger">✕ {rowError}</p> : null}
    </li>
  );
}

/* ================================================================== */
/* Tab 2 — Access Level Matrix                                         */
/* ================================================================== */

export function AccessLevelsTab() {
  const [levels, setLevels] = useState<AccessLevelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/access-levels", { cache: "no-store" });
      const json = (await res.json()) as AccessLevelsResponse;
      if (res.ok && json.levels) setLevels(json.levels);
      else setError("Could not load access levels.");
    } catch {
      setError("Could not reach the access level matrix.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  async function addLevel() {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/access-levels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not add the access level.");
        return;
      }
      setNewName("");
      await load();
    } catch {
      setError("Could not add the access level.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <SlatePanel
      title="Access Level Matrix"
      subtitle="Every capability an account inherits. Tick a level's matrix to grant — or revoke — access."
    >
      {/* Add level --------------------------------------------------- */}
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void addLevel();
        }}
        className="flex gap-2"
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New level name, e.g. Branch Supervisor"
          className={INPUT}
          aria-label="New access level name"
          autoComplete="off"
        />
        <button type="submit" disabled={adding || newName.trim().length === 0} className="btn btn--neon flex-none">
          <IconPlus className="h-4 w-4" />
          Add Access Level
        </button>
      </form>

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          ✕ {error}
        </p>
      ) : null}

      {/* Level accordions -------------------------------------------- */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <span className="spinner" /> Loading levels…
        </div>
      ) : levels.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-muted">
          No access levels yet — add the first one above.
        </p>
      ) : (
        <ul className="space-y-3">
          {levels.map((level) => {
            const expanded = level.id === expandedId;
            return (
              <li
                key={level.id}
                className={`overflow-hidden rounded-xl border transition-colors ${
                  expanded ? "border-neon/30 bg-neon/[0.04]" : "border-white/[0.08] bg-white/[0.02]"
                }`}
              >
                <LevelHeader
                  level={level}
                  expanded={expanded}
                  onToggle={() => setExpandedId(expanded ? null : level.id)}
                  onChanged={load}
                />
                {expanded ? <LevelMatrix levelId={level.id} onChanged={load} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </SlatePanel>
  );
}

/** Collapsed row: level identity + capability summary + expand / delete. */
function LevelHeader({
  level,
  expanded,
  onToggle,
  onChanged,
}: {
  level: AccessLevelDto;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/access-levels/${level.id}`, { method: "DELETE" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not delete the access level.");
        return;
      }
      onChanged();
    } catch {
      setError("Could not delete the access level.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="group flex min-w-0 items-center gap-3 text-left"
        >
          <IconChevronDown
            className={`h-4 w-4 flex-none text-muted transition-transform ${
              expanded ? "rotate-180 text-neon" : ""
            }`}
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-ink">{level.name}</span>
            <span className="block text-[11px] text-muted">
              {level.enabled} of {level.total} capabilities · {level.accountCount} account
              {level.accountCount === 1 ? "" : "s"}
            </span>
          </span>
        </button>
        <div className="flex flex-none items-center gap-2">
          <span className={`chip ${level.accountCount > 0 ? "chip--neon" : "chip--muted"}`}>
            {expanded ? "Editing matrix" : "Tap to expand matrix"}
          </span>
          <ConfirmDelete label="remove" onConfirm={() => void remove()} busy={busy} />
        </div>
      </div>
      {error ? <p className="px-4 pb-3 text-[11px] text-danger">✕ {error}</p> : null}
    </div>
  );
}

/** The expanded accordion: every system function grouped by module. */
function LevelMatrix({ levelId, onChanged }: { levelId: number; onChanged: () => void }) {
  return <LevelMatrixBody key={levelId} levelId={levelId} onChanged={onChanged} />;
}

function LevelMatrixBody({ levelId, onChanged }: { levelId: number; onChanged: () => void }) {
  const [draft, setDraft] = useState<PermissionsMap | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);

  // Load the level's current matrix the first time the accordion opens.
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/settings/access-levels/${levelId}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ level?: AccessLevelDto }>) : null))
      .then((json) => {
        if (cancelled || !json?.level) return;
        setDraft({ ...json.level.permissions });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [levelId]);

  useEffect(() => {
    return () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  function toggle(key: PermissionKey) {
    setDraft((prev) => (prev ? { ...prev, [key]: !prev[key] } : prev));
    setSaved(false);
  }

  async function saveMatrix() {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/access-levels/${levelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: draft }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not save the matrix.");
        return;
      }
      setSaved(true);
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 3500);
      onChanged();
    } catch {
      setError("Could not save the matrix.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-white/[0.07] px-4 py-4">
      {draft === null ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
          <span className="spinner" /> Loading matrix…
        </div>
      ) : (
        <div className="space-y-5">
          {PERMISSION_GROUPS.map((group) => (
            <div key={group.module}>
              <p className="mb-2 text-[10px] font-bold tracking-[0.22em] text-neon uppercase">
                {group.module}
              </p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {group.perms.map((perm) => (
                  <li key={perm.key}>
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 transition hover:border-white/15">
                      <input
                        type="checkbox"
                        checked={draft[perm.key] === true}
                        onChange={() => toggle(perm.key)}
                        className="h-4 w-4 accent-[#00E676]"
                      />
                      <span className="text-[12px] text-ink/90">{perm.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {error ? (
            <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">
              ✕ {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-4">
            {saved ? (
              <span className="chip chip--neon">
                <IconCheck className="h-3.5 w-3.5" /> Matrix saved
              </span>
            ) : (
              <span className="text-[11px] text-muted/70">
                Changes apply to every account holding this level — no re-login needed.
              </span>
            )}
            <button
              type="button"
              className="btn btn--neon ml-auto"
              onClick={() => void saveMatrix()}
              disabled={saving || draft === null}
            >
              {saving ? "Saving…" : "Save Matrix"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* Tab 3 — System Accounts                                             */
/* ================================================================== */

export function SystemAccountsTab() {
  const [accounts, setAccounts] = useState<SystemAccountDto[]>([]);
  const [levels, setLevels] = useState<{ id: number; name: string }[]>([]);
  const [branches, setBranches] = useState<{ id: number; name: string }[]>([]);
  const [employees, setEmployees] = useState<EmployeeDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Unified Add / Edit form state. `editingId === null` → Add mode.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [firstName, setFirstName] = useState("");
  const [surname, setSurname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accessLevelId, setAccessLevelId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  const isEditMode = editingId !== null;
  const selectedAccount = accounts.find((a) => a.id === editingId) ?? null;
  // The linked employee may be absent from the roster (e.g. no
  // can_view_employees) — keep a fallback option so an edit can't drop the link.
  const linkedEmployeeMissing =
    employeeId !== "" && !employees.some((em) => String(em.id) === employeeId);
  const linkedEmployeeName = selectedAccount?.employeeName ?? null;

  /** Re-fetch the directory; returns the fresh list so callers can re-sync. */
  const load = useCallback(async (): Promise<SystemAccountDto[]> => {
    try {
      const [res, empRes] = await Promise.all([
        fetch("/api/settings/accounts", { cache: "no-store" }),
        // The linked-employee dropdown is best-effort: accounts that lack
        // can_view_employees simply don't offer a roster link.
        fetch("/api/employees?q=", { cache: "no-store" }).catch(() => null),
      ]);
      const json = (await res.json()) as SystemAccountsResponse;
      let list: SystemAccountDto[] = [];
      if (res.ok && json.accounts) {
        list = json.accounts;
        setAccounts(list);
        setLevels(json.levels ?? []);
        setBranches(json.branches ?? []);
      } else {
        setError("Could not load system accounts.");
      }
      if (empRes && empRes.ok) {
        const empJson = (await empRes.json()) as { employees?: EmployeeDirectoryEntry[] };
        setEmployees(empJson.employees ?? []);
      }
      return list;
    } catch {
      setError("Could not reach the accounts directory.");
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  /** Return the form to Add mode and clear every field, including passwords. */
  function resetForm() {
    setEditingId(null);
    setFirstName("");
    setSurname("");
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setAccessLevelId("");
    setBranchId("");
    setEmployeeId("");
    setPasswordError(null);
  }

  /** Load one account into the form and switch to Edit mode. */
  function selectAccount(account: SystemAccountDto) {
    if (saving) return;
    // Clicking the row that is already open keeps the user's in-progress edits.
    if (editingId === account.id) return;
    setError(null);
    setNotice(null);
    setEditingId(account.id);
    setFirstName(account.firstName);
    setSurname(account.surname);
    setEmail(account.email);
    setAccessLevelId(account.accessLevelId != null ? String(account.accessLevelId) : "");
    setBranchId(account.branchId != null ? String(account.branchId) : "");
    setEmployeeId(account.employeeId != null ? String(account.employeeId) : "");
    // Password fields are *always* blank — stored hashes are never exposed.
    setPassword("");
    setConfirmPassword("");
    setPasswordError(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** Client-side password rules (the server re-validates regardless). */
  function validatePasswords(): string | null {
    const hasPassword = password.length > 0;
    const hasConfirm = confirmPassword.length > 0;
    if (!isEditMode) {
      if (!hasPassword) return "Password is required.";
      if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
      if (!hasConfirm) return "Please confirm the password.";
      if (password !== confirmPassword) return "Passwords do not match.";
      return null;
    }
    // Edit mode — blank in both fields means "keep the current password".
    if (!hasPassword && !hasConfirm) return null;
    if (!hasPassword) return "Enter a new password, or clear both fields to keep the current one.";
    if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
    if (!hasConfirm) return "Please confirm the new password.";
    if (password !== confirmPassword) return "Passwords do not match.";
    return null;
  }

  async function submitForm() {
    if (saving) return;
    const passwordIssue = validatePasswords();
    if (passwordIssue) {
      setPasswordError(passwordIssue);
      return;
    }
    setPasswordError(null);
    setSaving(true);
    setError(null);
    setNotice(null);

    const payload: Record<string, unknown> = {
      firstName,
      surname,
      email,
      accessLevelId: accessLevelId ? Number(accessLevelId) : null,
      branchId: branchId ? Number(branchId) : null,
      employeeId: employeeId ? Number(employeeId) : null,
    };
    // Only send a password when the user actually typed one — a blank field
    // must never overwrite the stored credential.
    if (password.length > 0) payload.password = password;

    try {
      if (isEditMode) {
        // Update the *selected* account by id — never creates a duplicate.
        const res = await fetch(`/api/settings/accounts/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!res.ok || !json.ok) {
          // Stay in Edit mode so nothing the user typed is lost.
          setError(json.error ?? "Could not save the account changes.");
          return;
        }
        setPassword("");
        setConfirmPassword("");
        setPasswordError(null);
        const list = await load();
        // Re-sync the form with the persisted (normalised) values.
        const fresh = list.find((a) => a.id === editingId);
        if (fresh) {
          setFirstName(fresh.firstName);
          setSurname(fresh.surname);
          setEmail(fresh.email);
          setAccessLevelId(fresh.accessLevelId != null ? String(fresh.accessLevelId) : "");
          setBranchId(fresh.branchId != null ? String(fresh.branchId) : "");
          setEmployeeId(fresh.employeeId != null ? String(fresh.employeeId) : "");
        }
        setNotice(`Saved changes to ${firstName} ${surname}`.trim() + ".");
      } else {
        const res = await fetch("/api/settings/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as { ok: boolean; error?: string };
        if (!res.ok || !json.ok) {
          setError(json.error ?? "Could not create the account.");
          return;
        }
        resetForm();
        await load();
        setNotice("System account created.");
      }
    } catch {
      setError(isEditMode ? "Could not save the account changes." : "Could not create the account.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SlatePanel
      title="System Accounts"
      subtitle="People who can sign in to BIOBRIDGE — each tied to an Access Level and a Branch."
    >
      {/* Unified Add / Edit form -------------------------------------- */}
      <form
        ref={formRef}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void submitForm();
        }}
        className="scroll-mt-6 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-xs font-bold tracking-[0.2em] text-neon uppercase">
            {isEditMode ? (
              <>
                <IconEdit className="h-4 w-4" /> Edit System Account
              </>
            ) : (
              <>
                <IconPlus className="h-4 w-4" /> Add System Account
              </>
            )}
          </p>
          {isEditMode ? (
            <span className="chip chip--neon">
              Editing · {firstName} {surname}
            </span>
          ) : null}
        </div>

        {/* Two-column layout: left = identity/level/password, right =
            surname/assignment/confirmation. Stacks on small screens. */}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Left — First Name */}
          <label className="block">
            <span className={LABEL}>First Name</span>
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className={INPUT}
              placeholder="e.g. Amina"
              autoComplete="off"
            />
          </label>

          {/* Right — Surname */}
          <label className="block">
            <span className={LABEL}>Surname</span>
            <input
              value={surname}
              onChange={(e) => setSurname(e.target.value)}
              className={INPUT}
              placeholder="e.g. Hassan"
              autoComplete="off"
            />
          </label>

          {/* Left — Company Email */}
          <label className="block">
            <span className={LABEL}>Company Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={INPUT}
              placeholder="a.hassan@biobridge.example"
              autoComplete="off"
            />
          </label>

          {/* Right — Branch */}
          <label className="block">
            <span className={LABEL}>Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={INPUT}>
              <option value="">Select branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          {/* Left — Access Level */}
          <label className="block">
            <span className={LABEL}>Access Level</span>
            <select
              value={accessLevelId}
              onChange={(e) => setAccessLevelId(e.target.value)}
              className={INPUT}
            >
              <option value="">Select level…</option>
              {levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>

          {/* Right — Linked Employee (optional) */}
          <label className="block">
            <span className={LABEL}>Linked Employee (optional — powers My Portal)</span>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={INPUT}>
              <option value="">No link</option>
              {linkedEmployeeMissing ? (
                <option value={employeeId}>{linkedEmployeeName ?? `Employee #${employeeId}`}</option>
              ) : null}
              {employees.map((em) => (
                <option key={em.id} value={em.id}>
                  {em.fullName} · {em.erpUserId}
                </option>
              ))}
            </select>
          </label>

          {/* Left — Password / New Password */}
          <label className="block">
            <span className={LABEL}>{isEditMode ? "New Password" : "Password"}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (passwordError) setPasswordError(null);
              }}
              className={INPUT}
              placeholder={isEditMode ? "Leave blank to keep current" : "Min. 6 characters"}
              autoComplete="new-password"
            />
          </label>

          {/* Right — Confirm Password / Confirm New Password */}
          <label className="block">
            <span className={LABEL}>{isEditMode ? "Confirm New Password" : "Confirm Password"}</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (passwordError) setPasswordError(null);
              }}
              className={INPUT}
              placeholder={isEditMode ? "Repeat new password" : "Repeat password"}
              autoComplete="new-password"
            />
          </label>
        </div>

        {isEditMode ? (
          <p className="mt-3 text-[11px] text-muted/70">
            Leave password fields blank to keep the current password.
          </p>
        ) : null}

        {passwordError ? (
          <p role="alert" className="mt-2 text-[11px] font-semibold text-danger">
            ✕ {passwordError}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {isEditMode ? (
            <button
              type="button"
              onClick={resetForm}
              disabled={saving}
              className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-[11px] font-bold tracking-[0.14em] text-muted uppercase transition hover:border-white/25 hover:text-ink disabled:opacity-40"
            >
              Cancel Edit
            </button>
          ) : null}
          <button type="submit" disabled={saving} className="btn btn--neon">
            {isEditMode ? (
              <>
                <IconCheck className="h-4 w-4" />
                {saving ? "Saving…" : "Save Changes"}
              </>
            ) : (
              <>
                <IconPlus className="h-4 w-4" />
                {saving ? "Creating…" : "Add Account"}
              </>
            )}
          </button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          ✕ {error}
        </p>
      ) : null}

      {notice ? (
        <p className="rounded-xl border border-neon/40 bg-neon/10 px-4 py-2.5 text-sm text-neon">
          <IconCheck className="mr-1 inline h-4 w-4" />
          {notice}
        </p>
      ) : null}

      {/* Accounts table ----------------------------------------------- */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <span className="spinner" /> Loading accounts…
        </div>
      ) : accounts.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-muted">
          No system accounts yet — create the first one above.
        </p>
      ) : (
        <div className="scroll-thin overflow-x-auto rounded-xl border border-white/[0.08]">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] bg-white/[0.03] text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Company Email</th>
                <th className="px-4 py-2.5">Access Level</th>
                <th className="px-4 py-2.5">Branch</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {accounts.map((a) => (
                <AccountRow
                  key={a.id}
                  account={a}
                  selected={a.id === editingId}
                  onSelect={() => selectAccount(a)}
                  onDeleted={(id) => {
                    if (id === editingId) resetForm();
                    setNotice("Account removed.");
                    void load();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SlatePanel>
  );
}

/** One account row — clicking it loads the account into the form above. */
function AccountRow({
  account,
  selected,
  onSelect,
  onDeleted,
}: {
  account: SystemAccountDto;
  selected: boolean;
  onSelect: () => void;
  onDeleted: (id: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/settings/accounts/${account.id}`, { method: "DELETE" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setRowError(json.error ?? "Could not delete the account.");
        return;
      }
      onDeleted(account.id);
    } catch {
      setRowError("Could not delete the account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`cursor-pointer outline-none transition focus-visible:bg-white/[0.05] ${
        selected ? "bg-neon/[0.08] hover:bg-neon/[0.1]" : "bg-white/[0.01] hover:bg-white/[0.04]"
      }`}
    >
      <td className={`px-4 py-3 ${selected ? "border-l-2 border-neon" : ""}`}>
        <span className="block font-semibold text-ink">{account.name}</span>
        {account.employeeName ? (
          <span className="block text-[11px] text-muted">Linked: {account.employeeName}</span>
        ) : null}
      </td>
      <td className="px-4 py-3 font-mono text-[12px] text-ink/90">{account.email}</td>
      <td className="px-4 py-3">
        <span className={`chip ${account.levelName ? "chip--neon" : "chip--warn"}`}>
          {account.levelName ?? "No level"}
        </span>
      </td>
      <td className="px-4 py-3 text-[12px] text-ink/80">{account.branchName ?? "Unassigned"}</td>
      <td className="px-4 py-3 text-right align-top">
        {/* stopPropagation keeps Delete independent of the row-select click. */}
        <div
          className="flex items-center justify-end gap-2"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {selected ? <span className="chip chip--neon">Editing</span> : null}
          <ConfirmDelete label="remove" onConfirm={() => void remove()} busy={busy} />
        </div>
        {rowError ? <p className="mt-1 text-[11px] text-danger">✕ {rowError}</p> : null}
      </td>
    </tr>
  );
}