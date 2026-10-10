"use client";

/**
 * ============================================================================
 *  My Portal (Phase 14) — the worker's remote clocking hub
 * ============================================================================
 *
 *  Three permission-gated widgets, each driven by a live capability:
 *
 *    • Remote Clock In/Out  → can_remote_clock
 *    • Punch History        → can_view_my_history
 *    • Time-Off Request     → can_request_time_off
 *
 *  The whole page is also gated by can_view_my_portal (sidebar hides the
 *  link, proxy redirects the route) so a worker with only that capability
 *  sees a single-item rail and lands here after login.
 *
 *  Data is polled from GET /api/my-portal and refreshed after every
 *  clock/time-off action so the UI stays in sync with SQLite.
 */

import { useCallback, useEffect, useState } from "react";
import { formatClockTime, formatDate, formatDateString, formatRelative } from "@/lib/format";
import { useAuth } from "@/components/AuthProvider";
import type {
  MyPortalResponse,
  MyPortalHistoryResponse,
  MyPortalPunch,
  MyPortalClockResponse,
  MyPortalTimeOffResponse,
} from "@/lib/types";
import { IconCheck, IconClock, IconPlus, IconServer } from "./icons";

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

const POLL_MS = 10_000;
const HISTORY_POLL_MS = 30_000;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="glass rise relative overflow-hidden">
      <div className="accent-line" aria-hidden="true" />
      <header className="border-b border-white/[0.07] px-5 py-4">
        <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">{title}</h2>
      </header>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

function Tag({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`chip ${className}`}>{children}</span>;
}

