"use client";

import { useEffect, useMemo, useState } from "react";
import { formatRelative } from "@/lib/format";
import type { TerminalDto, TerminalsResponse } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import MetricCard from "./MetricCard";
import { IconClock, IconScan, IconServer, IconX } from "./icons";

/**
 * ============================================================================
 *  Clocking Devices — branch-first device console (Phase 10)
 * ============================================================================
 *
 *  The 17 branches are the top-level rows; expanding one reveals that
 *  site's terminals with live status dots (neon = online, red = offline).
 *  Add / Edit-Move / Remove happen in glassmorphism modals that POST to
 *  /api/terminals, and the list is updated optimistically the moment a
 *  mutation succeeds — the 3s poll takes over again on the next tick.
 */

/** The company's 17 sites — always rendered, even when empty. */
const BRANCHES: string[] = Array.from({ length: 17 }, (_, i) => `Branch ${i + 1}`);

type ModalMode = "add" | "edit" | "remove";

interface ModalState {
  mode: ModalMode;
  device: TerminalDto | null;
}

/* ------------------------------------------------------------------ */
/* Modal shell — shared glassmorphism panel                            */
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
/* Add / Edit-Move form                                                */
/* ------------------------------------------------------------------ */

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

function DeviceForm({
  mode,
  device,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  device: TerminalDto | null;
  onClose: () => void;
  onSaved: (next: TerminalDto) => void;
}) {
  const [mac, setMac] = useState(device?.mac ?? "");
  const [ip, setIp] = useState(device?.ip ?? "");
  const [name, setName] = useState(device?.location ?? "");
  const [branch, setBranch] = useState(device?.branch || BRANCHES[0]);
  const [status, setStatus] = useState<"Online" | "Offline">(device?.status ?? "Offline");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isAdd = mode === "add";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!mac.trim() || !branch) {
      setFormError("Terminal MAC and branch are required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/terminals", {
        method: isAdd ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isAdd
            ? { mac, ip, location: name, branch, status }
            : { id: device?.id, mac, ip, location: name, branch, status }
        ),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; id?: number; error?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);

      onSaved({
        id: isAdd ? Number(json.id ?? 0) : Number(device?.id ?? 0),
        mac: mac.trim(),
        ip: ip.trim(),
        location: name.trim() || mac.trim(),
        branch,
        status,
        lastPing: status === "Online" ? Date.now() : (device?.lastPing ?? null),
        scansToday: device?.scansToday ?? 0,
      });
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={isAdd ? "Add Clocking Device" : "Edit / Move Device"}
      subtitle={
        isAdd
          ? "Register a new fingerprint terminal against one of the 17 branches."
          : `Editing ${device?.mac ?? ""} — change its identity, status or branch.`
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4 px-5 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="dev-mac">
              Terminal MAC
            </label>
            <input
              id="dev-mac"
              className={`${INPUT} font-mono`}
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              placeholder="A4:1F:72:0C:9B:31"
              autoComplete="off"
              required
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="dev-ip">
              IP Address
            </label>
            <input
              id="dev-ip"
              className={`${INPUT} font-mono`}
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.10.40"
              autoComplete="off"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="dev-name">
              Device Name
            </label>
            <input
              id="dev-name"
              className={INPUT}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main Gate — North Entrance"
              autoComplete="off"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="dev-branch">
              Branch
            </label>
            <select
              id="dev-branch"
              className={INPUT}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            >
              {BRANCHES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={LABEL} htmlFor="dev-status">
              Status
            </label>
            <select
              id="dev-status"
              className={INPUT}
              value={status}
              onChange={(e) => setStatus(e.target.value === "Online" ? "Online" : "Offline")}
            >
              <option value="Online">Online</option>
              <option value="Offline">Offline</option>
            </select>
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
          <button type="submit" className="btn btn--neon" disabled={saving}>
            {saving ? <span className="spinner" aria-hidden="true" /> : null}
            {isAdd ? "Add Device" : "Save Changes"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Remove confirmation                                                 */
/* ------------------------------------------------------------------ */

function RemoveConfirm({
  device,
  onClose,
  onRemoved,
}: {
  device: TerminalDto;
  onClose: () => void;
  onRemoved: (id: number) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/terminals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: device.id }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      onRemoved(device.id);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title="Remove Device"
      subtitle="This deregisters the terminal from its branch."
      onClose={onClose}
      width="max-w-md"
    >
      <div className="space-y-4 px-5 py-5">
        <div className="glass-inset rounded-xl p-4">
          <p className="text-sm font-semibold text-ink">{device.location}</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {device.mac} · {device.ip}
          </p>
          <p className="mt-1 text-xs text-muted">{device.branch || "Unassigned"}</p>
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Removing the device only affects this bridge — punches already captured stay in the
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
            Remove Device
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function ClockingDevices() {
  const { data, loading, error, refresh } = usePoll<TerminalsResponse>("/api/terminals", 3000);

  /**
   * Optimistic snapshot — written the instant a mutation succeeds so the
   * UI never waits for the next poll. Cleared as soon as a fresher
   * response lands (generatedAt comparison keeps an in-flight stale tick
   * from blanking the change).
   */
  const [override, setOverride] = useState<{ terminals: TerminalDto[]; generatedAt: number } | null>(
    null
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [BRANCHES[0]]: true });
  const [modal, setModal] = useState<ModalState | null>(null);

  /**
   * One source of truth for the visible list: the optimistic snapshot wins
   * until a poll response generated after the mutation arrives (compared
   * during render — no effect, so no extra render pass).
   */
  const terminals = useMemo(() => {
    if (override && (!data || data.generatedAt <= override.generatedAt)) return override.terminals;
    return data?.terminals ?? [];
  }, [data, override]);

  const groups = useMemo(() => {
    const map = new Map<string, TerminalDto[]>();
    for (const b of BRANCHES) map.set(b, []);
    for (const t of terminals) {
      const key = t.branch || "Unassigned";
      const bucket = map.get(key);
      if (bucket) bucket.push(t);
      else map.set(key, [t]);
    }
    // All 17 branches always render (even empty); any custom branch created
    // via Add is appended after them in insertion order.
    return [...map.entries()];
  }, [terminals]);

  const online = terminals.filter((t) => t.status === "Online").length;
  const offline = terminals.length - online;
  const scans = terminals.reduce((sum, t) => sum + t.scansToday, 0);

  /** Replace the visible list immediately after a successful mutation. */
  const applyNext = (mutate: (rows: TerminalDto[]) => TerminalDto[]) => {
    setOverride({ terminals: mutate(terminals), generatedAt: Date.now() });
    refresh();
  };

  const handleSaved = (next: TerminalDto) => {
    applyNext((rows) =>
      rows.some((r) => r.id === next.id)
        ? rows.map((r) => (r.id === next.id ? { ...r, ...next } : r))
        : [...rows, next]
    );
  };

  const handleRemoved = (id: number) => {
    applyNext((rows) => rows.filter((r) => r.id !== id));
  };

  const toggle = (branch: string) =>
    setExpanded((prev) => ({ ...prev, [branch]: !prev[branch] }));

  return (
    <div className="space-y-6">
      {/* Header ------------------------------------------------------ */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Clocking Devices</h1>
          <p className="mt-1 text-sm text-muted">
            Fingerprint terminals grouped by branch — add, edit/move or remove devices per site.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="chip chip--muted">Auto-refresh 3s</span>
          <button
            type="button"
            className="btn btn--neon"
            onClick={() => setModal({ mode: "add", device: null })}
          >
            + Add Device
          </button>
        </div>
      </div>

      {/* Metrics ----------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label="Devices Online"
          value={`${online}/${terminals.length}`}
          sub="reporting within heartbeat window"
          icon={<IconServer />}
          tone={terminals.length > 0 && online === terminals.length ? "neon" : "warn"}
          loading={loading && !data}
        />
        <MetricCard
          label="Devices Offline"
          value={offline}
          sub={offline > 0 ? "no heartbeat received" : "fleet fully reachable"}
          icon={<IconClock />}
          tone={offline > 0 ? "danger" : "neon"}
          loading={loading && !data}
        />
        <MetricCard
          label="Scans Today"
          value={scans}
          sub="captured across all branches"
          icon={<IconScan />}
          tone="neon"
          loading={loading && !data}
        />
      </div>

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Device registry unavailable — {error}. Retrying…
        </p>
      ) : null}

      {/* Branch accordion -------------------------------------------- */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Devices by Branch
          </h2>
          <span className="font-mono text-[11px] tracking-wider text-muted">
            {BRANCHES.length} BRANCHES · {terminals.length} DEVICES
          </span>
        </header>

        <div className="divide-y divide-white/[0.05]">
          {groups.map(([branch, rows]) => {
            const open = !!expanded[branch];
            const branchOnline = rows.filter((r) => r.status === "Online").length;
            const summary =
              rows.length === 0
                ? "No devices registered"
                : `${rows.length} Device${rows.length === 1 ? "" : "s"} · ${branchOnline} Online`;

            return (
              <div key={branch}>
                {/* Branch row ------------------------------------------- */}
                <button
                  type="button"
                  onClick={() => toggle(branch)}
                  aria-expanded={open}
                  className={`flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03] ${
                    open ? "bg-white/[0.02]" : ""
                  }`}
                >
                  <span
                    className={`grid h-6 w-6 flex-none place-items-center rounded-md border border-white/10 bg-white/[0.04] text-[10px] text-muted transition-transform duration-200 ${
                      open ? "rotate-90 border-neon/40 text-neon" : ""
                    }`}
                    aria-hidden="true"
                  >
                    ▸
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{branch}</span>
                    <span className="block truncate text-[11px] text-muted">{summary}</span>
                  </span>

                  <span className="hidden items-center gap-2 sm:flex">
                    <span
                      className={`status-dot ${
                        rows.length > 0 && branchOnline === rows.length
                          ? "status-dot--on"
                          : branchOnline > 0
                            ? "status-dot--warn"
                            : "status-dot--off"
                      }`}
                    />
                    <span className="font-mono text-[11px] text-muted">
                      {branchOnline}/{rows.length}
                    </span>
                  </span>
                </button>

                {/* Device table ---------------------------------------- */}
                {open ? (
                  <div className="border-t border-white/[0.05] bg-black/25">
                    {rows.length === 0 ? (
                      <p className="px-5 py-6 text-center text-xs text-muted">
                        This branch has no clocking device yet — use{" "}
                        <span className="text-neon">+ Add Device</span> to register one.
                      </p>
                    ) : (
                      <div className="scroll-thin overflow-x-auto">
                        <table className="w-full min-w-[760px] border-collapse">
                          <thead className="tbl-head">
                            <tr>
                              <th>Status</th>
                              <th>Device Name</th>
                              <th>Terminal MAC</th>
                              <th>IP Address</th>
                              <th>Last Ping</th>
                              <th className="text-right">Scans</th>
                              <th className="text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((d) => {
                              const isOn = d.status === "Online";
                              return (
                                <tr key={d.id} className="tbl-row transition-colors">
                                  <td>
                                    <span
                                      className={`chip ${isOn ? "chip--neon" : "chip--danger"}`}
                                    >
                                      <span
                                        className={`status-dot ${
                                          isOn ? "status-dot--on" : "status-dot--off"
                                        }`}
                                      />
                                      {d.status}
                                    </span>
                                  </td>
                                  <td className="font-semibold text-ink">{d.location}</td>
                                  <td className="font-mono text-muted">{d.mac}</td>
                                  <td className="font-mono text-muted">{d.ip || "—"}</td>
                                  <td className="font-mono text-xs text-muted">
                                    {isOn ? formatRelative(d.lastPing) : "— offline —"}
                                  </td>
                                  <td className="text-right font-mono text-ink tabular-nums">
                                    {d.scansToday}
                                  </td>
                                  <td>
                                    <div className="flex items-center justify-end gap-2">
                                      <button
                                        type="button"
                                        className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-muted transition hover:border-neon/40 hover:text-neon"
                                        onClick={() => setModal({ mode: "edit", device: d })}
                                      >
                                        Edit / Move
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-muted transition hover:border-danger/50 hover:text-danger"
                                        onClick={() => setModal({ mode: "remove", device: d })}
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* Modals ------------------------------------------------------ */}
      {modal?.mode === "add" || modal?.mode === "edit" ? (
        <DeviceForm
          key={`${modal.mode}-${modal.device?.id ?? "new"}`}
          mode={modal.mode}
          device={modal.device}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      ) : null}

      {modal?.mode === "remove" && modal.device ? (
        <RemoveConfirm
          key={`remove-${modal.device.id}`}
          device={modal.device}
          onClose={() => setModal(null)}
          onRemoved={handleRemoved}
        />
      ) : null}
    </div>
  );
}
