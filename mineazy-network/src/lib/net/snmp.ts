/**
 * ============================================================================
 *  net/snmp.ts — the SNMP adapter
 * ============================================================================
 *
 *  One place that knows how to speak SNMP, so the collector can stay
 *  protocol-agnostic. Everything the console shows about a managed switch
 *  comes from here:
 *
 *    • system identity      (sysName / sysDescr / sysObjectID / sysUpTime)
 *    • interface inventory  (descr, type, admin/oper status, speed, duplex)
 *    • traffic counters     (32-bit + 64-bit high-capacity counters)
 *    • error/discard counters
 *    • LLDP neighbours      (LLDP-MIB lldpRemTable)
 *    • CDP neighbours       (CISCO-CDP-MIB ciscoCDPCacheAddressTable)
 *    • forwarding table     (BRIDGE-MIB / Q-BRIDGE-MIB FDB tables)
 *    • ARP cache            (IP-MIB ipNetToMediaPhysAddress)
 *
 *  SNMPv3 (auth + priv) is preferred; v2c is supported for legacy kit with
 *  read-only community strings. Secrets are supplied by the caller (decrypted
 *  from the credential store) and never logged.
 */

import snmp from "net-snmp";
import type { SnmpCredential } from "../repo/credentials";

/* ------------------------------------------------------------------ */
/* OIDs                                                                */
/* ------------------------------------------------------------------ */

const OID = {
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysObjectID: "1.3.6.1.2.1.1.2.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  sysName: "1.3.6.1.2.1.1.5.0",

  ifNumber: "1.3.6.1.2.1.2.1.0",
  ifDescr: "1.3.6.1.2.1.2.2.1.2",
  ifType: "1.3.6.1.2.1.2.2.1.3",
  ifSpeed: "1.3.6.1.2.1.2.2.1.5",
  ifPhysAddress: "1.3.6.1.2.1.2.2.1.6",
  ifAdminStatus: "1.3.6.1.2.1.2.2.1.7",
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8",
  ifLastChange: "1.3.6.1.2.1.2.2.1.9",
  ifInOctets: "1.3.6.1.2.1.2.2.2.1.10",
  ifInUcastPkts: "1.3.6.1.2.1.2.2.1.11",
  ifInDiscards: "1.3.6.1.2.1.2.2.1.13",
  ifInErrors: "1.3.6.1.2.1.2.2.1.14",
  ifOutOctets: "1.3.6.1.2.1.2.2.1.16",
  ifOutUcastPkts: "1.3.6.1.2.1.2.2.1.17",
  ifOutDiscards: "1.3.6.1.2.1.2.2.1.19",
  ifOutErrors: "1.3.6.1.2.1.2.2.1.20",

  ifHighSpeed: "1.3.6.1.2.1.31.1.1.1.15",
  ifHCInOctets: "1.3.6.1.2.1.31.1.1.1.6",
  ifHCInUcastPkts: "1.3.6.1.2.1.31.1.1.1.7",
  ifHCOutOctets: "1.3.6.1.2.1.31.1.1.1.10",
  ifHCOutUcastPkts: "1.3.6.1.2.1.31.1.1.1.11",

  dot1dBasePortIfIndex: "1.3.6.1.2.1.17.1.4.1.2",
  dot1dTpFdbAddress: "1.3.6.1.2.1.17.4.3.1.1",
  dot1dTpFdbPort: "1.3.6.1.2.1.17.4.3.1.2",
  dot1qTpFdbAddress: "1.3.6.1.2.1.17.7.1.2.2.1.1",
  dot1qTpFdbPort: "1.3.6.1.2.1.17.7.1.2.2.1.2",

  ipNetToMediaPhysAddress: "1.3.6.1.2.1.4.22.1.2",
  ipAdEntAddr: "1.3.6.1.2.1.4.20.1.1.1",

  lldpRemTable: "1.0.8802.1.1.2.1.4.1.1",
  lldpRemChassisId: "1.0.8802.1.1.2.1.4.1.1.5",
  lldpRemPortId: "1.0.8802.1.1.2.1.4.1.1.7",
  lldpRemPortDesc: "1.0.8802.1.1.2.1.4.1.1.8",
  lldpRemSysName: "1.0.8802.1.1.2.1.4.1.1.9",
  lldpRemSysDesc: "1.0.8802.1.1.2.1.4.1.1.10",
  lldpRemManAddr: "1.0.8802.1.1.2.1.4.1.1.12",

  cdpCacheTable: "1.3.6.1.4.1.9.9.23.1.2.2.1",
  cdpCacheAddressType: "1.3.6.1.4.1.9.9.23.1.2.2.1.4",
  cdpCacheAddress: "1.3.6.1.4.1.9.9.23.1.2.2.1.5",
  cdpCacheVersion: "1.3.6.1.4.1.9.9.23.1.2.2.1.6",
  cdpCacheDeviceId: "1.3.6.1.4.1.9.9.23.1.2.2.1.7",
  cdpCacheDevicePort: "1.3.6.1.4.1.9.9.23.1.2.2.1.8",
  cdpCachePlatform: "1.3.6.1.4.1.9.9.23.1.2.2.1.9",
} as const;

