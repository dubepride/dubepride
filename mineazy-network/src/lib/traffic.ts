/**
 * ============================================================================
 *  traffic.ts — turning interface counters into honest rates
 * ============================================================================
 *
 *  Rules that keep the numbers trustworthy:
 *
 *    • A rate is a DELTA over a measured window: (counter_now - counter_prev)
 *      ÷ elapsed seconds. A cumulative byte counter is never presented as a
 *      speed.
 *    • The first sample of a counter has no predecessor, so no rate exists
 *      yet — the sample is stored with Counter_Valid = 0 and the UI shows
 *      "Traffic unavailable (baseline pending)".
 *    • A counter that goes BACKWARDS means the device restarted, the
 *      interface was reset or a 32-bit counter wrapped. The delta is
 *      discarded (no implausible 40 Gbps spike) and the counter is
 *      re-baselined.
 *    • 64-bit counters (ifHCInOctets / ifHCOutOctets) are preferred when the
 *      device exposes them.
 */

import type { TrafficSample } from "./types";

/** A raw counter reading at a point in time. */
export interface CounterSnapshot {
  at: number;
  inBytes: number | null;
  outBytes: number | null;
  inPackets: number | null;
  outPackets: number | null;
  inErrors: number | null;
  outErrors: number | null;
}

/** The derived result of comparing two counter readings. */
export interface RateResult {
  inRateBps: number | null;
  outRateBps: number | null;
  inPps: number | null;
  outPps: number | null;
  inBytes: number | null;
  outBytes: number | null;
  inErrors: number | null;
  outErrors: number | null;
  windowSeconds: number | null;
  counterValid: boolean;
  reason: string;
}

/** A result meaning "no measurement is possible". */
export const NO_RATE: RateResult = {
  inRateBps: null,
  outRateBps: null,
  inPps: null,
  outPps: null,
  inBytes: null,
  outBytes: null,
  inErrors: null,
  outErrors: null,
  windowSeconds: null,
  counterValid: false,
  reason: "No measurement available.",
};

function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

/**
 * Compare two readings and derive the rates.
 *
 * `previous === null` means "first sample" — the counters are stored but no
 * rate is claimed yet.
 */
export function computeRates(
  previous: CounterSnapshot | null,
  current: CounterSnapshot
): RateResult {
  const base: RateResult = {
    inRateBps: null,
    outRateBps: null,
    inPps: null,
    outPps: null,
    inBytes: current.inBytes,
    outBytes: current.outBytes,
    inErrors: current.inErrors,
    outErrors: current.outErrors,
    windowSeconds: null,
    counterValid: false,
    reason: "",
  };

  if (!previous) {
    return { ...base, reason: "Baseline pending — the first counter reading has no predecessor yet." };
  }

  const elapsedSeconds = (current.at - previous.at) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return { ...base, reason: "Counter readings are not ordered in time." };
  }

  const inBytesDelta = delta(current.inBytes, previous.inBytes);
  const outBytesDelta = delta(current.outBytes, previous.outBytes);
  const inPacketsDelta = delta(current.inPackets, previous.inPackets);
  const outPacketsDelta = delta(current.outPackets, previous.outPackets);

  const reset =
    (inBytesDelta !== null && inBytesDelta < 0) || (outBytesDelta !== null && outBytesDelta < 0);
  if (reset) {
    return {
      ...base,
      windowSeconds: elapsedSeconds,
      reason: "Counter reset detected (device or interface restarted) — rate discarded, counter re-baselined.",
    };
  }

  const inRateBps = inBytesDelta === null ? null : (inBytesDelta * 8) / elapsedSeconds;
  const outRateBps = outBytesDelta === null ? null : (outBytesDelta * 8) / elapsedSeconds;
  const inPps = inPacketsDelta === null ? null : inPacketsDelta / elapsedSeconds;
  const outPps = outPacketsDelta === null ? null : outPacketsDelta / elapsedSeconds;

  const measured = inRateBps !== null || outRateBps !== null;
  return {
    inRateBps,
    outRateBps,
    inPps,
    outPps,
    inBytes: current.inBytes,
    outBytes: current.outBytes,
    inErrors: current.inErrors,
    outErrors: current.outErrors,
    windowSeconds: elapsedSeconds,
    counterValid: measured,
    reason: measured ? "" : "The device does not report traffic counters for this interface.",
  };
}

/** Build a TrafficSample row from a rate result. */
export function toSample(
  subjectType: "device" | "port",
  subjectId: number,
  result: RateResult,
  source: string
): TrafficSample {
  return {
    subjectType,
    subjectId,
    sampledAt: Date.now(),
    inBytes: result.inBytes,
    outBytes: result.outBytes,
    inRateBps: result.inRateBps,
    outRateBps: result.outRateBps,
    inPps: result.inPps,
    outPps: result.outPps,
    inErrors: result.inErrors,
    outErrors: result.outErrors,
    counterValid: result.counterValid,
    windowSeconds: result.windowSeconds,
    source,
  };
}

/** Utilisation of a link as a percentage of its negotiated capacity. */
export function utilisationPct(rateBps: number | null, speedBps: number | null): number | null {
  if (rateBps === null || !speedBps || speedBps <= 0) return null;
  return Math.min(100, (rateBps / speedBps) * 100);
}

/* ------------------------------------------------------------------ */
/* Formatting helpers shared by the API + UI                           */
/* ------------------------------------------------------------------ */

/** Human bandwidth (bits/second → "12.4 Mbps"). */
export function formatBandwidth(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "Unavailable";
  if (bps <= 0) return "0 bps";
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let value = bps;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Human byte count. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "Unavailable";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 2) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
