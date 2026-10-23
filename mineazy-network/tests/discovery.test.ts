/**
 * ============================================================================
 *  tests/discovery.test.ts — the authorisation gate on active scanning
 * ============================================================================
 *
 *  The single most important rule in the discovery engine: no packet leaves
 *  the process unless the target address falls inside a range an
 *  administrator explicitly authorised. Everything else — rate limiting,
 *  sweep size, CIDR maths — is secondary to that.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  parseCidr,
  hostsInBlock,
  isAddressAuthorised,
  isUnicastHostAddress,
  usableArpEntries,
  localIpv4Networks,
  listLocalInterfaces,
  MAX_SCAN_HOSTS,
  type ArpEntry,
  type CidrBlock,
} from "../src/lib/net/discovery";

describe("parseCidr", () => {
  test("a /24 is parsed into its network and broadcast addresses", () => {
    const block = parseCidr("192.168.1.0/24");
    assert.equal(block.network, "192.168.1.0");
    assert.equal(block.broadcast, "192.168.1.255");
    assert.equal(block.prefix, 24);
    assert.equal(block.size, 256);
  });

  test("a host address without a prefix is a /32", () => {
    const block = parseCidr("10.0.0.7");
    assert.equal(block.prefix, 32);
    assert.equal(block.network, "10.0.0.7");
    assert.equal(block.broadcast, "10.0.0.7");
    assert.equal(block.size, 1);
  });

  test("a host address with a prefix is normalised to its network address", () => {
    const block = parseCidr("10.0.0.77/24");
    assert.equal(block.network, "10.0.0.0");
    assert.equal(block.broadcast, "10.0.0.255");
  });

  test("malformed input is rejected loudly", () => {
    assert.throws(() => parseCidr(""), /required/i);
    assert.throws(() => parseCidr("192.168.1.0/33"), /prefix/i);
    assert.throws(() => parseCidr("192.168.1.0/abc"), /prefix/i);
    assert.throws(() => parseCidr("999.1.1.1/24"), /not a valid IPv4/i);
    assert.throws(() => parseCidr("192.168.1/24"), /not a valid IPv4/i);
  });
});

describe("hostsInBlock", () => {
  test("a /30 excludes the network and broadcast addresses", () => {
    const hosts = hostsInBlock(parseCidr("10.0.0.0/30"));
    assert.deepEqual(hosts, ["10.0.0.1", "10.0.0.2"]);
  });

  test("a /31 contains both addresses", () => {
    assert.deepEqual(hostsInBlock(parseCidr("10.0.0.0/31")), ["10.0.0.0", "10.0.0.1"]);
  });

  test("a /24 yields 254 usable hosts", () => {
    const hosts = hostsInBlock(parseCidr("192.168.1.0/24"));
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], "192.168.1.1");
    assert.equal(hosts[hosts.length - 1], "192.168.1.254");
  });
});

describe("isAddressAuthorised", () => {
  const blocks: CidrBlock[] = [parseCidr("192.168.1.0/24"), parseCidr("10.10.0.0/16")];

  test("an address inside an authorised range is allowed", () => {
    assert.equal(isAddressAuthorised("192.168.1.1", blocks), true);
    assert.equal(isAddressAuthorised("192.168.1.254", blocks), true);
    assert.equal(isAddressAuthorised("10.10.4.55", blocks), true);
  });

  test("an address outside every authorised range is refused", () => {
    assert.equal(isAddressAuthorised("192.168.2.1", blocks), false);
    assert.equal(isAddressAuthorised("8.8.8.8", blocks), false);
    assert.equal(isAddressAuthorised("172.16.0.1", blocks), false);
  });

  test("the network and broadcast addresses of an authorised range are inside it", () => {
    assert.equal(isAddressAuthorised("192.168.1.0", blocks), true);
    assert.equal(isAddressAuthorised("192.168.1.255", blocks), true);
  });

  test("a malformed address is refused, never allowed", () => {
    assert.equal(isAddressAuthorised("not-an-ip", blocks), false);
    assert.equal(isAddressAuthorised("", blocks), false);
    assert.equal(isAddressAuthorised("999.999.999.999", blocks), false);
  });

  test("with no authorised ranges nothing is allowed", () => {
    assert.equal(isAddressAuthorised("192.168.1.1", []), false);
  });
});

describe("scan limits", () => {
  test("a single sweep is capped so one job cannot run away", () => {
    assert.ok(MAX_SCAN_HOSTS > 0);
    assert.ok(MAX_SCAN_HOSTS <= 1_000_000);
  });
});

describe("usableArpEntries", () => {
  const blocks: CidrBlock[] = [parseCidr("192.168.1.0/24")];
  const entry = (ip: string, mac = "AA:BB:CC:DD:EE:FF"): ArpEntry => ({
    ip,
    mac,
    interface: "192.168.1.53",
    state: "dynamic",
  });

  test("unicast hosts inside an authorised range are kept", () => {
    const kept = usableArpEntries(
      [entry("192.168.1.1", "74:24:9F:57:D9:91"), entry("192.168.1.50", "B0:83:FE:B8:46:3B")],
      blocks
    );
    assert.deepEqual(
      kept.map((e) => e.ip),
      ["192.168.1.1", "192.168.1.50"]
    );
  });

  test("the subnet broadcast is dropped even when it carries a group MAC", () => {
    assert.equal(usableArpEntries([entry("192.168.1.255", "FF:FF:FF:FF:FF:FF")], blocks).length, 0);
  });

  test("multicast, link-local and loopback chatter is dropped", () => {
    const kept = usableArpEntries(
      [
        entry("224.0.0.22", "01:00:5E:00:00:16"),
        entry("239.255.255.250"),
        entry("169.254.10.4"),
        entry("127.0.0.1"),
      ],
      blocks
    );
    assert.equal(kept.length, 0);
  });

  test("an address outside every authorised range is dropped", () => {
    assert.equal(usableArpEntries([entry("192.168.2.10")], blocks).length, 0);
    assert.equal(usableArpEntries([entry("8.8.8.8")], blocks).length, 0);
  });

  test("the same address listed twice becomes one device", () => {
    assert.equal(usableArpEntries([entry("192.168.1.1"), entry("192.168.1.1")], blocks).length, 1);
  });

  test("with no authorised ranges nothing is kept", () => {
    assert.equal(usableArpEntries([entry("192.168.1.1")], []).length, 0);
  });
});

describe("isUnicastHostAddress", () => {
  test("ordinary host addresses are unicast", () => {
    assert.equal(isUnicastHostAddress("192.168.1.53"), true);
    assert.equal(isUnicastHostAddress("10.0.0.1"), true);
    assert.equal(isUnicastHostAddress("172.16.4.9"), true);
  });

  test("group, loopback, link-local and malformed addresses are not", () => {
    assert.equal(isUnicastHostAddress("224.0.0.1"), false);
    assert.equal(isUnicastHostAddress("239.255.255.250"), false);
    assert.equal(isUnicastHostAddress("255.255.255.255"), false);
    assert.equal(isUnicastHostAddress("127.0.0.1"), false);
    assert.equal(isUnicastHostAddress("169.254.1.1"), false);
    assert.equal(isUnicastHostAddress("0.0.0.0"), false);
    assert.equal(isUnicastHostAddress("not-an-ip"), false);
    assert.equal(isUnicastHostAddress("999.1.1.1"), false);
  });
});

describe("local interface discovery", () => {
  test("the host's own interfaces are listed", () => {
    const interfaces = listLocalInterfaces();
    assert.ok(interfaces.length > 0, "every host has at least one interface");
    for (const iface of interfaces) {
      assert.ok(typeof iface.name === "string");
      assert.ok(typeof iface.address === "string");
    }
  });

  test("suggested ranges are /24 CIDR blocks", () => {
    for (const network of localIpv4Networks()) {
      assert.match(network, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24$/);
    }
  });
});