/* ------------------------------------------------------------------ */
/* Session helpers                                                     */
/* ------------------------------------------------------------------ */

export interface SnmpTarget {
  host: string;
  credential: SnmpCredential;
  timeoutMs?: number;
  retries?: number;
}

interface VarBind {
  oid: string;
  value: unknown;
}

/**
 * Map the credential's protocol name onto the net-snmp enum.
 *
 * The stored name is a human string ("sha256", "aes256"); the library wants
 * the numeric constant. Unknown names fall back to the strongest supported
 * protocol rather than silently downgrading to "no authentication".
 */
function authProtocolFor(name: string): snmp.AuthProtocols {
  switch ((name || "").trim().toLowerCase()) {
    case "none":
      return snmp.AuthProtocols.none;
    case "md5":
      return snmp.AuthProtocols.md5;
    case "sha":
    case "sha1":
      return snmp.AuthProtocols.sha;
    case "sha224":
      return snmp.AuthProtocols.sha224;
    case "sha384":
      return snmp.AuthProtocols.sha384;
    case "sha512":
      return snmp.AuthProtocols.sha512;
    case "sha256":
    default:
      return snmp.AuthProtocols.sha256;
  }
}

function privProtocolFor(name: string): snmp.PrivProtocols {
  switch ((name || "").trim().toLowerCase()) {
    case "none":
      return snmp.PrivProtocols.none;
    case "des":
      return snmp.PrivProtocols.des;
    case "aes":
    case "aes128":
      return snmp.PrivProtocols.aes;
    case "aes256":
    case "aes256b":
    default:
      return snmp.PrivProtocols.aes256b;
  }
}

/** Create a session for the given credential (v3 when possible). */
function createSession(target: SnmpTarget): snmp.Session {
  const { credential } = target;
  const timeout = target.timeoutMs ?? 2000;
  const retries = target.retries ?? 1;

  if (credential.version === "3") {
    // SNMPv3: the user object carries the auth/priv keys. The session is
    // created with auth+privacy so the transport is encrypted.
    const user: snmp.User = {
      name: credential.username,
      level: snmp.SecurityLevel.authPriv,
      authProtocol: authProtocolFor(credential.authProtocol),
      authKey: credential.authKey,
      privProtocol: privProtocolFor(credential.privProtocol),
      privKey: credential.privKey,
    };
    return snmp.createV3Session(target.host, user, { timeout, retries });
  }

  return snmp.createSession(target.host, credential.community, {
    version: credential.version === "1" ? snmp.Version1 : snmp.Version2c,
    timeout,
    retries,
  });
}

/** Perform a GET and return the raw varbinds. */
function get(session: snmp.Session, oids: string[]): Promise<VarBind[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) reject(error);
      else resolve((varbinds ?? []) as unknown as VarBind[]);
    });
  });
}

/**
 * Perform a SUBTREE walk and return the raw varbinds.
 *
 * net-snmp's subtree() is a streaming call: a feed callback receives each
 * batch and a done callback reports the final error. The batches are
 * accumulated here so the rest of the module can treat a walk like a get.
 */
function subtree(session: snmp.Session, oid: string): Promise<VarBind[]> {
  return new Promise((resolve, reject) => {
    const collected: VarBind[] = [];
    session.subtree(
      oid,
      (varbinds) => {
        for (const vb of varbinds) collected.push({ oid: vb.oid, value: vb.value });
      },
      (error) => {
        if (error) reject(error);
        else resolve(collected);
      }
    );
  });
}

