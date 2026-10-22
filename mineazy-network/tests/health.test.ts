/**
 * ============================================================================
 *  tests/health.test.ts — the health state machine
 * ============================================================================
 *
 *  The product promise is that distinct conditions stay distinct: a stale
 *  collector is not a dead network, a failed internet check is not a failed
 *  device, and a physical link failure is not "the computer is switched off".
 *
 *  These tests pin that behaviour down.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  evaluateDeviceHealth,
  isInternetBoundary,
  linkStateForPort,
  connectionStateForPorts,
  severityForState,
  STATE_DESCRIPTIONS,
  STATE_SEVERITY_ORDER,
  type DeviceEvidence,
} from "../src/lib/health";
import { HEALTH_STATES } from "../src/lib/types";

const NOW = 1_700_000_000_000;

/** A healthy baseline that individual tests break in exactly one way. */
function evidence(overrides: Partial<DeviceEvidence> = {}): DeviceEvidence {
  return {
    monitoringEnabled: true,
    category: "switch",
    consecutiveFailures: 0,
    consecutiveSuccesses: 1,
    lastSuccessAt: NOW - 1000,
    lastObservedAt: NOW - 1000,
    failureThreshold: 3,
    staleAfterSeconds: 300,
    now: NOW,
    managementLinkDown: null,
    downInterfaces: [],
    internetUp: null,
    hasTrafficCounters: false,
    noTrafficSeconds: null,
    probeEvidence: [],
    ...overrides,
  };
}

describe("evaluateDeviceHealth", () => {
  test("a device that answers its probes is ONLINE", () => {
    const verdict = evaluateDeviceHealth(evidence());
    assert.equal(verdict.state, "ONLINE");
    assert.ok(verdict.reason.length > 0, "a verdict always explains itself");
  });

  test("a device with monitoring switched off is UNMONITORED, not OFFLINE", () => {
    const verdict = evaluateDeviceHealth(
      evidence({ monitoringEnabled: false, consecutiveFailures: 99, lastObservedAt: null })
    );
    assert.equal(verdict.state, "UNMONITORED");
  });

  test("a device with no observation at all is UNKNOWN, not OFFLINE", () => {
    const verdict = evaluateDeviceHealth(evidence({ lastObservedAt: null, consecutiveFailures: 0 }));
    assert.equal(verdict.state, "UNKNOWN");
  });

  test("stale data wins over OFFLINE — a stopped collector is not a dead network", () => {
    const verdict = evaluateDeviceHealth(
      evidence({
        lastObservedAt: NOW - 3_600_000, // one hour old
        consecutiveFailures: 10,
        failureThreshold: 3,
      })
    );
    assert.equal(verdict.state, "STALE");
    assert.match(verdict.reason, /collector/i);
  });

  test("a slowly polled device is not STALE between its own polls", () => {
    // The device is polled every 600s, so at 400s since the last reading
    // nothing is wrong — it simply is not due yet. Calling it STALE would
    // report a fault that does not exist.
    const verdict = evaluateDeviceHealth(
      evidence({
        lastObservedAt: NOW - 400_000,
        pollIntervalSeconds: 600,
        staleAfterSeconds: 300,
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
      })
    );
    assert.equal(verdict.state, "ONLINE");
  });

  test("a slowly polled device still goes STALE when the collector really stops", () => {
    // Two full poll intervals have passed with no reading at all.
    const verdict = evaluateDeviceHealth(
      evidence({
        lastObservedAt: NOW - 1_200_001,
        pollIntervalSeconds: 600,
        staleAfterSeconds: 300,
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
      })
    );
    assert.equal(verdict.state, "STALE");
  });

  test("the freshness threshold never drops below the configured floor", () => {
    const verdict = evaluateDeviceHealth(
      evidence({
        lastObservedAt: NOW - 299_000,
        pollIntervalSeconds: 30,
        staleAfterSeconds: 300,
      })
    );
    assert.equal(verdict.state, "ONLINE");
  });

  test("OFFLINE needs the configured number of consecutive failures", () => {
    const below = evaluateDeviceHealth(
      evidence({ consecutiveFailures: 2, failureThreshold: 3, consecutiveSuccesses: 0 })
    );
    assert.notEqual(below.state, "OFFLINE");

    const at = evaluateDeviceHealth(
      evidence({ consecutiveFailures: 3, failureThreshold: 3, consecutiveSuccesses: 0 })
    );
    assert.equal(at.state, "OFFLINE");
  });

  test("a switch port reporting down makes the device LINK_DOWN, not OFFLINE", () => {
    const verdict = evaluateDeviceHealth(
      evidence({ managementLinkDown: "GigabitEthernet1/0/4", consecutiveFailures: 0 })
    );
    assert.equal(verdict.state, "LINK_DOWN");
    assert.match(verdict.reason, /GigabitEthernet1\/0\/4/);
  });

  test("other down interfaces degrade the device instead of failing it", () => {
    const verdict = evaluateDeviceHealth(
      evidence({ downInterfaces: ["GigabitEthernet1/0/9", "GigabitEthernet1/0/10"] })
    );
    assert.equal(verdict.state, "DEGRADED");
    assert.match(verdict.reason, /2 managed interface/);
  });

  test("a failed internet check only affects an internet-boundary device", () => {
    const gateway = evaluateDeviceHealth(evidence({ category: "gateway", internetUp: false }));
    assert.equal(gateway.state, "NO_INTERNET");

    const endpoint = evaluateDeviceHealth(evidence({ category: "desktop", internetUp: false }));
    assert.notEqual(endpoint.state, "NO_INTERNET");
    assert.equal(endpoint.state, "ONLINE");
  });

  test("NO_INTERNET outranks DEGRADED but not OFFLINE", () => {
    const verdict = evaluateDeviceHealth(
      evidence({ category: "router", internetUp: false, downInterfaces: ["eth1"] })
    );
    assert.equal(verdict.state, "NO_INTERNET");
  });

  test("a readable-but-idle link is NO_TRAFFIC, not OFFLINE", () => {
    const verdict = evaluateDeviceHealth(
      evidence({ hasTrafficCounters: true, noTrafficSeconds: 900 })
    );
    assert.equal(verdict.state, "NO_TRAFFIC");
  });

  test("a device that has never succeeded but has not failed enough is UNKNOWN", () => {
    const verdict = evaluateDeviceHealth(
      evidence({ consecutiveSuccesses: 0, consecutiveFailures: 1, failureThreshold: 3 })
    );
    assert.equal(verdict.state, "UNKNOWN");
  });

  test("probe evidence is quoted in the reason", () => {
    const verdict = evaluateDeviceHealth(
      evidence({ probeEvidence: ["icmp: no echo reply", "tcp/22: refused"] })
    );
    assert.match(verdict.reason, /no echo reply/);
    assert.match(verdict.reason, /tcp\/22/);
  });
});

