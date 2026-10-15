"use client";

/**
 * ============================================================================
 *  GeofenceActivity — the mobile-GPS reporting card (Phase 18 / spec Phase 9)
 * ============================================================================
 *
 *  Sits on Attendance Records beside the day-grouped log and answers the
 *  questions an admin actually asks about hands-free clocking:
 *
 *    • how much of our traffic is GPS vs biometric?  (source comparison)
 *    • which punches were accepted, which were rejected as exceptions?
 *    • for a given branch / date range / employee, where and how far away?
 *
 *  Filters (date range, branch, verdict, employee) map 1:1 to
 *  GET /api/attendance/geofence-activity. The bridge re-validates nothing here
 *  — this is a read-only view over Attendance_Logs rows with
 *  Verify_Method = 'Geofence'.
 */

import { useEffect, useState } from "react";
import { dateKeyOf, formatTime12 } from "@/lib/format";
import type {
  EmployeeDirectoryResponse,
  GeofenceActivityResponse,
  GeofenceActivityRow,
} from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import { IconFilter } from "./icons";

/** Geofence data changes on a human timescale; poll gently. */
const POLL_MS = 15_000;

const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";
const FIELD =
  "w-full rounded-xl border border-white/10 bg-panel-deep px-3 py-2 text-xs text-ink outline-none transition focus:border-neon/50";

function verdictChip(row: GeofenceActivityRow) {
  return row.insideGeofence ? (
    <span className="chip chip--neon">Accepted</span>
  ) : (
    <span className="chip chip--danger">Rejected</span>
  );
}