/** Run a callback with a fresh session, always closing it afterwards. */
export async function withSession<T>(
  target: SnmpTarget,
  fn: (session: snmp.Session) => Promise<T>
): Promise<T> {
  const session = createSession(target);
  const onError = (error: Error) => {
    // net-snmp emits errors for unreachable hosts; the promise rejects too,
    // but the listener keeps the process from logging an unhandled event.
    void error;
  };
  session.on("error", onError);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

/** The index part of an OID (everything after the column prefix). */
function indexOf(oid: string, column: string): string {
  return oid.startsWith(`${column}.`) ? oid.slice(column.length + 1) : oid;
}

/* ------------------------------------------------------------------ */
/* Data shapes                                                         */
/* ------------------------------------------------------------------ */

export interface SnmpSystemInfo {
  sysName: string;
  sysDescr: string;
  sysObjectId: string;
  sysUpTimeTicks: number | null;
  uptimeSeconds: number | null;
}

export interface SnmpInterface {
  ifIndex: number;
  ifName: string;
  ifDescr: string;
  ifType: number | null;
  adminStatus: string;
  operStatus: string;
  speedBps: number | null;
  duplex: string | null;
  mac: string | null;
  lastChange: number | null;
  inOctets: number | null;
  outOctets: number | null;
  inPackets: number | null;
  outPackets: number | null;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  /** Physical port number derived from the bridge port → ifIndex mapping. */
  portNumber: number | null;
}

export interface SnmpNeighbor {
  /** The local interface the neighbour was seen on. */
  localPort: string | null;
  localPortIndex: number | null;
  remoteSystem: string;
  remotePort: string;
  remoteDescription: string;
  remoteAddress: string | null;
  protocol: "lldp" | "cdp";
  platform: string | null;
}

export interface SnmpFdbEntry {
  mac: string;
  port: number | null;
  portName: string | null;
}

export interface SnmpArpEntry {
  ip: string;
  mac: string;
  ifIndex: number | null;
}

/* ------------------------------------------------------------------ */
/* Collectors                                                          */
/* ------------------------------------------------------------------ */

/** Read the system identity of a device. */
export async function collectSystemInfo(session: snmp.Session): Promise<SnmpSystemInfo> {
  const varbinds = await get(session, [
    OID.sysName,
    OID.sysDescr,
    OID.sysObjectID,
    OID.sysUpTime,
  ]);
  const byOid = new Map(varbinds.map((vb) => [vb.oid, vb.value]));
  const ticks = Number(byOid.get(OID.sysUpTime));
  return {
    sysName: String(byOid.get(OID.sysName) ?? ""),
    sysDescr: String(byOid.get(OID.sysDescr) ?? ""),
    sysObjectId: String(byOid.get(OID.sysObjectID) ?? ""),
    sysUpTimeTicks: Number.isFinite(ticks) ? ticks : null,
    uptimeSeconds: Number.isFinite(ticks) ? Math.floor(ticks / 100) : null,
  };
}

function operStatusName(value: unknown): string {
  const code = Number(value);
  if (code === 1) return "up";
  if (code === 2) return "down";
  if (code === 3) return "testing";
  if (code === 4) return "unknown";
  if (code === 5) return "dormant";
  if (code === 6) return "notpresent";
  if (code === 7) return "lowerlayerdown";
  return "unknown";
}

function adminStatusName(value: unknown): string {
  const code = Number(value);
  if (code === 1) return "up";
  if (code === 2) return "down";
  if (code === 3) return "testing";
  return "unknown";
}

function macFromSnmp(value: unknown): string | null {
  if (!value) return null;
  const raw = typeof value === "string" ? value : String(value);
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length < 12) return null;
  return hex
    .slice(0, 12)
    .toUpperCase()
    .replace(/(.{2})(.{2})(.{2})(.{2})(.{2})(.{2})/, "$1:$2:$3:$4:$5:$6");
}

/**
 * Read the interface table.
 *
 * 64-bit high-capacity counters are preferred; the 32-bit counters are used
 * as a fallback and the switch is flagged so the UI can say which counter
 * family the numbers came from.
 */
