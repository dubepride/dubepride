/**
 * ============================================================================
 *  tests/collector.test.ts — the collector's traffic accounting
 * ============================================================================
 *
 *  The rate shown on the console must be the DELTA between two readings of
 *  the same counter. This test drives the real repository code (not a mock)
 *  so the "previous reading" and the "current reading" are genuine rows.
 *
 *  It guards the bug where the previous counters were overwritten before the
 *  rate was calculated — which made every rate come out as "unavailable".
 *
 *  It also guards the collector heartbeat: the console shows "the collector
 *  has not reported yet" when the heartbeat is missing, so BOTH the real
 *  collector and the demo simulator have to write one.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { tempDatabase, removeTempDatabase } from "./helpers";

const dbPath = tempDatabase("collector");

let devices: typeof import("../src/lib/repo/devices");
let ports: typeof import("../src/lib/repo/ports");
let worker: typeof import("../src/collector/worker");
let traffic: typeof import("../src/lib/repo/traffic");
let db: typeof import("../src/lib/db");

const T0 = 1_700_000_000_000;
const T1 = T0 + 10_000; // ten seconds later
const NOW_MS = T0;

before(async () => {
  devices = await import("../src/lib/repo/devices");
  ports = await import("../src/lib/repo/ports");
  worker = await import("../src/collector/worker");
  traffic = await import("../src/lib/repo/traffic");
  db = await import("../src/lib/db");
});

after(() => {
  removeTempDatabase(dbPath);
});

/** Force the stored "last polled" timestamp so the window is deterministic. */
async function setLastPolled(portId: number, at: number): Promise<void> {
  await db.exec(await db.getDb(), "UPDATE Ports SET Last_Polled_At = ? WHERE Port_ID = ?", at, portId);
}

describe("updatePortTraffic", () => {
  test("the first reading of a counter is a baseline, not a rate", async () => {
    const deviceId = await devices.createDevice({ name: "Baseline Switch", category: "switch" });
    await ports.upsertPort(deviceId, {
      ifName: "Gi1/0/1",
      operState: "up",
      speedBps: 1_000_000_000,
      inOctets: 1000,
      outOctets: 500,
      inPackets: 10,
      outPackets: 5,
      source: "snmp",
    });

    const reading = await ports.listPorts(deviceId);
    await setLastPolled(reading[0].id, T0);
    const stamped = await ports.listPorts(deviceId);

    const result = await worker.updatePortTraffic(deviceId, [], stamped, T0);

    assert.equal(result.inRate, null, "a counter with no predecessor has no rate");
    assert.equal(result.outRate, null);
    assert.equal(result.hasCounters, true);

    const samples = await traffic.samplesSince("port", stamped[0].id, T0 - 1000);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].counterValid, false, "the baseline sample is marked as not yet valid");
    assert.equal(samples[0].inBytes, 1000, "the raw counter is still stored");
  });

  test("the second reading produces the rate of the delta", async () => {
    const deviceId = await devices.createDevice({ name: "Rate Switch", category: "switch" });
    await ports.upsertPort(deviceId, {
      ifName: "Gi1/0/1",
      operState: "up",
      speedBps: 1_000_000_000,
      inOctets: 1000,
      outOctets: 500,
      inPackets: 10,
      outPackets: 5,
      source: "snmp",
    });

    const first = await ports.listPorts(deviceId);
    await setLastPolled(first[0].id, T0);
    const previous = await ports.listPorts(deviceId);

    // The device moved 5000 bytes in and 2500 bytes out over the window.
    await ports.upsertPort(deviceId, {
      ifName: "Gi1/0/1",
      operState: "up",
      speedBps: 1_000_000_000,
      inOctets: 6000,
      outOctets: 3000,
      inPackets: 60,
      outPackets: 30,
      source: "snmp",
    });
    await setLastPolled(first[0].id, T1);
    const current = await ports.listPorts(deviceId);

    const result = await worker.updatePortTraffic(deviceId, previous, current, T1);

    // 5000 bytes over 10 seconds = 4000 bits per second.
    assert.equal(result.inRate, 4000);
    assert.equal(result.outRate, 2000);

    const stored = await ports.listPorts(deviceId);
    assert.equal(stored[0].inRateBps, 4000, "the rate is stored on the port row");
    assert.equal(stored[0].outRateBps, 2000);

    const samples = await traffic.samplesSince("port", current[0].id, T0 - 1000);
    const latest = samples[samples.length - 1];
    assert.equal(latest.counterValid, true);
    assert.equal(latest.windowSeconds, 10);
    assert.equal(latest.inRateBps, 4000);
  });

  test("a counter that goes backwards is re-baselined, not shown as a huge rate", async () => {
    const deviceId = await devices.createDevice({ name: "Resetting Switch", category: "switch" });
    await ports.upsertPort(deviceId, {
      ifName: "Gi1/0/1",
      operState: "up",
      speedBps: 1_000_000_000,
      inOctets: 9_000_000,
      outOctets: 9_000_000,
      source: "snmp",
    });

    const first = await ports.listPorts(deviceId);
    await setLastPolled(first[0].id, T0);
    const previous = await ports.listPorts(deviceId);

    // The device restarted: the counter is back near zero.
    await ports.upsertPort(deviceId, {
      ifName: "Gi1/0/1",
      operState: "up",
      speedBps: 1_000_000_000,
      inOctets: 500,
      outOctets: 500,
      source: "snmp",
    });
    await setLastPolled(first[0].id, T1);
    const current = await ports.listPorts(deviceId);

    const result = await worker.updatePortTraffic(deviceId, previous, current, T1);

    assert.equal(result.inRate, null, "a counter reset must not produce a rate");
    assert.equal(result.outRate, null);

    const stored = await ports.listPorts(deviceId);
    assert.equal(stored[0].inRateBps, null);
  });
});

