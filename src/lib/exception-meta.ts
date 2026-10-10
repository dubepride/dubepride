/**
 * Static metadata for the six dashboard exception buckets (Phase 4).
 *
 * Isomorphic by design: the server validates `?type=` query params against
 * EXCEPTION_TYPES/ALIASES and labels API responses with LABELS/RULES, while
 * the drill-down drawer imports the same constants so its header and
 * baseline text paint instantly — before the API round-trip resolves.
 *
 * Nothing here may depend on Date.now() / Math.random(): the widget's
 * first render must hydrate byte-identically on server and client.
 */

import type { ExceptionType } from "@/lib/types";

/** Canonical bucket ids, in widget display order. */
export const EXCEPTION_TYPES = [
  "arrived_early",
  "arrived_late",
  "left_early",
  "left_late",
  "no_show",
  "missing_punch",
] as const;

/** Box / drawer titles — exact wording from the redesign spec. */
export const EXCEPTION_LABELS: Record<ExceptionType, string> = {
  arrived_early: "Arrived Early",
  arrived_late: "Arrived Late",
  left_early: "Left Early",
  left_late: "Left Late",
  no_show: "No Show",
  missing_punch: "Missing Punch",
};

/** Baseline rule shown under the drawer title, per bucket. */
export const EXCEPTION_RULES: Record<ExceptionType, string> = {
  arrived_early: "First punch of the day before the 08:00 shift start.",
  arrived_late: "First punch of the day after the 08:00 shift start.",
  left_early:
    "Clock-out before the 17:00 knock-off window opens (bucket fills from 17:00).",
  left_late: "Clock-out after the 18:00 knock-off window closes.",
  no_show: "Enrolled employees with no verified punch today (counted from 08:00).",
  missing_punch: "A punch sequence missing its matching IN or OUT counterpart.",
};

/** Drawer copy when a bucket legitimately has no rows today. */
export const EXCEPTION_EMPTY: Record<ExceptionType, string> = {
  arrived_early: "Nobody clocked in before the 08:00 shift start today.",
  arrived_late: "Nobody clocked in after the 08:00 shift start today.",
  left_early: "No clock-outs recorded before the 17:00 knock-off window today.",
  left_late: "No clock-outs recorded after the 18:00 knock-off window today.",
  no_show: "Every enrolled employee has at least one verified punch today.",
  missing_punch: "Every punch sequence today has a matching IN and OUT.",
};

/** Short `?type=` aliases accepted by the API (e.g. `?type=early`). */
export const EXCEPTION_TYPE_ALIASES: Record<string, ExceptionType> = {
  early: "arrived_early",
  late: "arrived_late",
};

/** Normalise a raw `?type=` value: trim, lowercase, "-" → "_". */
export function normalizeExceptionTypeParam(raw: string): string {
  return raw.trim().toLowerCase().replace(/-/g, "_");
}
