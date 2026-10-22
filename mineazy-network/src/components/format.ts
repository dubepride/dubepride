/**
 * ============================================================================
 *  format.ts — presentation helpers shared by every screen
 * ============================================================================
 *
 *  These are deliberately honest about the things that are easy to fake:
 *  a missing measurement renders as "Not measured", never as "0 bps", and a
 *  timestamp that does not exist renders as "—" rather than "1970".
 * ============================================================================
 */

/** Format an epoch timestamp as a local date + time. */
export function formatDateTime(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Format an epoch timestamp as a short time only. */
export function formatTime(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** "3 minutes ago" — the operator's mental model of freshness. */
export function timeAgo(value: number | null | undefined, now = Date.now()): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "never";
  const seconds = Math.max(0, Math.round((now - value) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** How long an incident has been open, in a compact form. */
export function durationSince(startedAt: number | null | undefined, now = Date.now()): string {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return "—";
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A byte count, or an honest dash when it was never measured. */
export function bytesLabel(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const sign = bytes < 0 ? "-" : "";
  return `${sign}${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** A number, or an honest dash. */
export function numLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}

/** Turn a snake_case / kebab-case token into a readable label. */
export function humanise(token: string): string {
  if (!token) return "";
  return token
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** Percentage, or a dash when it cannot be computed. */
export function percentLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

/**
 * Human bandwidth. Lives in lib/traffic.ts next to the rate maths it
 * describes, and is re-exported here so every screen formats numbers in one
 * place. A rate that was never measured reads "Unavailable" — never "0 bps".
 */
export { formatBandwidth } from "@/lib/traffic";
