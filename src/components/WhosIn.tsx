"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatPunchTime, formatRelative } from "@/lib/format";
import type { WhosInResponse } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import Avatar from "./Avatar";
import { IconSearch } from "./icons";

/**
 * Who's In (Phase 7, Objective 5) — live presence roster. GET
 * /api/whos-in lists every employee whose latest punch today is a Clock
 * In (no matching Clock Out yet); this view polls every 5 s, filters by
 * branch + free text, and groups the roster by Branch_Name (spec
 * constraint). Clicking a person opens their timesheet.
 */
export default function WhosIn() {
  const router = useRouter();
  const { data, error, loading } = usePoll<WhosInResponse>("/api/whos-in", 5000);
  const people = useMemo(() => data?.people ?? [], [data]);

  const [branch, setBranch] = useState("ALL");
  const [query, setQuery] = useState("");

  // Branch options come from whoever is actually inside right now.
  const branches = useMemo(
    () => [...new Set(people.map((p) => p.branchName ?? "Unassigned"))].sort(),
    [people]
  );

  const text = query.trim().toLowerCase();
  const visible = people.filter(
    (p) =>
      (branch === "ALL" || (p.branchName ?? "Unassigned") === branch) &&
      (text === "" ||
        p.fullName.toLowerCase().includes(text) ||
        p.erpUserId.toLowerCase().includes(text))
  );

  // Group by branch, alphabetical; newest clock-in first within a group
  // (the API already orders it that way).
  const groups = new Map<string, typeof visible>();
  for (const p of visible) {
    const key = p.branchName ?? "Unassigned";
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div className="space-y-6">
      {/* Page header -------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            Who&apos;s In
          </h1>
          <p className="mt-1 text-sm text-muted">
            Live presence — anyone with a Clock In today and no Clock Out yet,
            grouped by branch.
          </p>
        </div>
        <span className="chip chip--neon">{people.length} INSIDE</span>
      </div>

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Presence unavailable — {error}. Retrying…
        </p>
      ) : null}

      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />

        {/* Filters ----------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-5">
          <IconSearch className="h-4 w-4 flex-none text-neon" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for ID or Name"
            aria-label="Search for ID or Name"
            className="min-w-40 flex-1 bg-transparent text-sm text-ink placeholder:text-muted/70 focus:outline-none"
          />
          <select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            aria-label="Filter by branch"
            className="flex-none rounded-xl border border-white/10 bg-panel-deep px-3 py-2 text-[11px] font-bold tracking-wider text-ink uppercase focus:outline-none"
          >
            <option value="ALL">All branches</option>
            {branches.map((b) => (
              <option key={b} value={b} className="bg-panel-deep text-ink">
                {b}
              </option>
            ))}
          </select>
        </div>

        {/* Roster ------------------------------------------------------ */}
        <div className="scroll-thin max-h-[70vh] overflow-y-auto">
          {loading && !data ? (
            <div role="status" aria-live="polite">
              <span className="sr-only">Loading presence…</span>
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex animate-pulse items-center gap-3 border-b border-white/[0.04] px-5 py-3"
                >
                  <span className="h-9 w-9 flex-none rounded-full bg-white/10" />
                  <span className="flex-1 space-y-2">
                    <span className="block h-3 w-1/3 rounded bg-white/10" />
                    <span className="block h-2.5 w-1/4 rounded bg-white/[0.07]" />
                  </span>
                  <span className="h-5 w-16 flex-none rounded bg-white/10" />
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-muted">
              {people.length === 0
                ? "Nobody is clocked in right now."
                : "No employee matches this view."}
            </p>
          ) : (
            sortedGroups.map(([name, list]) => (
              <div key={name}>
                <div className="flex items-center justify-between border-b border-white/[0.07] bg-white/[0.03] px-5 py-2.5">
                  <span className="text-[10px] font-bold tracking-[0.2em] text-neon uppercase">
                    {name}
                  </span>
                  <span className="font-mono text-[10px] text-muted tabular-nums">
                    {list.length} INSIDE
                  </span>
                </div>
                {list.map((p) => (
                  <button
                    key={p.employeeId}
                    type="button"
                    onClick={() => router.push(`/employees/${p.employeeId}`)}
                    title={`Open ${p.fullName}'s timesheet`}
                    className="flex w-full items-center gap-3 border-b border-white/[0.04] px-5 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <Avatar name={p.fullName} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {p.fullName}
                      </span>
                      <span className="block truncate text-[11px] text-muted">
                        {p.erpUserId}
                        {p.department ? ` · ${p.department}` : ""}
                        {p.locationName ? ` · ${p.locationName}` : ""}
                      </span>
                    </span>
                    <span className="flex-none text-right">
                      <span className="block font-mono text-xs font-bold text-neon tabular-nums">
                        {formatPunchTime(p.clockedInAt)}
                      </span>
                      <span className="block text-[10px] text-muted">
                        {formatRelative(p.clockedInAt)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