export async function collectInterfaces(session: snmp.Session): Promise<SnmpInterface[]> {
  const [descrs, types, speeds, phys, admin, oper, lastChange] = await Promise.all([
    subtree(session, OID.ifDescr),
    subtree(session, OID.ifType),
    subtree(session, OID.ifSpeed),
    subtree(session, OID.ifPhysAddress),
    subtree(session, OID.ifAdminStatus),
    subtree(session, OID.ifOperStatus),
    subtree(session, OID.ifLastChange),
  ]);

  const [inOctets, outOctets, inPackets, outPackets, inErrors, outErrors, inDiscards, outDiscards] =
    await Promise.all([
      subtree(session, OID.ifHCInOctets).catch(() => [] as VarBind[]),
      subtree(session, OID.ifHCOutOctets).catch(() => [] as VarBind[]),
      subtree(session, OID.ifHCInUcastPkts).catch(() => [] as VarBind[]),
      subtree(session, OID.ifHCOutUcastPkts).catch(() => [] as VarBind[]),
      subtree(session, OID.ifInErrors),
      subtree(session, OID.ifOutErrors),
      subtree(session, OID.ifInDiscards),
      subtree(session, OID.ifOutDiscards),
    ]);

  const highSpeeds = await subtree(session, OID.ifHighSpeed).catch(() => [] as VarBind[]);
  const bridgePorts = await subtree(session, OID.dot1dBasePortIfIndex).catch(() => [] as VarBind[]);

  // bridge port → ifIndex, so the physical port number can be shown.
  const portNumberByIfIndex = new Map<number, number>();
  for (const vb of bridgePorts) {
    const ifIndex = Number(indexOf(vb.oid, OID.dot1dBasePortIfIndex));
    const port = Number(vb.value);
    if (Number.isFinite(ifIndex) && Number.isFinite(port)) portNumberByIfIndex.set(ifIndex, port);
  }

  const map = (varbinds: VarBind[], column: string): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    for (const vb of varbinds) out.set(indexOf(vb.oid, column), vb.value);
    return out;
  };

  const descrMap = map(descrs, OID.ifDescr);
  const typeMap = map(types, OID.ifType);
  const speedMap = map(speeds, OID.ifSpeed);
  const physMap = map(phys, OID.ifPhysAddress);
  const adminMap = map(admin, OID.ifAdminStatus);
  const operMap = map(oper, OID.ifOperStatus);
  const changeMap = map(lastChange, OID.ifLastChange);
  const highSpeedMap = map(highSpeeds, OID.ifHighSpeed);
  const inOctetsMap = map(inOctets, OID.ifHCInOctets);
  const outOctetsMap = map(outOctets, OID.ifHCOutOctets);
  const inPacketMap = map(inPackets, OID.ifHCInUcastPkts);
  const outPacketMap = map(outPackets, OID.ifHCOutUcastPkts);
  const inErrorMap = map(inErrors, OID.ifInErrors);
  const outErrorMap = map(outErrors, OID.ifOutErrors);
  const inDiscardMap = map(inDiscards, OID.ifInDiscards);
  const outDiscardMap = map(outDiscards, OID.ifOutDiscards);

  const interfaces: SnmpInterface[] = [];
  for (const [index, description] of descrMap) {
    const ifIndex = Number(index);
    if (!Number.isFinite(ifIndex)) continue;
    const highSpeedMbps = Number(highSpeedMap.get(index));
    const speedBps =
      Number.isFinite(highSpeedMbps) && highSpeedMbps > 0
        ? highSpeedMbps * 1_000_000
        : Number(speedMap.get(index)) || null;
    const oper = operStatusName(operMap.get(index));
    interfaces.push({
      ifIndex,
      ifName: String(description ?? `if${ifIndex}`),
      ifDescr: String(description ?? ""),
      ifType: Number(typeMap.get(index)) ?? null,
      adminStatus: adminStatusName(adminMap.get(index)),
      operStatus: oper,
      speedBps: speedBps && speedBps < 4_294_967_296 ? speedBps : speedBps || null,
      duplex: speedBps && speedBps > 0 ? "full" : null,
      mac: macFromSnmp(physMap.get(index)),
      lastChange: Number(changeMap.get(index)) ?? null,
      inOctets: Number(inOctetsMap.get(index)) || null,
      outOctets: Number(outOctetsMap.get(index)) || null,
      inPackets: Number(inPacketMap.get(index)) || null,
      outPackets: Number(outPacketMap.get(index)) || null,
      inErrors: Number(inErrorMap.get(index)) || null,
      outErrors: Number(outErrorMap.get(index)) || null,
      inDiscards: Number(inDiscardMap.get(index)) || null,
      outDiscards: Number(outDiscardMap.get(index)) || null,
      portNumber: portNumberByIfIndex.get(ifIndex) ?? null,
    });
  }
  return interfaces;
}

