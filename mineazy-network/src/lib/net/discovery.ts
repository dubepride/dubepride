/**
 * ============================================================================
 *  net/discovery.ts — the active discovery engine
 * ============================================================================
 *
 *  Two jobs:
 *
 *    1. Expand the CIDR ranges an administrator authorised and sweep them
 *       politely (rate limited, never outside the authorised list).
 *    2. Read the operating system's ARP/neighbour table so the console can
 *       show which addresses the local host has actually seen.
 *
 *  The authorisation rule is absolute: `isAddressAuthorised` is consulted
 *  before ANY packet leaves this process. A range that is not registered in
 *  `Scan_Targets` is never touched, no matter who asks.
 * ============================================================================
 */

import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import os from "node:os";
import { enabledScanTargets, touchScanTarget } from "../repo/discovery";
import { pingProbe, tcpProbe } from "./probes";

/* ------------------------------------------------------------------ */
/* CIDR handling                                                       */
/* ------------------------------------------------------------------ */

/** A parsed CIDR block. */
export interface CidrBlock {
  /** The canonical network address, e.g. "192.168.1.0". */
  network: string;
  prefix: number;
  /** The broadcast address, e.g. "192.168.1.255". */
  broadcast: string;
  /** The total number of addresses in the block (including network/bcast). */
  size: number;
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`"${ip}" is not a valid IPv4 address.`);
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIp(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

/** Parse a CIDR block ("192.168.1.0/24"). Throws on malformed input. */
export function parseCidr(cidr: string): CidrBlock {
  const trimmed = cidr.trim();
  if (!trimmed) throw new Error("A CIDR range is required.");
  const [address, prefixText] = trimmed.split("/");
  if (prefixText === undefined) {
    // A bare address is treated as a /32 host entry. The conversion throws
    // on a malformed address, so it doubles as the validation.
    ipToInt(address);
    return { network: address, prefix: 32, broadcast: address, size: 1 };
  }
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`"${prefixText}" is not a valid CIDR prefix length.`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const base = ipToInt(address) & mask;
  const size = prefix === 0 ? 1 << 32 : 2 ** (32 - prefix);
  const last = prefix === 0 ? 0 : (base + size - 1) >>> 0;
  return {
    network: intToIp(base),
    prefix,
    broadcast: intToIp(last),
    size,
  };
}

/**
 * The host addresses of a block (network + broadcast excluded when the
 * block is large enough to have them).
 */
export function hostsInBlock(block: CidrBlock): string[] {
  const base = ipToInt(block.network);
  const out: string[] = [];
  const start = block.size > 2 ? base + 1 : base;
  const end = block.size > 2 ? ipToInt(block.broadcast) - 1 : base + block.size - 1;
  for (let value = start; value <= end; value += 1) out.push(intToIp(value));
  return out;
}

/* ------------------------------------------------------------------ */
/* Authorisation                                                       */
/* ------------------------------------------------------------------ */

/** The address ranges the operator has explicitly authorised. */
export async function authorisedBlocks(): Promise<CidrBlock[]> {
  const targets = await enabledScanTargets();
  const blocks: CidrBlock[] = [];
  for (const target of targets) {
    try {
      blocks.push(parseCidr(target.cidr));
    } catch {
      // A malformed range is ignored rather than fatal — the Settings page
      // surfaces the problem when the operator edits it.
    }
  }
  return blocks;
}

/**
 * True when the address falls inside one of the authorised blocks.
 *
 * This is the single gate in front of every outbound packet.
 */
export function isAddressAuthorised(ip: string, blocks: CidrBlock[]): boolean {
  let value: number;
  try {
    value = ipToInt(ip);
  } catch {
    return false;
  }
  for (const block of blocks) {
    const base = ipToInt(block.network);
    const size = block.size;
    if (value >= base && value < base + size) return true;
  }
  return false;
}

/** Refuse to expand a range that is implausibly large for an active sweep. */
export const MAX_SCAN_HOSTS = 65_536;

/**
 * True when an address can belong to exactly one host.
 *
 * A neighbour table is full of entries that are not devices: multicast group
 * memberships, the subnet broadcast, link-local chatter and loopback. None of
 * them may become an inventory row.
 */
export function isUnicastHostAddress(ip: string): boolean {
  let value: number;
  try {
    value = ipToInt(ip);
  } catch {
    return false;
  }
  const first = (value >>> 24) & 255;
  if (first === 0 || first === 127) return false; // "this network", loopback
  if (first >= 224) return false; // multicast, reserved, 255.255.255.255
  if (first === 169 && ((value >>> 16) & 255) === 254) return false; // link-local
  return true;
}

/**
 * The part of a neighbour table that may become inventory.
 *
 * Reading the neighbour table sends no packets, but it still obeys the same
 * two rules as the active sweep: the address must be unicast and must sit
 * inside a range an administrator authorised. Group MACs are dropped too,
 * which removes the subnet broadcast Windows lists as FF-FF-FF-FF-FF-FF.
 */
export function usableArpEntries(entries: ArpEntry[], blocks: CidrBlock[]): ArpEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!isUnicastHostAddress(entry.ip)) return false;
    if (!isAddressAuthorised(entry.ip, blocks)) return false;
    const firstOctet = Number.parseInt(entry.mac.slice(0, 2), 16);
    if (Number.isFinite(firstOctet) && (firstOctet & 1) === 1) return false; // group MAC
    if (seen.has(entry.ip)) return false;
    seen.add(entry.ip);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* The sweeper                                                         */
