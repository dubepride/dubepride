"use client";

/**
 * FieldTrackerDirectory — the roster half of the Field Tracker page.
 *
 * Every tracked phone inside a fence appears here with its BioBridge employee
 * number FIRST (matches the map hover tooltip), then name, site, freshness and
 * clocked-in state. Clicking a row selects the pin on the map; the small
 * "Open" affordance jumps to the employee's timesheet.
 */

import Link from "next/link";
import type { FieldTrackerDevice } from "@/lib/types";
import { formatDistance, freshnessLabel, statusLabel } from "@/lib/field-tracker";

interface FieldTrackerDirectoryProps {
  devices: FieldTrackerDevice[];
  selectedId: number | null;
  onSelect: (device: FieldTrackerDevice) => void;
  /** Snapshot clock, so every row's freshness uses the same "now". */
  now: number;
  emptyMessage: string;
}

export default function FieldTrackerDirectory({
  devices,
  selectedId,
  onSelect,
  now,
  emptyMessage,
}: FieldTrackerDirectoryProps) {
  if (devices.length === 0) {
    return (
      <p className="px-5 py-12 text-center text-sm text-muted">{emptyMessage}</p>
    );
  }

  return (
    <div className="scroll-thin max-h-[60vh] overflow-y-auto">
      {devices.map((device) => {
        const selected = selectedId === device.employeeId;
        return (
          <div
            key={device.employeeId}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(device)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(device);
              }
            }}
            aria-pressed={selected}
            className={`flex cursor-pointer flex-wrap items-center gap-3 border-b border-white/[0.04] px-4 py-3 text-left transition-colors sm:px-5 ${
              selected ? "bg-neon/[0.08]" : "hover:bg-white/[0.04]"
            }`}
          >
            {/* Employee number is the primary identifier — always first. */}
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-sm font-extrabold tracking-wide text-neon">
                  {device.employeeNumber}
                </span>
                {device.clockedIn ? (
                  <span className="chip chip--neon">In</span>
                ) : (
                  <span className="chip chip--muted">Out</span>
                )}
                {device.status === "live" ? (
                  <span className="chip chip--neon">Live</span>
                ) : (
                  <span className="chip chip--muted">{statusLabel(device.status)}</span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-xs font-semibold text-ink">
                {device.fullName}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted">
                {device.branch?.trim() || "Outside every fence"}
                {device.department ? ` · ${device.department}` : ""}
                {device.deviceName ? ` · ${device.deviceName}` : ""}
              </span>
            </span>

            <span className="flex-none text-right">
              <span className="block font-mono text-[11px] text-muted tabular-nums">
                {freshnessLabel(device, now)}
              </span>
              <span className="mt-0.5 block font-mono text-[10px] text-muted/80 tabular-nums">
                {device.distanceMeters != null
                  ? `${formatDistance(device.distanceMeters)} from centre`
                  : device.insideFence
                    ? "Inside fence"
                    : "Off-site"}
              </span>
            </span>

            <Link
              href={`/employees/${device.employeeId}`}
              onClick={(event) => event.stopPropagation()}
              className="flex-none rounded-lg border border-white/10 px-2.5 py-1 text-[10px] font-bold tracking-wider text-muted uppercase transition-colors hover:border-neon/40 hover:text-neon"
            >
              Open
            </Link>
          </div>
        );
      })}
    </div>
  );
}
