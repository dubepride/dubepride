/**
 * ============================================================================
 *  tests/traffic.test.ts — counter deltas become honest rates
 * ============================================================================
 *
 *  The rule this file protects: a cumulative byte counter is NEVER presented
 *  as a speed. A rate only exists when there are two readings and a positive
 *  window between them.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  computeRates,
  formatBandwidth,
  formatBytes,
  toSample,
  utilisationPct,
  type CounterSnapshot,
} from "../src/lib/traffic";

function snapshot(overrides: Partial<CounterSnapshot> = {}): CounterSnapshot {
  return {
    at: 1_700_000_000_000,
    inBytes: 0,
    outBytes: 0,
    inPackets: 0,
    outPackets: 0,
    inErrors: 0,
    outErrors: 0,
    ...overrides,
  };
}

describe("computeRates", () => {
  test("the first sample produces no rate at all", () => {
    const result = computeRates(null, snapshot({ inBytes: 1_000_000, outBytes: 2_000_000 }));
    assert.equal(result.inRateBps, null);
    assert.equal(result.outRateBps, null);
    assert.equal(result.counterValid, false);
    assert.match(result.reason, /baseline/i);
  });

  test("the first sample still stores the raw counters", () => {
    const result = computeRates(null, snapshot({ inBytes: 1_000_000 }));
    assert.equal(result.inBytes, 1_000_000);
  });

  test("a rate is the delta over the measured window, in bits per second", () => {
    const previous = snapshot({ at: 1_700_000_000_000, inBytes: 1_000, outBytes: 2_000 });
    const current = snapshot({ at: 1_700_000_010_000, inBytes: 1_000 + 125_000, outBytes: 2_000 + 62_500 });

    const result = computeRates(previous, current);
    assert.equal(result.windowSeconds, 10);
    assert.equal(result.inRateBps, (125_000 * 8) / 10);
    assert.equal(result.outRateBps, (62_500 * 8) / 10);
    assert.equal(result.counterValid, true);
  });

  test("packet rates are packets per second", () => {
    const previous = snapshot({ at: 0, inPackets: 100, outPackets: 50 });
    const current = snapshot({ at: 4_000, inPackets: 300, outPackets: 150 });
    const result = computeRates(previous, current);
    assert.equal(result.inPps, 50);
    assert.equal(result.outPps, 25);
  });

  test("a counter that goes backwards is a reset, not a 40 Gbps spike", () => {
    const previous = snapshot({ at: 0, inBytes: 5_000_000, outBytes: 5_000_000 });
    const current = snapshot({ at: 10_000, inBytes: 12, outBytes: 40 });

    const result = computeRates(previous, current);
    assert.equal(result.inRateBps, null);
    assert.equal(result.outRateBps, null);
    assert.equal(result.counterValid, false);
    assert.match(result.reason, /reset/i);
    assert.equal(result.windowSeconds, 10, "the window is still reported");
  });

  test("readings that are not ordered in time yield no rate", () => {
    const previous = snapshot({ at: 10_000, inBytes: 100 });
    const current = snapshot({ at: 5_000, inBytes: 200 });
    const result = computeRates(previous, current);
    assert.equal(result.inRateBps, null);
    assert.equal(result.counterValid, false);
    assert.match(result.reason, /ordered in time/i);
  });

  test("a device that reports no counters says so instead of reporting zero", () => {
    const previous = snapshot({ at: 0, inBytes: null, outBytes: null });
    const current = snapshot({ at: 10_000, inBytes: null, outBytes: null });
    const result = computeRates(previous, current);
    assert.equal(result.inRateBps, null);
    assert.equal(result.outRateBps, null);
    assert.equal(result.counterValid, false);
    assert.match(result.reason, /does not report traffic counters/i);
  });

  test("one missing side does not invent the other side", () => {
    const previous = snapshot({ at: 0, inBytes: null, outBytes: 100 });
    const current = snapshot({ at: 10_000, inBytes: null, outBytes: 200 });
    const result = computeRates(previous, current);
    assert.equal(result.inRateBps, null);
    assert.equal(result.outRateBps, 80);
  });
});

describe("toSample", () => {
  test("a pending baseline is stored with Counter_Valid = 0", () => {
    const result = computeRates(null, snapshot({ inBytes: 500 }));
    const sample = toSample("port", 7, result, "snmp");
    assert.equal(sample.subjectType, "port");
    assert.equal(sample.subjectId, 7);
    assert.equal(sample.counterValid, false);
    assert.equal(sample.inRateBps, null);
    assert.ok(sample.sampledAt > 0);
  });
});

describe("utilisation", () => {
  test("utilisation is the rate over the negotiated speed", () => {
    assert.equal(utilisationPct(500_000_000, 1_000_000_000), 50);
  });

  test("utilisation is unknown without a speed", () => {
    assert.equal(utilisationPct(500_000_000, null), null);
    assert.equal(utilisationPct(500_000_000, 0), null);
  });
});

describe("formatting", () => {
  test("bandwidth is formatted with a sensible unit", () => {
    assert.equal(formatBandwidth(0), "0 bps");
    assert.equal(formatBandwidth(999), "999 bps");
    assert.equal(formatBandwidth(1_000), "1.0 Kbps");
    assert.equal(formatBandwidth(12_400_000), "12.4 Mbps");
    assert.equal(formatBandwidth(1_000_000_000), "1.0 Gbps");
  });

  test("an unknown bandwidth says \"Unavailable\" rather than 0", () => {
    assert.equal(formatBandwidth(null), "Unavailable");
    assert.equal(formatBandwidth(undefined), "Unavailable");
    assert.equal(formatBandwidth(Number.NaN), "Unavailable");
  });

  test("byte counts are formatted with a sensible unit", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2_048), "2.0 KB");
    assert.equal(formatBytes(null), "Unavailable");
  });
});