/* ------------------------------------------------------------------ */

/** One address that answered during a sweep. */
export interface ScanHit {
  ip: string;
  /** Latency of the first successful probe, in milliseconds. */
  latencyMs: number | null;
  /** Which probe succeeded. */
  method: "icmp" | "tcp";
  /** The hostname if the probe surfaced one. */
  hostname: string | null;
}

export interface SweepOptions {
  /** Maximum probes per second across the whole sweep. */
  rateLimitPerSecond: number;
  /**
   * Probes kept in flight at once.
   *
   * A sweep must not be serial: one unreachable address costs a full timeout,
   * so a /24 took longer than the sweep's own time limit and was cut in half.
   * Bounded concurrency keeps the run short while `rateLimitPerSecond` still
   * caps how fast new probes are dispatched.
   */
  concurrency: number;
  /** TCP ports to try when ICMP is filtered (usually the management port). */
  tcpPorts: number[];
  /** Per-probe timeout. */
  timeoutMs: number;
  /** Hard ceiling on how long the sweep may run. */
  maxDurationMs: number;
  /** Called after every address so the UI can show progress. */
  onProgress?: (done: number, total: number, found: number) => void;
  /** Cancellation check — return true to stop early. */
  shouldStop?: () => boolean;
}

export interface SweepResult {
  hits: ScanHit[];
  addressesScanned: number;
  durationMs: number;
  /** True when the sweep stopped early (cancelled or time limit). */
  truncated: boolean;
  /** Addresses that were skipped because they are not authorised. */
  refused: number;
}

const DEFAULTS: SweepOptions = {
  rateLimitPerSecond: 50,
  concurrency: 24,
  tcpPorts: [],
  timeoutMs: 1000,
  maxDurationMs: 120_000,
};

/**
 * Sweep the authorised ranges.
 *
 * The function refuses to touch an address that is not covered by a
 * registered range — the check happens per address, so even a bug in the
 * range expansion cannot leak a packet outside the authorised space.
 */