describe("link state", () => {
  test("operStatus values map to up/down/unknown", () => {
    assert.equal(linkStateForPort("up"), "up");
    assert.equal(linkStateForPort("UP"), "up");
    assert.equal(linkStateForPort("down"), "down");
    assert.equal(linkStateForPort("lowerLayerDown"), "down");
    assert.equal(linkStateForPort("notPresent"), "down");
    assert.equal(linkStateForPort("testing"), "unknown");
    assert.equal(linkStateForPort(null), "unknown");
  });

  test("a link is only up when BOTH ends report up", () => {
    assert.equal(connectionStateForPorts("up", "up").state, "up");
    assert.equal(connectionStateForPorts("up", "down").state, "down");
    assert.equal(connectionStateForPorts("down", "up").state, "down");
    assert.equal(connectionStateForPorts("up", null).state, "unknown");
    assert.equal(connectionStateForPorts(null, null).state, "unknown");
  });

  test("the evidence names the side that is down", () => {
    assert.match(connectionStateForPorts("down", "up").evidence, /local interface/);
    assert.match(connectionStateForPorts("up", "down").evidence, /remote interface/);
  });
});

describe("severity mapping", () => {
  test("the worst states carry the worst severities", () => {
    assert.equal(severityForState("OFFLINE"), "critical");
    assert.equal(severityForState("LINK_DOWN"), "critical");
    assert.equal(severityForState("NO_INTERNET"), "major");
    assert.equal(severityForState("DEGRADED"), "minor");
    assert.equal(severityForState("STALE"), "minor");
    assert.equal(severityForState("NO_TRAFFIC"), "info");
    assert.equal(severityForState("ONLINE"), "info");
  });

  test("there is no \"warning\" severity — the scale is closed", () => {
    for (const state of HEALTH_STATES) {
      const severity = severityForState(state);
      assert.ok(
        ["critical", "major", "minor", "info"].includes(severity),
        `unexpected severity ${severity} for ${state}`
      );
    }
  });
});

describe("state catalogue", () => {
  test("every state has a description and a sort position", () => {
    for (const state of HEALTH_STATES) {
      assert.ok(STATE_DESCRIPTIONS[state], `${state} needs a description`);
      assert.equal(typeof STATE_SEVERITY_ORDER[state], "number", `${state} needs a sort key`);
    }
  });

  test("the catalogue contains exactly the nine documented states", () => {
    assert.deepEqual([...HEALTH_STATES].sort(), [
      "DEGRADED",
      "LINK_DOWN",
      "NO_INTERNET",
      "NO_TRAFFIC",
      "OFFLINE",
      "ONLINE",
      "STALE",
      "UNKNOWN",
      "UNMONITORED",
    ]);
  });

  test("only gateways, routers and the internet source own the WAN boundary", () => {
    assert.equal(isInternetBoundary("gateway"), true);
    assert.equal(isInternetBoundary("router"), true);
    assert.equal(isInternetBoundary("internet"), true);
    assert.equal(isInternetBoundary("switch"), false);
    assert.equal(isInternetBoundary("desktop"), false);
  });
});
