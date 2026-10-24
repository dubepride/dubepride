/**
 * ============================================================================
 *  health.ts — turning evidence into a device / connection state
 * ============================================================================
 *
 *  This module is the reason Mineazy Network can say *what kind* of problem
 *  it is looking at. It is a pure function over collected evidence, so it
 *  can be unit tested without a database and reused by the collector, the
 *  API and the tests.
 *
 *  The evaluation order matters. A device whose data is stale is STALE, not
 *  OFFLINE — otherwise a collector outage would look like a dead network.
 *  A link that is physically down is LINK_DOWN, not "the computer is off".
 *
 *  Nothing here invents data: every branch needs an observation, and the
 *  returned `reason` names the evidence that produced the state.
 */

import type { DeviceCategory, HealthState, Severity } from "./types";

/** Everything the evaluator needs to decide a device's state. */
export interface DeviceEvidence {
  /** Active monitoring configured? */
  monitoringEnabled: boolean;
  category: DeviceCategory;
  /** Consecutive failed probes. */
  consecutiveFailures: number;
  /** Consecutive successful probes. */
  consecutiveSuccesses: number;
  /** When the device last answered a probe. */
  lastSuccessAt: number | null;
  /** When the collector last recorded ANY observation for the device. */
  lastObservedAt: number | null;
  /** Failures required before declaring the device offline. */
  failureThreshold: number;
  /** Seconds after which an observation is considered stale. */
  staleAfterSeconds: number;
  /**
   * How often this device is polled, in seconds.
   *
   * The freshness threshold cannot be shorter than the poll interval — a
   * device that is only polled every 600s must not be called STALE just
   * because 300s have passed since its last reading. The effective
   * threshold is therefore the larger of the two.
   */
  pollIntervalSeconds?: number;
  /** Evaluation time (epoch ms). */
  now: number;
  /** A managed interface the device is reached through that reports "down". */
  managementLinkDown: string | null;
  /** Other managed interfaces reporting "down" (degradation, not failure). */
  downInterfaces: string[];
  /** External connectivity result: true = up, false = down, null = not checked. */
  internetUp: boolean | null;
  /** True when at least one managed interface reports traffic counters. */
  hasTrafficCounters: boolean;
  /**
   * The address is present in the monitoring host's neighbour table, with a
   * matching MAC.
   *
   * This is layer-2 proof of life. A device that answers ARP but not ICMP is
   * alive and filtering probes — calling it OFFLINE would send an operator to
   * a cabinet that is working. It is not enough evidence to call it ONLINE
   * either, so the state stays UNKNOWN.
   */
  presentOnSegment?: boolean;
  /** Seconds since the last non-zero counter movement (null when unknown). */
  noTrafficSeconds: number | null;
  /** Probe results to quote as evidence. */
  probeEvidence: string[];
}

/** The evaluation outcome. */
export interface HealthVerdict {
  state: HealthState;
  reason: string;
}

/**
 * Decide a device's state from the collected evidence.
 *
 * The order of the checks is deliberate — see the module header.
 */
export function evaluateDeviceHealth(evidence: DeviceEvidence): HealthVerdict {
  const quote = evidence.probeEvidence.length > 0 ? evidence.probeEvidence.join("; ") : "";

  if (!evidence.monitoringEnabled) {
    return {
      state: "UNMONITORED",
      reason: "The device is in the inventory but active monitoring has not been configured for it.",
    };
  }

  if (evidence.lastObservedAt === null) {
    return {
      state: "UNKNOWN",
      reason: "No observation has been recorded for this device yet.",
    };
  }

  const ageSeconds = (evidence.now - evidence.lastObservedAt) / 1000;
  const freshnessThreshold = effectiveFreshnessThreshold(evidence);
  if (ageSeconds > freshnessThreshold) {
    return {
      state: "STALE",
      reason: `The newest observation is ${Math.round(ageSeconds)}s old (freshness threshold ${freshnessThreshold}s). The monitoring collector may have stopped — this is not a confirmed network fault.`,
    };
  }

  if (evidence.consecutiveFailures >= evidence.failureThreshold) {
    if (evidence.presentOnSegment) {
      return {
        state: "UNKNOWN",
        reason: `Failed ${evidence.consecutiveFailures} reachability checks (threshold ${evidence.failureThreshold}), but the address is still present in the local neighbour table — the device is alive and probably filters ICMP. This is not a confirmed outage.${quote ? ` ${quote}` : ""}`,
      };
    }
    return {
      state: "OFFLINE",
      reason: `Failed ${evidence.consecutiveFailures} consecutive reachability checks (threshold ${evidence.failureThreshold}).${quote ? ` ${quote}` : ""}`,
    };
  }

  if (evidence.managementLinkDown) {
    return {
      state: "LINK_DOWN",
      reason: `The switch reports the interface carrying this device as down (${evidence.managementLinkDown}).${quote ? ` ${quote}` : ""}`,
    };
  }

  if (evidence.internetUp === false && isInternetBoundary(evidence.category)) {
    return {
      state: "NO_INTERNET",
      reason: `Local reachability is working but the configured external connectivity checks failed.${quote ? ` ${quote}` : ""}`,
    };
  }

  if (evidence.downInterfaces.length > 0) {
    return {
      state: "DEGRADED",
      reason: `Reachable, but ${evidence.downInterfaces.length} managed interface(s) report "down": ${evidence.downInterfaces.join(", ")}.${quote ? ` ${quote}` : ""}`,
    };
  }

  if (evidence.hasTrafficCounters && evidence.noTrafficSeconds !== null && evidence.noTrafficSeconds > 0) {
    return {
      state: "NO_TRAFFIC",
      reason: `Traffic counters are readable but no traffic was measured for ${Math.round(evidence.noTrafficSeconds)}s. The link is up but idle.`,
    };
  }

  if (evidence.consecutiveSuccesses >= 1) {
    return {
      state: "ONLINE",
      reason: quote || "The configured health checks are passing.",
    };
  }

  return {
    state: "UNKNOWN",
    reason: quote || "There is not yet enough evidence to determine the device state.",
  };
}

