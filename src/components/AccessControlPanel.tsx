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
 *  SystemAccountsTab  "+ Add System Account" form (name / surname / company
 *                     email / password) with access level + branch dropdowns
 *                     fetched from their tables, plus an optional linked
 *                     employee (drives the My Portal worker demo). The table
 *                     lists every account with its level + branch and a
 *                     "Set password" row action to rotate the login password.
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
import { IconCheck, IconChevronDown, IconPlus } from "./icons";

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";
const ROW_ACTION =
  "rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-bold tracking-[0.14em] uppercase transition hover:border-white/25 hover:text-ink";

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

  // Add-account form state
  const [firstName, setFirstName] = useState("");
  const [surname, setSurname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accessLevelId, setAccessLevelId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [res, empRes] = await Promise.all([
        fetch("/api/settings/accounts", { cache: "no-store" }),
        // The linked-employee dropdown is best-effort: accounts that lack
        // can_view_employees simply don't offer a roster link.
        fetch("/api/employees?q=", { cache: "no-store" }).catch(() => null),
      ]);
      const json = (await res.json()) as SystemAccountsResponse;
      if (res.ok && json.accounts) {
        setAccounts(json.accounts);
        setLevels(json.levels ?? []);
        setBranches(json.branches ?? []);
      } else {
        setError("Could not load system accounts.");
      }
      if (empRes && empRes.ok) {
        const empJson = (await empRes.json()) as { employees?: EmployeeDirectoryEntry[] };
        setEmployees(empJson.employees ?? []);
      }
    } catch {
      setError("Could not reach the accounts directory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  async function addAccount() {
    if (adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          surname,
          email,
          password,
          accessLevelId: accessLevelId ? Number(accessLevelId) : null,
          branchId: branchId ? Number(branchId) : null,
          employeeId: employeeId ? Number(employeeId) : null,
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not create the account.");
        return;
      }
      setFirstName("");
      setSurname("");
      setEmail("");
      setPassword("");
      setAccessLevelId("");
      setBranchId("");
      setEmployeeId("");
      await load();
    } catch {
      setError("Could not create the account.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <SlatePanel
      title="System Accounts"
      subtitle="People who can sign in to BIOBRIDGE — each tied to an Access Level and a Branch."
    >
      {/* Add-account form --------------------------------------------- */}
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void addAccount();
        }}
        className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
      >
        <p className="mb-4 flex items-center gap-2 text-xs font-bold tracking-[0.2em] text-neon uppercase">
          <IconPlus className="h-4 w-4" /> Add System Account
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
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
          <label className="block">
            <span className={LABEL}>Password</span>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={INPUT}
              placeholder="Min. 6 characters"
              autoComplete="new-password"
            />
          </label>
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
          <label className="block sm:col-span-2">
            <span className={LABEL}>Linked Employee (optional — powers My Portal)</span>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={INPUT}>
              <option value="">No link</option>
              {employees.map((em) => (
                <option key={em.id} value={em.id}>
                  {em.fullName} · {em.erpUserId}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={adding}
            className="btn btn--neon"
          >
            <IconPlus className="h-4 w-4" />
            {adding ? "Creating…" : "Add Account"}
          </button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          ✕ {error}
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
                <AccountRow key={a.id} account={a} onChanged={load} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SlatePanel>
  );
}

/** One account row in the System Accounts table. */
function AccountRow({ account, onChanged }: { account: SystemAccountDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<string | null>(null);

  // Inline "Set password" editor state.
  const [settingPassword, setSettingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setRowError(null);
    setRowNotice(null);
    try {
      const res = await fetch(`/api/settings/accounts/${account.id}`, { method: "DELETE" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setRowError(json.error ?? "Could not delete the account.");
        return;
      }
      onChanged();
    } catch {
      setRowError("Could not delete the account.");
    } finally {
      setBusy(false);
    }
  }

  function openPasswordEditor() {
    setRowError(null);
    setRowNotice(null);
    setNewPassword("");
    setSettingPassword(true);
  }

  function closePasswordEditor() {
    setSettingPassword(false);
    setNewPassword("");
  }

  async function savePassword() {
    if (savingPassword || busy) return;
    setRowError(null);
    setRowNotice(null);
    setSavingPassword(true);
    try {
      const res = await fetch(`/api/settings/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setRowError(json.error ?? "Could not update the password.");
        return;
      }
      setSettingPassword(false);
      setNewPassword("");
      setRowNotice(`Login password updated for ${account.name}.`);
    } catch {
      setRowError("Could not update the password.");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <tr className="bg-white/[0.01] transition hover:bg-white/[0.04]">
      <td className="px-4 py-3">
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
        {settingPassword ? (
          <div className="ml-auto flex w-[220px] flex-col items-stretch gap-1.5">
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void savePassword();
                if (e.key === "Escape") closePasswordEditor();
              }}
              placeholder="New password (min. 6)"
              autoComplete="new-password"
              autoFocus
              className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50"
            />
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                disabled={savingPassword || newPassword.length < 6}
                onClick={() => void savePassword()}
                className={`${ROW_ACTION} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {savingPassword ? "Saving…" : "Save"}
              </button>
              <button type="button" disabled={savingPassword} onClick={closePasswordEditor} className={ROW_ACTION}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1.5">
            <button type="button" onClick={openPasswordEditor} className={ROW_ACTION}>
              Set password
            </button>
            <ConfirmDelete label="remove" onConfirm={() => void remove()} busy={busy} />
          </div>
        )}
        {rowError ? <p className="mt-1 text-[11px] text-danger">{rowError}</p> : null}
        {rowNotice ? <p className="mt-1 text-[11px] text-neon">{rowNotice}</p> : null}
      </td>
    </tr>
  );
}