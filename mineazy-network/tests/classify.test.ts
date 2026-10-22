/**
 * ============================================================================
 *  tests/classify.test.ts — evidence-based device classification
 * ============================================================================
 *
 *  Two promises are under test:
 *    1. An administrator's decision is never overwritten by the classifier.
 *    2. "unknown" is a legitimate answer — thin evidence produces a guess,
 *       not a confident lie.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { classifyDevice, vendorFromMac, CATEGORY_LABELS } from "../src/lib/net/classify";

describe("vendorFromMac", () => {
  test("a known OUI returns the vendor", () => {
    assert.equal(vendorFromMac("24:4B:FE:00:00:01"), "Ubiquiti Networks");
    assert.equal(vendorFromMac("00-1b-21-00-00-01"), "Huawei");
  });

  test("an unknown OUI returns null instead of a wrong vendor", () => {
    assert.equal(vendorFromMac("FF:FF:FF:00:00:01"), null);
  });

  test("a malformed MAC returns null", () => {
    assert.equal(vendorFromMac("not-a-mac"), null);
    assert.equal(vendorFromMac(null), null);
    assert.equal(vendorFromMac(""), null);
  });
});

describe("classifyDevice", () => {
  test("a locked category is always honoured", () => {
    const result = classifyDevice({
      hostname: "core-sw1",
      lockedCategory: "server",
    });
    assert.equal(result.category, "server");
    assert.equal(result.confidence, "confirmed");
    assert.match(result.evidence, /administrator/i);
  });

  test("a switch is recognised from its description", () => {
    const result = classifyDevice({
      systemDescription: "Cisco IOS Software, WS-C2960-24TT-L Switch",
    });
    assert.equal(result.category, "switch");
  });

  test("access point wins over a description that also mentions a switch", () => {
    const result = classifyDevice({
      systemDescription: "UniFi AP — wireless access point with switch uplink",
    });
    assert.equal(result.category, "access_point");
  });

  test("a router is recognised from its model", () => {
    const result = classifyDevice({ systemDescription: "MikroTik RouterBOARD 750Gr3" });
    assert.equal(result.category, "router");
  });

  test("a Starlink terminal is recognised as the internet source", () => {
    const result = classifyDevice({ hostname: "starlink-pop" });
    assert.equal(result.category, "internet");
  });

  test("a printer is recognised", () => {
    const result = classifyDevice({ systemDescription: "HP LaserJet M428fdw printer" });
    assert.equal(result.category, "printer");
  });

  test("many ethernet interfaces plus port-like names means switch", () => {
    const result = classifyDevice({
      interfaceNames: [
        "GigabitEthernet1/0/1",
        "GigabitEthernet1/0/2",
        "GigabitEthernet1/0/3",
        "GigabitEthernet1/0/4",
        "GigabitEthernet1/0/5",
        "GigabitEthernet1/0/6",
        "GigabitEthernet1/0/7",
        "GigabitEthernet1/0/8",
      ],
    });
    assert.equal(result.category, "switch");
    assert.match(result.evidence, /ethernet interfaces/);
  });

  test("a known vendor upgrades a probable match to confirmed", () => {
    const result = classifyDevice({
      systemDescription: "Cisco Catalyst 2960 switch",
      mac: "00:00:0C:11:22:33",
    });
    assert.equal(result.category, "switch");
    assert.equal(result.confidence, "confirmed");
    assert.match(result.evidence, /Cisco/);
  });

  test("thin evidence produces \"unknown\" with an explanation", () => {
    const result = classifyDevice({});
    assert.equal(result.category, "unknown");
    assert.equal(result.confidence, "unknown");
    assert.ok(result.evidence.length > 0);
  });

  test("a verdict always explains itself", () => {
    const inputs = [
      { hostname: "printer-hall" },
      { systemDescription: "Synology DiskStation NAS" },
      { neighborPlatform: "Hikvision DS-7732NI" },
      { hostname: "access-point-2" },
      { systemDescription: "Fortinet FortiGate 60F" },
    ];
    for (const input of inputs) {
      const result = classifyDevice(input);
      assert.ok(result.evidence.trim().length > 0, `no evidence for ${JSON.stringify(input)}`);
    }
  });

  test("every category has a display label", () => {
    for (const label of Object.values(CATEGORY_LABELS)) {
      assert.ok(label.length > 0);
    }
  });
});