/** Devices that own the internet boundary (gateways, routers, ISP handoff). */
export function isInternetBoundary(category: DeviceCategory): boolean {
  return category === "gateway" || category === "router" || category === "internet";
}

/**
 * The freshness threshold that actually applies to a device.
 *
 * The configured threshold is a floor, not a ceiling: a device that is only
 * polled every 600 seconds cannot be stale just because 300 seconds have
 * passed. Waiting two full poll intervals keeps a slow device from being
 * declared STALE between its own polls, while still catching a collector
 * that has genuinely stopped.
 */
export function effectiveFreshnessThreshold(evidence: {
  staleAfterSeconds: number;
  pollIntervalSeconds?: number;
}): number {
  const interval = evidence.pollIntervalSeconds ?? 0;
  return Math.max(evidence.staleAfterSeconds, Math.round(interval * 2));
}

/**
 * The state of a physical link, derived from the interface counters a
 * managed switch reports.
 */
export function linkStateForPort(operState: string | null | undefined): "up" | "down" | "unknown" {
  if (!operState) return "unknown";
  const value = operState.toLowerCase();
  if (value === "up") return "up";
  if (value === "down" || value === "notpresent" || value === "lowerlayerdown") return "down";
  if (value === "testing" || value === "dormant") return "unknown";
  return "unknown";
}

/**
 * The state of a connection between two devices, from the ports at both
 * ends. A link is only "up" when both ends report up.
 */
export function connectionStateForPorts(
  localOperState: string | null | undefined,
  remoteOperState: string | null | undefined
): { state: "up" | "down" | "unknown"; evidence: string } {
  const local = linkStateForPort(localOperState);
  const remote = linkStateForPort(remoteOperState);

  if (local === "down" || remote === "down") {
    const side = local === "down" ? "local" : "remote";
    return {
      state: "down",
      evidence: `The ${side} interface reports operStatus "down" — the physical link is not up.`,
    };
  }
  if (local === "up" && remote === "up") {
    return { state: "up", evidence: "Both interfaces report operStatus \"up\"." };
  }
  return {
    state: "unknown",
    evidence:
      local === "unknown" && remote === "unknown"
        ? "Neither end reports an interface state — the link cannot be confirmed."
        : "One end reports the link up and the other has no state information.",
  };
}

/** The severity an incident should carry for a given device state. */
export function severityForState(state: HealthState): Severity {
  switch (state) {
    case "OFFLINE":
      return "critical";
    case "LINK_DOWN":
      return "critical";
    case "NO_INTERNET":
      return "major";
    case "DEGRADED":
      return "minor";
    case "STALE":
      return "minor";
    case "NO_TRAFFIC":
      return "info";
    default:
      return "info";
  }
}

/** A short, human explanation of every state (used in tooltips + legends). */
export const STATE_DESCRIPTIONS: Record<HealthState, string> = {
  ONLINE: "Reachable and the configured health checks are passing.",
  OFFLINE: "Failed the configured reachability checks for the required number of consecutive attempts.",
  DEGRADED: "Reachable, but one or more monitored interfaces or thresholds are failing.",
  LINK_DOWN: "A managed switch reports the physical or operational link as down.",
  NO_INTERNET: "Local networking works, but the configured external connectivity checks are failing.",
  NO_TRAFFIC: "Traffic counters are readable, but no new traffic was measured in the sampling window.",
  UNKNOWN: "There is not enough evidence to determine the current state.",
  UNMONITORED: "In the inventory, but active monitoring has not been configured.",
  STALE: "The newest monitoring information is older than the freshness threshold (or the collector stopped).",
};

/** Sort key so the worst states float to the top of a list. */
export const STATE_SEVERITY_ORDER: Record<HealthState, number> = {
  OFFLINE: 0,
  LINK_DOWN: 1,
  NO_INTERNET: 2,
  DEGRADED: 3,
  STALE: 4,
  NO_TRAFFIC: 5,
  UNKNOWN: 6,
  UNMONITORED: 7,
  ONLINE: 8,
};