export async function sweepAuthorisedRanges(options: Partial<SweepOptions> = {}): Promise<SweepResult> {
  const opts: SweepOptions = { ...DEFAULTS, ...options };
  const targets = await enabledScanTargets();
  const started = Date.now();
  const hits: ScanHit[] = [];
  let refused = 0;
  let scanned = 0;

  const blocks: CidrBlock[] = [];
  const addresses: string[] = [];
  for (const target of targets) {
    let block: CidrBlock;
    try {
      block = parseCidr(target.cidr);
    } catch {
      continue;
    }
    blocks.push(block);
    for (const ip of hostsInBlock(block)) addresses.push(ip);
  }

  // Refuse absurd sweeps outright rather than hanging the collector.
  const scanList = addresses.slice(0, MAX_SCAN_HOSTS);
  if (addresses.length > scanList.length) {
    refused += addresses.length - scanList.length;
  }

  const minIntervalMs = opts.rateLimitPerSecond > 0 ? 1000 / opts.rateLimitPerSecond : 0;
  const deadline = started + opts.maxDurationMs;
  const concurrency = Math.max(1, Math.min(opts.concurrency, scanList.length || 1));

  let cursor = 0;
  let stopped = false;
  let nextDispatchAt = started;

  /** Reserve the next dispatch slot so the sweep never exceeds its rate. */
  async function waitForDispatchSlot(): Promise<void> {
    if (minIntervalMs <= 0) return;
    const now = Date.now();
    const at = Math.max(now, nextDispatchAt);
    nextDispatchAt = at + minIntervalMs;
    if (at > now) await sleep(at - now);
  }

  /** One probe, including the per-address authorisation gate. */
  async function probe(ip: string): Promise<void> {
    if (!isAddressAuthorised(ip, blocks)) {
      refused += 1;
      return;
    }

    await waitForDispatchSlot();
    if (opts.shouldStop?.() || Date.now() > deadline) {
      stopped = true;
      return;
    }

    const ping = await pingProbe(ip, opts.timeoutMs);
    if (ping.ok) {
      // Only a host that answered is worth a reverse lookup, so this costs
      // one resolver query per live device rather than one per address.
      const hostname = await reverseLookup(ip, opts.timeoutMs);
      hits.push({ ip, latencyMs: ping.latencyMs, method: "icmp", hostname });
    } else if (opts.tcpPorts.length > 0) {
      for (const port of opts.tcpPorts) {
        const tcp = await tcpProbe(ip, port, opts.timeoutMs);
        if (tcp.ok) {
          hits.push({ ip, latencyMs: tcp.latencyMs, method: "tcp", hostname: null });
          break;
        }
      }
    }

    scanned += 1;
    opts.onProgress?.(scanned, scanList.length, hits.length);
  }

  async function worker(): Promise<void> {
    while (!stopped) {
      if (opts.shouldStop?.() || Date.now() > deadline) {
        stopped = true;
        return;
      }
      const index = cursor++;
      if (index >= scanList.length) return;
      await probe(scanList[index]);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  for (const target of targets) {
    await touchScanTarget(target.id).catch(() => undefined);
  }

  hits.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  const processed = scanned + refused;
  return {
    hits,
    addressesScanned: scanned,
    durationMs: Date.now() - started,
    truncated: stopped || processed < scanList.length || addresses.length > scanList.length,
    refused,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort reverse DNS for a discovered address.
 *
 * Many devices have no PTR record, and a broken resolver must never stall a
 * sweep, so the lookup races a short timeout and every failure is "no name".
 * A name is evidence, not a requirement.
 */
async function reverseLookup(ip: string, timeoutMs: number): Promise<string | null> {
  try {
    const name = await Promise.race([
      dns.reverse(ip).then((names) => names[0] ?? null),
      sleep(Math.max(250, Math.min(timeoutMs, 1500))).then(() => null),
    ]);
    return name ? name.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* ARP / neighbour table                                               */
/* ------------------------------------------------------------------ */

/** One entry of the operating system's neighbour table. */
export interface ArpEntry {
  ip: string;
  mac: string;
  interface: string;
  state: string;
}

/**
 * Read the host's ARP / neighbour cache.
 *
 * Windows uses `arp -a`, Linux uses `ip neigh`. Both are read-only
 * commands — nothing is sent to the network.
 */
export async function readArpTable(): Promise<ArpEntry[]> {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "arp" : "ip";
  const args = isWindows ? ["-a"] : ["neigh", "show"];

  const output = await new Promise<string>((resolve) => {
    execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? "" : `${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });

  if (!output.trim()) return [];

  const entries: ArpEntry[] = [];
  if (isWindows) {
    // Windows "arp -a" output:
    //   Interface: 10.0.0.5 --- 0x9
    //     10.0.0.1           00-11-22-33-44-55     dynamic
    let currentInterface = "";
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      const iface = /^Interface:\s*(\S+)/i.exec(line);
      if (iface) {
        currentInterface = iface[1];
        continue;
      }
      const match = /^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}-[0-9a-f]{2}(?:-[0-9a-f]{2}){4})\s+(\S+)/i.exec(line);
      if (!match) continue;
      entries.push({
        ip: match[1],
        mac: match[2].replace(/-/g, ":").toUpperCase(),
        interface: currentInterface,
        state: match[3],
      });
    }
    return entries;
  }

  // Linux "ip neigh show" output:
  //   10.0.0.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+(\S+)(?:\s+lladdr\s+([0-9a-f:]{17}))?\s*(\S+)?/i.exec(line);
    if (!match) continue;
    if (!match[3]) continue; // incomplete entries have no MAC
    entries.push({
      ip: match[1],
      mac: match[3].toUpperCase(),
      interface: match[2],
      state: match[4] ?? "UNKNOWN",
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Local interface inventory                                           */
/* ------------------------------------------------------------------ */

/** A local network interface of the monitoring host. */
export interface LocalInterface {
  name: string;
  address: string;
  mac: string;
  family: string;
  internal: boolean;
}

/** The monitoring host's own interfaces (used to suggest scan ranges). */
export function listLocalInterfaces(): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      out.push({
        name,
        address: address.address,
        mac: address.mac,
        family: address.family,
        internal: address.internal,
      });
    }
  }
  return out;
}

/** The IPv4 networks the monitoring host sits on (suggested scan ranges). */
export function localIpv4Networks(): string[] {
  const networks = new Set<string>();
  for (const iface of listLocalInterfaces()) {
    if (iface.family !== "IPv4" || iface.internal) continue;
    const parts = iface.address.split(".");
    if (parts.length !== 4) continue;
    // A /24 is the safe default suggestion for a small estate.
    networks.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
  }
  return [...networks];
}