describe("the collector heartbeat", () => {
  test("there is no heartbeat before the collector has run", async () => {
    const heartbeat = await worker.collectorHeartbeat();
    assert.equal(heartbeat, null, "a fresh database has never been collected");
  });

  test("the heartbeat records that the collector is alive", async () => {
    await worker.writeCollectorHeartbeat("3 device(s) polled, 3 reachable.");
    const heartbeat = await worker.collectorHeartbeat();
    assert.notEqual(heartbeat, null, "the heartbeat must be readable");
    assert.equal(heartbeat!.detail, "3 device(s) polled, 3 reachable.");
    assert.ok(heartbeat!.at > 0, "the heartbeat carries a timestamp");
  });

  test("the demo simulator writes a heartbeat too", async () => {
    // The console shows "the collector has not reported yet" when the
    // heartbeat is missing. The simulator produces data every cycle, so it
    // has to write one — otherwise a perfectly healthy demo estate looks
    // unconfirmed.
    const simulator = await import("../src/collector/simulator");
    await simulator.seedSimulatedTopology();
    await simulator.simulateCycle();

    const heartbeat = await worker.collectorHeartbeat();
    assert.notEqual(heartbeat, null, "the simulator must write a heartbeat");
    assert.match(heartbeat!.detail, /simulated/i, "the heartbeat says the data is simulated");
  });
});

describe("the poll schedule", () => {
  /** A device as the collector sees it, with only the fields the schedule uses. */
  function scheduled(lastObservedAt: number | null, pollIntervalSeconds: number) {
    return { lastObservedAt, pollIntervalSeconds } as unknown as import("../src/lib/types").Device;
  }

  test("a device that has never been observed is always due", () => {
    assert.equal(worker.isDeviceDue(scheduled(null, 300), NOW_MS), true);
  });

  test("a device inside its poll interval is not due yet", () => {
    // Polled every 300s, last read 60s ago → not due.
    assert.equal(worker.isDeviceDue(scheduled(NOW_MS - 60_000, 300), NOW_MS), false);
  });

  test("a device past its poll interval is due", () => {
    // Polled every 300s, last read 301s ago → due.
    assert.equal(worker.isDeviceDue(scheduled(NOW_MS - 301_000, 300), NOW_MS), true);
  });

  test("an absurd interval is clamped so the collector cannot busy-loop", () => {
    assert.equal(worker.isDeviceDue(scheduled(NOW_MS - 1_000, 0), NOW_MS), false);
    assert.equal(worker.isDeviceDue(scheduled(NOW_MS - 60_000, 0), NOW_MS), true);
  });
});