/** Read LLDP neighbours (LLDP-MIB). */
export async function collectLldpNeighbors(session: snmp.Session): Promise<SnmpNeighbor[]> {
  const [chassis, portIds, portDescs, sysNames, sysDescs, addresses] = await Promise.all([
    subtree(session, OID.lldpRemChassisId),
    subtree(session, OID.lldpRemPortId),
    subtree(session, OID.lldpRemPortDesc),
    subtree(session, OID.lldpRemSysName),
    subtree(session, OID.lldpRemSysDesc),
    subtree(session, OID.lldpRemManAddr).catch(() => [] as VarBind[]),
  ]);

  const byIndex = (varbinds: VarBind[], column: string): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    for (const vb of varbinds) out.set(indexOf(vb.oid, column), vb.value);
    return out;
  };

  const chassisMap = byIndex(chassis, OID.lldpRemChassisId);
  const portIdMap = byIndex(portIds, OID.lldpRemPortId);
  const portDescMap = byIndex(portDescs, OID.lldpRemPortDesc);
  const sysNameMap = byIndex(sysNames, OID.lldpRemSysName);
  const sysDescMap = byIndex(sysDescs, OID.lldpRemSysDesc);
  const addressMap = byIndex(addresses, OID.lldpRemManAddr);

  const neighbors: SnmpNeighbor[] = [];
  for (const [index, chassisId] of chassisMap) {
    const parts = index.split(".");
    // lldpRemIndex = timeMark . localChassisIdSubtype . localChassisId . localPortNum . remIndex
    const localPortNum = parts.length >= 4 ? Number(parts[3]) : null;
    neighbors.push({
      localPort: null,
      localPortIndex: Number.isFinite(localPortNum) ? localPortNum : null,
      remoteSystem: String(sysNameMap.get(index) ?? chassisId ?? "unknown"),
      remotePort: String(portIdMap.get(index) ?? portDescMap.get(index) ?? "unknown"),
      remoteDescription: String(sysDescMap.get(index) ?? ""),
      remoteAddress: addressMap.has(index) ? String(addressMap.get(index)) : null,
      protocol: "lldp",
      platform: null,
    });
  }
  return neighbors;
}

/** Read CDP neighbours (CISCO-CDP-MIB). */
export async function collectCdpNeighbors(session: snmp.Session): Promise<SnmpNeighbor[]> {
  const [addresses, deviceIds, devicePorts, platforms] = await Promise.all([
    subtree(session, OID.cdpCacheAddress),
    subtree(session, OID.cdpCacheDeviceId),
    subtree(session, OID.cdpCacheDevicePort),
    subtree(session, OID.cdpCachePlatform).catch(() => [] as VarBind[]),
  ]);

  const byIndex = (varbinds: VarBind[], column: string): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    for (const vb of varbinds) out.set(indexOf(vb.oid, column), vb.value);
    return out;
  };

  const addressMap = byIndex(addresses, OID.cdpCacheAddress);
  const deviceIdMap = byIndex(deviceIds, OID.cdpCacheDeviceId);
  const devicePortMap = byIndex(devicePorts, OID.cdpCacheDevicePort);
  const platformMap = byIndex(platforms, OID.cdpCachePlatform);

  const neighbors: SnmpNeighbor[] = [];
  for (const [index, address] of addressMap) {
    const parts = index.split(".");
    const localPortNum = parts.length >= 2 ? Number(parts[1]) : null;
    neighbors.push({
      localPort: null,
      localPortIndex: Number.isFinite(localPortNum) ? localPortNum : null,
      remoteSystem: String(deviceIdMap.get(index) ?? "unknown"),
      remotePort: String(devicePortMap.get(index) ?? "unknown"),
      remoteDescription: "",
      remoteAddress: typeof address === "string" ? address : null,
      protocol: "cdp",
      platform: platformMap.has(index) ? String(platformMap.get(index)) : null,
    });
  }
  return neighbors;
}