function Stat({ label, value, tone = "ink" }: { label: string; value: string; tone?: "ink" | "neon" | "danger" }) {
  const color = tone === "neon" ? "text-neon" : tone === "danger" ? "text-danger" : "text-ink";
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
      <p className="text-[10px] font-bold tracking-[0.16em] text-muted uppercase">{label}</p>
      <p className={`mt-0.5 font-mono text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}

export default function GeofenceActivity() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [branch, setBranch] = useState("");
  const [verdict, setVerdict] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [page, setPage] = useState(1);

  const [employees, setEmployees] = useState<{ id: number; fullName: string; erpUserId: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/employees?q=", { cache: "no-store" });
        const json = (await res.json()) as EmployeeDirectoryResponse;
        if (!cancelled && Array.isArray(json.employees)) {
          setEmployees(json.employees.map((e) => ({ id: e.id, erpUserId: e.erpUserId, fullName: e.fullName })));
        }
      } catch {
        /* the directory is a filter convenience — its absence must not blank the report */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (branch) query.set("branch", branch);
  if (verdict) query.set("verdict", verdict);
  if (employeeId) query.set("employeeId", employeeId);
  query.set("page", String(page));
  query.set("pageSize", "25");

  const { data, loading, error } = usePoll<GeofenceActivityResponse>(
    `/api/attendance/geofence-activity?${query.toString()}`,
    POLL_MS
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  const current = data?.page ?? page;
  const accepted = data?.accepted ?? 0;
  const rejected = data?.rejected ?? 0;
  const biometric = data?.totalBiometric ?? 0;

  const reset = <T,>(setter: (v: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };
  const onFrom = reset(setFrom);
  const onTo = reset(setTo);
  const onBranch = reset(setBranch);
  const onVerdict = reset(setVerdict);
  const onEmployee = reset(setEmployeeId);

  return (
    <section className="glass rise relative overflow-hidden">
      <div className="accent-line" aria-hidden="true" />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <IconFilter className="h-4 w-4 flex-none text-neon" />
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">Mobile GPS Clocking</h2>
        </div>
        <span className="hidden font-mono text-[10px] tracking-wider text-muted sm:inline">
          GEOFENCE VALIDATION AUDIT
        </span>
      </header>

      {/* Source + verdict summary ------------------------------------ */}
      <div className="grid gap-3 border-b border-white/[0.07] px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
        <Stat label="Accepted (GPS)" value={String(accepted)} tone="neon" />
        <Stat label="Rejected / exceptions" value={String(rejected)} tone={rejected > 0 ? "danger" : "ink"} />
        <Stat label="GPS punches (window)" value={String(data?.totalGeofence ?? 0)} />
        <Stat label="Biometric / other" value={String(biometric)} />
      </div>

      {/* Filters ------------------------------------------------------ */}
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-3">
        <div className="sm:col-span-2 xl:col-span-1">
          <span className={LABEL}>Date range</span>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="date"
              aria-label="From date"
              className={`${FIELD} flex-1 min-w-[9.5rem] font-mono`}
              value={from}
              onChange={(e) => onFrom(e.target.value)}
            />
            <span className="text-muted">→</span>
            <input
              type="date"
              aria-label="To date"
              className={`${FIELD} flex-1 min-w-[9.5rem] font-mono`}
              value={to}
              onChange={(e) => onTo(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="geo-branch">
            Site
          </label>
          <select id="geo-branch" className={FIELD} value={branch} onChange={(e) => onBranch(e.target.value)}>
            <option value="">All Sites</option>
            {(data?.branches ?? []).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={LABEL} htmlFor="geo-verdict">
              Verdict
            </label>
            <select id="geo-verdict" className={FIELD} value={verdict} onChange={(e) => onVerdict(e.target.value)}>
              <option value="">All</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="geo-employee">
              Employee
            </label>
            <select id="geo-employee" className={FIELD} value={employeeId} onChange={(e) => onEmployee(e.target.value)}>
              <option value="">All</option>
              {employees.map((e) => (
                <option key={e.id} value={String(e.id)}>
                  {e.fullName}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Table -------------------------------------------------------- */}
      <div className="overflow-x-auto border-t border-white/[0.07]">
        {error ? (
          <p role="alert" className="px-4 py-6 text-center text-xs text-danger sm:px-5">
            Could not load GPS clocking activity.
          </p>
        ) : loading && rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted sm:px-5">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted sm:px-5">
            No GPS clocking activity for the selected filters.
          </p>
        ) : (
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.07] text-[10px] tracking-[0.18em] text-muted uppercase">
                <th className="px-4 py-2.5 font-bold sm:px-5">When</th>
                <th className="px-3 py-2.5 font-bold">Employee</th>
                <th className="px-3 py-2.5 font-bold">Site</th>
                <th className="px-3 py-2.5 font-bold">Dir</th>
                <th className="px-3 py-2.5 font-bold">Distance</th>
                <th className="px-3 py-2.5 font-bold">Accuracy</th>
                <th className="px-4 py-2.5 font-bold sm:px-5">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.logId} className="border-b border-white/[0.05] last:border-0">
                  <td className="px-4 py-3 font-mono text-xs whitespace-nowrap text-muted sm:px-5">
                    <span className="text-ink">{dateKeyOf(row.timestamp)}</span> {formatTime12(row.timestamp)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-ink">{row.employeeName}</span>
                    {row.erpUserId ? <span className="ml-1.5 font-mono text-[10px] text-muted">{row.erpUserId}</span> : null}
                  </td>
                  <td className="px-3 py-3 text-muted">{row.branch ?? "—"}</td>
                  <td className="px-3 py-3">
                    <span className={`chip ${row.direction === "IN" ? "chip--neon" : "chip--muted"}`}>
                      {row.direction}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-muted">
                    {row.distanceMeters != null ? `${row.distanceMeters} m` : "—"}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-muted">
                    {row.accuracyMeters != null ? `± ${row.accuracyMeters} m` : "—"}
                  </td>
                  <td className="px-4 py-3 sm:px-5">{verdictChip(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination --------------------------------------------------- */}
      {total > 0 ? (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] px-4 py-3 sm:px-5">
          <span className="text-[11px] text-muted">
            {total} record{total === 1 ? "" : "s"} · page {current} of {pages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={current <= 1}
            >
              Prev
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={current >= pages}
            >
              Next
            </button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}