export default function MyPortal() {
  const { permissions } = useAuth();
  const hasPortalAccess = permissions?.can_view_my_portal === true;

  // All hooks must be called unconditionally at the top level
  const [portal, setPortal] = useState<MyPortalResponse | null>(null);
  const [clockMsg, setClockMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<MyPortalPunch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [requests, setRequests] = useState<MyPortalTimeOffResponse["requests"]>([]);
  const [requestLoading, setRequestLoading] = useState(true);
  const [type, setType] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);

  // ---- Data fetching --------------------------------------------------

  const loadPortal = useCallback(async () => {
    try {
      const res = await fetch("/api/my-portal", { cache: "no-store" });
      const json = (await res.json()) as MyPortalResponse;
      if (res.ok && json.ok) setPortal(json);
    } catch {
      /* keep previous */
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/my-portal/history", { cache: "no-store" });
      const json = (await res.json()) as MyPortalHistoryResponse;
      if (res.ok && json.ok) setHistory(json.rows);
    } catch {
      /* keep previous */
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadRequests = useCallback(async () => {
    setRequestLoading(true);
    try {
      const res = await fetch("/api/my-portal/time-off", { cache: "no-store" });
      const json = (await res.json()) as MyPortalTimeOffResponse;
      if (res.ok && json.ok) setRequests(json.requests ?? []);
    } catch {
      /* keep previous */
    } finally {
      setRequestLoading(false);
    }
  }, []);

  // Initial load - only if we have portal access
  useEffect(() => {
    if (!hasPortalAccess) return;
    queueMicrotask(() => {
      void loadPortal();
      void loadHistory();
      void loadRequests();
    });
  }, [hasPortalAccess, loadPortal, loadHistory, loadRequests]);

  // Polling
  useEffect(() => {
    if (!hasPortalAccess) return;
    const id = window.setInterval(() => {
      queueMicrotask(() => void loadPortal());
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [hasPortalAccess, loadPortal]);

  useEffect(() => {
    if (!hasPortalAccess) return;
    const id = window.setInterval(() => queueMicrotask(() => void loadHistory()), HISTORY_POLL_MS);
    return () => window.clearInterval(id);
  }, [hasPortalAccess, loadHistory]);

  // ---- Actions --------------------------------------------------------

  async function clock() {
    try {
      const res = await fetch("/api/my-portal/clock", { method: "POST", cache: "no-store" });
      const json = (await res.json()) as MyPortalClockResponse;
      if (res.ok && json.ok) {
        setClockMsg(json.message);
        await loadPortal();
      } else {
        setClockMsg(json.error ?? "Could not clock.");
      }
    } catch {
      setClockMsg("Bridge unreachable.");
    }
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const res = await fetch("/api/my-portal/time-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, startDate, endDate, reason }),
      });
      const json = (await res.json()) as MyPortalTimeOffResponse;
      if (res.ok && json.ok) {
        setSubmitMsg(json.message);
        setType("");
        setStartDate("");
        setEndDate("");
        setReason("");
        await loadRequests();
      } else {
        setSubmitMsg(json.error ?? "Could not submit the request.");
      }
    } catch {
      setSubmitMsg("Bridge unreachable.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Render ---------------------------------------------------------

  if (!hasPortalAccess) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">My Portal</h1>
          <p className="mt-1 text-sm text-muted">Remote clocking hub — personal dashboard.</p>
        </div>
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-muted">
          This account does not have access to My Portal.
        </p>
      </div>
    );
  }

  const { account, employee, status } = portal ?? {
    account: { accountId: 0, name: "", email: "", levelName: "", branchName: null },
    employee: null,
    status: { clockedIn: false, lastPunchAt: null, lastDirection: null },
  };

  return (
    <div className="space-y-6">
      {/* Header -------------------------------------------------------- */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">My Portal</h1>
        <p className="mt-1 text-sm text-muted">Remote clocking hub — personal dashboard.</p>
      </div>

      {/* Identity card ------------------------------------------------- */}
      <Card title="Identity">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Account</p>
            <p className="mt-1 font-semibold text-ink">{account.name}</p>
            <p className="mt-0.5 text-[11px] font-mono text-muted">{account.email}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Access Level</p>
            <p className="mt-1">
              <Tag className="chip--neon">{account.levelName}</Tag>
            </p>
          </div>
          <div>
            <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Branch</p>
            <p className="mt-1 text-ink">{account.branchName ?? "Unassigned"}</p>
          </div>
        </div>
        {employee && (
          <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-4">
            <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Linked Roster Employee</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
              <div>
                <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Name</p>
                <p className="mt-0.5 font-semibold text-ink">{employee.fullName}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">ERP ID</p>
                <p className="mt-0.5 font-mono text-sm text-ink">{employee.erpUserId}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Department</p>
                <p className="mt-0.5 text-ink">{employee.department}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">Position</p>
                <p className="mt-0.5 text-ink">{employee.position}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Tag className={employee.enrolled ? "chip--neon" : "chip--warn"}>
                {employee.enrolled ? "Fingerprints enrolled" : "Not enrolled"}
              </Tag>
              {employee.branch && <Tag className="chip--muted">Branch: {employee.branch}</Tag>}
            </div>
          </div>
        )}
        {!employee && (
          <p className="mt-4 text-sm text-muted">
            No roster employee is linked to this account — ask a manager to link one
            in Settings → System Accounts to unlock remote clocking & history.
          </p>
        )}
      </Card>

      {/* Clock status badge ------------------------------------------- */}
      {employee && (
        <Card title="Today's Status">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3">
              <span
                className={`grid h-10 w-10 place-items-center rounded-xl border font-bold ${
                  status.clockedIn
                    ? "border-neon/40 bg-neon/10 text-neon shadow-[0_0_18px_rgba(0,230,118,0.25)]"
                    : "border-white/10 bg-white/[0.03] text-muted"
                }`}
              >
                {status.clockedIn ? <IconClock className="h-5 w-5" /> : <IconServer className="h-5 w-5" />}
              </span>
              <div>
                <p className="text-sm font-semibold text-ink">
                  {status.clockedIn ? "Currently clocked IN" : "Currently clocked OUT"}
                </p>
                {status.lastPunchAt ? (
                  <p className="mt-0.5 text-[11px] text-muted">
                    Last punch: {formatClockTime(status.lastPunchAt)} ·{" "}
                    {status.lastDirection === "IN" ? "IN" : "OUT"}
                    {formatRelative(status.lastPunchAt)}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-muted">No punches today.</p>
                )}
              </div>
            </div>

            {/* Remote Clock button (can_remote_clock) ----------------- */}
            {permissions.can_remote_clock && (
              <button
                type="button"
                className={`btn ${status.clockedIn ? "btn--ghost" : "btn--neon"}`}
                onClick={() => void clock()}
              >
                <IconClock className="h-4 w-4" />
                {status.clockedIn ? "Clock OUT" : "Clock IN"}
              </button>
            )}
          </div>
          {clockMsg && (
            <p className="mt-2 text-sm text-neon flex items-center gap-2">
              <IconCheck className="h-4 w-4" /> {clockMsg}
            </p>
          )}
        </Card>
      )}

      {/* Punch History (can_view_my_history) --------------------------- */}
      {permissions.can_view_my_history && (
        <Card title="My Punch History">
          {historyLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
              <span className="spinner" /> Loading history…
            </div>
          ) : history.length === 0 ? (
            <p className="text-center text-sm text-muted">No punches recorded yet.</p>
          ) : (
            <div className="scroll-thin overflow-x-auto rounded-xl border border-white/[0.08]">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/[0.08] bg-white/[0.03] text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
                    <th className="px-4 py-2.5">Date</th>
                    <th className="px-4 py-2.5">Time</th>
                    <th className="px-4 py-2.5">Direction</th>
                    <th className="px-4 py-2.5">Verify</th>
                    <th className="px-4 py-2.5">Sync</th>
                    <th className="px-4 py-2.5">Location</th>
                    <th className="px-4 py-2.5">Branch</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {history.map((p) => (
                    <tr key={p.logId} className="bg-white/[0.01] transition hover:bg-white/[0.04]">
                      <td className="px-4 py-2.5 text-[11px] text-ink/80">{formatDate(p.timestamp)}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-ink">{formatClockTime(p.timestamp)}</td>
                      <td className="px-4 py-2.5">
                        <Tag
                          className={
                            p.direction === "IN" ? "chip--neon" : "chip--muted"
                          }
                        >
                          {p.direction}
                        </Tag>
                      </td>
                      <td className="px-4 py-2.5">
                        <Tag
                          className={
                            p.verifyResult === "Verified" ? "chip--neon" : "chip--warn"
                          }
                        >
                          {p.verifyResult}
                        </Tag>
                      </td>
                      <td className="px-4 py-2.5">
                        <Tag
                          className={
                            p.syncStatus === "Success"
                              ? "chip--neon"
                              : p.syncStatus === "Failed"
                              ? "chip--warn"
                              : "chip--muted"
                          }
                        >
                          {p.syncStatus}
                        </Tag>
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-ink/80">{p.location ?? "—"}</td>
                      <td className="px-4 py-2.5 text-[11px] text-ink/80">{p.branch ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Time-Off Requests (can_request_time_off) --------------------- */}
      {permissions.can_request_time_off && (
        <Card title="Time-Off Requests">
          {/* Form */}
          <form onSubmit={(e) => submitRequest(e)} className="space-y-4">
            <p className="text-[10px] font-bold tracking-[0.18em] text-muted uppercase">New Request</p>
            <div className="grid gap-4 sm:grid-cols-4">
              <label className="block">
                <span className={LABEL}>Type</span>
                <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT}>
                  <option value="">Select type…</option>
                  <option value="Annual">Annual Leave</option>
                  <option value="Sick">Sick Leave</option>
                  <option value="Unpaid">Unpaid Leave</option>
                  <option value="Other">Other</option>
                </select>
              </label>
              <label className="block">
                <span className={LABEL}>Start Date</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className={INPUT}
                  min={new Date().toISOString().slice(0, 10)}
                />
              </label>
              <label className="block">
                <span className={LABEL}>End Date</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className={INPUT}
                  min={startDate || new Date().toISOString().slice(0, 10)}
                />
              </label>
            </div>
            <label className="block sm:col-span-4">
              <span className={LABEL}>Reason</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={`${INPUT} min-h-[80px] resize-y`}
                placeholder="Brief reason for the request…"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={submitting || !type || !startDate || !endDate}
                className="btn btn--neon"
              >
                <IconPlus className="h-4 w-4" />
                {submitting ? "Submitting…" : "Submit Request"}
              </button>
              {submitMsg && (
                <span className={`text-sm ${submitMsg.includes("unreachable") ? "text-danger" : "text-neon"}`}>
                  {submitMsg}
                </span>
              )}
            </div>
          </form>

          {/* Existing requests list */}
          <div className="mt-6">
            <p className="mb-3 text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
              Your Requests
            </p>
            {requestLoading ? (
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted">
                <span className="spinner" /> Loading requests…
              </div>
            ) : requests.length === 0 ? (
              <p className="text-center text-sm text-muted">No time-off requests yet.</p>
            ) : (
              <div className="scroll-thin overflow-x-auto rounded-xl border border-white/[0.08]">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-white/[0.03] text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5">Start</th>
                      <th className="px-4 py-2.5">End</th>
                      <th className="px-4 py-2.5">Status</th>
                      <th className="px-4 py-2.5">Reason</th>
                      <th className="px-4 py-2.5">Submitted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {requests.map((r) => (
                      <tr key={r.Request_ID} className="bg-white/[0.01] transition hover:bg-white/[0.04]">
                        <td className="px-4 py-2.5">
                          <Tag className="chip--neon">{r.Type}</Tag>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-ink">{formatDateString(r.Start_Date)}</td>
                        <td className="px-4 py-2.5 text-[11px] text-ink">{formatDateString(r.End_Date)}</td>
                        <td className="px-4 py-2.5">
                          <Tag
                            className={
                              r.Status === "Pending" ? "chip--muted" : r.Status === "Approved" ? "chip--neon" : "chip--warn"
                            }
                          >
                            {r.Status}
                          </Tag>
                        </td>
                        <td className="px-4 py-2.5 text-[11px] text-ink/80 truncate max-w-xs">{r.Reason || "—"}</td>
                        <td className="px-4 py-2.5 text-[11px] text-muted">
                          {formatRelative(r.Created_At)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* No-widgets state --------------------------------------------- */}
      {!permissions.can_remote_clock && !permissions.can_view_my_history && !permissions.can_request_time_off && (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-muted">
          This account has no My Portal widgets enabled. Ask an IT administrator to
          grant can_remote_clock, can_view_my_history or can_request_time_off in the
          Access Level Matrix.
        </p>
      )}
    </div>
  );
}