/** Read the MAC forwarding table (BRIDGE-MIB + Q-BRIDGE-MIB). */
export async function collectFdb(session: snmp.Session): Promise<SnmpFdbEntry[]> {
  const entries: SnmpFdbEntry[] = [];
  const read = async (addressOid: string, portOid: string) => {
    const [addresses, ports] = await Promise.all([
      subtree(session, addressOid).catch(() => [] as VarBind[]),
      subtree(session, portOid).catch(() => [] as VarBind[]),
    ]);
    const portMap = new Map<string, unknown>();
    for (const vb of ports) portMap.set(indexOf(vb.oid, portOid), vb.value);
    for (const vb of addresses) {
      const index = indexOf(vb.oid, addressOid);
      const mac = macFromSnmp(vb.value);
      if (!mac) continue;
      const port = Number(portMap.get(index));
      entries.push({ mac, port: Number.isFinite(port) ? port : null, portName: null });
    }
  };
  await read(OID.dot1dTpFdbAddress, OID.dot1dTpFdbPort);
  await read(OID.dot1qTpFdbAddress, OID.dot1qTpFdbPort);
  return entries;
}

/**
 * Read the IPv4 ARP cache (IP-MIB).
 *
 * `ipNetToMediaPhysAddress` is indexed by <ifIndex>.<a>.<b>.<c>.<d> and holds
 * the MAC; `ipAdEntAddr` is indexed by <a>.<b>.<c>.<d>.<ifIndex> and holds the
 * IP. Both are walked and the two tables are joined on the address.
 */
export async function collectArp(session: snmp.Session): Promise<SnmpArpEntry[]> {
  const [phys, addresses] = await Promise.all([
    subtree(session, OID.ipNetToMediaPhysAddress).catch(() => [] as VarBind[]),
    subtree(session, OID.ipAdEntAddr).catch(() => [] as VarBind[]),
  ]);

  // ifIndex → MAC, keyed by the dotted IP taken from the table index.
  const macByIp = new Map<string, { mac: string; ifIndex: number | null }>();
  for (const vb of phys) {
    const index = indexOf(vb.oid, OID.ipNetToMediaPhysAddress);
    const parts = index.split(".");
    if (parts.length < 5) continue;
    const ifIndex = Number(parts[0]);
    const ip = parts.slice(1, 5).join(".");
    const mac = macFromSnmp(vb.value);
    if (!mac) continue;
    macByIp.set(ip, { mac, ifIndex: Number.isFinite(ifIndex) ? ifIndex : null });
  }

  // The address table confirms which IPs are actually in use.
  const knownIps = new Set<string>();
  for (const vb of addresses) {
    const index = indexOf(vb.oid, OID.ipAdEntAddr);
    const parts = index.split(".");
    if (parts.length < 5) continue;
    knownIps.add(parts.slice(0, 4).join("."));
  }

  const entries: SnmpArpEntry[] = [];
  for (const [ip, record] of macByIp) {
    // If the address table was readable, only report addresses it confirms.
    if (knownIps.size > 0 && !knownIps.has(ip)) continue;
    entries.push({ ip, mac: record.mac, ifIndex: record.ifIndex });
  }
  return entries;
}

/**
 * Test whether a device answers SNMP at all.
 *
 * Used by the setup wizard ("test access to the first network device") and
 * by the credential manager before a credential is saved.
 */
export async function testSnmpAccess(target: SnmpTarget): Promise<{
  ok: boolean;
  reason: string;
  sysName?: string;
  sysDescr?: string;
}> {
  try {
    return await withSession(target, async (session) => {
      const info = await collectSystemInfo(session);
      if (!info.sysName && !info.sysDescr) {
        return { ok: false, reason: "The device answered but returned no system information." };
      }
      return {
        ok: true,
        reason: "The device answered the SNMP request.",
        sysName: info.sysName,
        sysDescr: info.sysDescr,
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `SNMP request failed: ${message}`,
    };
  }
}
