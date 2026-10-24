/**
 * ============================================================================
 *  types.ts — the Mineazy Network domain model
 * ============================================================================
 *
 *  One shared vocabulary for the whole application: the collector writes
 *  observations using these shapes, the API serialises them, and the UI
 *  renders them. Nothing else in the codebase is allowed to invent a status
 *  string — `HealthState` is the closed set of conditions the product can
 *  report (see `health.ts` for how each one is *earned* from evidence).
 *
 *  Pure module: no React, no database, no next/* imports — safe to import
 *  from the collector, the API routes and the browser bundle alike.
 */

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

/**
 * The closed set of device / connection conditions.
 *
 * These are deliberately NOT collapsed into a single "online / offline"
 * flag. A switch with a dead uplink is not the same as a workstation that
 * stopped answering, and neither is the same as "the collector stopped
 * collecting".
 */
export type HealthState =
  /** Reachable and all configured checks are passing. */
  | "ONLINE"
  /** Failed the configured reachability checks for N consecutive attempts. */
  | "OFFLINE"
  /** Reachable, but a monitored service / interface / threshold is failing. */
  | "DEGRADED"
  /** A managed switch reports the physical/operational link as down. */
  | "LINK_DOWN"
  /** Local networking works but external connectivity checks are failing. */
  | "NO_INTERNET"
  /** Counters are readable but no new traffic was measured in the window. */
  | "NO_TRAFFIC"
  /** Not enough evidence to decide. */
  | "UNKNOWN"
  /** In the inventory, but active monitoring was never configured. */
  | "UNMONITORED"
  /** The newest observation is older than the configured freshness threshold. */
  | "STALE";

export const HEALTH_STATES: readonly HealthState[] = [
  "ONLINE",
  "OFFLINE",
  "DEGRADED",
  "LINK_DOWN",
  "NO_INTERNET",
  "NO_TRAFFIC",
  "UNKNOWN",
  "UNMONITORED",
  "STALE",
];

/** Severity of an incident. */
export type Severity = "critical" | "major" | "minor" | "info";

/** Every severity in descending order. */
export const SEVERITIES: readonly Severity[] = ["critical", "major", "minor", "info"];

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

/**
 * Device categories. The first four are infrastructure, the rest are
 * endpoints; `unknown` is the honest default when classification evidence
 * is insufficient.
 */
export type DeviceCategory =
  | "internet"
  | "router"
  | "gateway"
  | "switch"
  | "desktop"
  | "laptop"
  | "phone"
  | "tablet"
  | "printer"
  | "server"
  | "nvr"
  | "camera"
  | "access_point"
  | "nas"
  | "voip_phone"
  | "industrial"
  | "unknown";

export const DEVICE_CATEGORIES: readonly DeviceCategory[] = [
  "internet",
  "router",
  "gateway",
  "switch",
  "desktop",
  "laptop",
  "phone",
  "tablet",
  "printer",
  "server",
  "nvr",
  "camera",
  "access_point",
  "nas",
  "voip_phone",
  "industrial",
  "unknown",
];

/** Categories that behave like infrastructure (own ports, polled via SNMP). */
export const INFRASTRUCTURE_CATEGORIES: readonly DeviceCategory[] = [
  "internet",
  "router",
  "gateway",
  "switch",
  "access_point",
];

/** How a device's identity was established. */
export type DiscoverySource =
  | "snmp_system"
  | "snmp_neighbour"
  | "snmp_fdb"
  | "arp"
  | "active_scan"
  | "manual"
  | "import"
  | "simulated"
  | "unknown";

export const DISCOVERY_SOURCES: readonly DiscoverySource[] = [
  "snmp_system",
  "snmp_neighbour",
  "snmp_fdb",
  "arp",
  "active_scan",
  "manual",
  "import",
  "simulated",
  "unknown",
];

/** Confidence in the automatic classification of a device. */
export type Confidence = "confirmed" | "probable" | "unknown";

/** How the monitoring engine decides a device's health. */
export type MonitorMethod = "snmp" | "icmp" | "tcp" | "http" | "none";

export const MONITOR_METHODS: readonly MonitorMethod[] = ["snmp", "icmp", "tcp", "http", "none"];

/** How much a device matters to the business. */
export type Criticality = "critical" | "important" | "standard";

export const CRITICALITIES: readonly Criticality[] = ["critical", "important", "standard"];

/* ------------------------------------------------------------------ */
/* Ports + connections                                                 */
/* ------------------------------------------------------------------ */

/** A physical/logical interface on a device (a switch port, a router LAN port…). */
export interface NetworkPort {
  id: number;
  deviceId: number;
  /** SNMP ifIndex when the port came from SNMP; otherwise a synthetic id. */
  ifIndex: number | null;
  /** Real interface identifier reported by the device (e.g. "GigabitEthernet1/0/5"). */
  ifName: string;
  /** Physical port number when derivable (1-based). */
  portNumber: number | null;
  /** Port description / alias reported by the device. */
  description: string;
  /** "up" | "down" | "testing" | "unknown" */
  adminState: string;
  /** "up" | "down" | "testing" | "unknown" */
  operState: string;
  /** Negotiated link speed in bits/second; null when the device does not report it. */
  speedBps: number | null;
  /** "full" | "half" | null */
  duplex: string | null;
  /** VLAN id when reported. */
  vlan: number | null;
  /** Timestamp of the last operational state change. */
  lastStateChange: number | null;
  inOctets: number | null;
  outOctets: number | null;
  inPackets: number | null;
  outPackets: number | null;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  /** Most recent calculated inbound rate in bits/second. */
  inRateBps: number | null;
  /** Most recent calculated outbound rate in bits/second. */
  outRateBps: number | null;
  lastPolledAt: number | null;
  /** Which protocol produced the last numbers. */
  source: string;
  /** Admin-assigned label (never overwritten by discovery). */
  label: string;
  notes: string;
  /** True when the port belongs to a managed switch we can trust for link state. */
  managed: boolean;
}

/** How a connection between two devices was established. */
export type ConnectionSource =
  | "lldp"
  | "cdp"
  | "fdb"
  | "arp"
  | "active_scan"
  | "manual"
  | "import"
  | "simulated"
  | "unknown";

export const CONNECTION_SOURCES: readonly ConnectionSource[] = [
  "lldp",
  "cdp",
  "fdb",
  "arp",
  "active_scan",
  "manual",
  "import",
  "simulated",
  "unknown",
];

/** The physical shape of a connection. */
export type ConnectionType =
  | "wan"        // internet source → gateway
  | "uplink"     // switch → switch
  | "access"     // switch → endpoint
  | "unknown";

export interface Connection {
  id: number;
  localDeviceId: number;
  localPortId: number | null;
  remoteDeviceId: number;
  remotePortId: number | null;
  type: ConnectionType;
  source: ConnectionSource;
  /** 0..1 — how sure we are about this link. */
  confidence: number;
  /** True when an administrator has confirmed this record. */
  verified: boolean;
  /** Cable identifier (asset tag on the patch lead). */
  cableId: string;
  /** Physical destination written on the port / cable. */
  cableDestination: string;
  notes: string;
  /** Evidence-backed link state: "up" | "down" | "degraded" | "unknown". */
  state: string;
  /** Why the link has that state — shown verbatim in the incident detail. */
  evidence: string;
  lastObservedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Observations, traffic, incidents, events                            */
/* ------------------------------------------------------------------ */

/** One monitoring probe result. */
export interface HealthObservation {
  id?: number;
  deviceId: number;
  portId: number | null;
  observedAt: number;
  probeType: "icmp" | "tcp" | "http" | "snmp" | "link";
  probeTarget: string;
  result: "success" | "failure" | "skipped" | "error";
  latencyMs: number | null;
  reason: string;
  source: string;
}

/** A traffic sample for a device (aggregated) or a single port. */
export interface TrafficSample {
  subjectType: "device" | "port";
  subjectId: number;
  sampledAt: number;
  inBytes: number | null;
  outBytes: number | null;
  inRateBps: number | null;
  outRateBps: number | null;
  inPps: number | null;
  outPps: number | null;
  inErrors: number | null;
  outErrors: number | null;
  /** False when a counter reset/rollover made the derived rate meaningless. */
  counterValid: boolean;
  /** Seconds the rate was measured over. */
  windowSeconds: number | null;
  source: string;
}

export type IncidentState = "open" | "acknowledged" | "resolved";

export interface Incident {
  id: number;
  /** Deduplication key — one open incident per key. */
  key: string;
  category: string;
  severity: Severity;
  title: string;
  deviceId: number | null;
  connectionId: number | null;
  startedAt: number;
  updatedAt: number;
  recoveredAt: number | null;
  state: IncidentState;
  evidence: string;
  /** JSON array of affected device ids. */
  affected: number[];
  /** Human-readable probable fault location. */
  faultLocation: string;
  confidence: number;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  assignedTo: string | null;
  notes: string;
}

export type EventType =
  | "device_discovered"
  | "device_unreachable"
  | "device_recovered"
  | "device_state_changed"
  | "port_state_changed"
  | "uplink_failed"
  | "uplink_recovered"
  | "internet_failed"
  | "internet_recovered"
  | "interface_errors"
  | "traffic_threshold"
  | "collector_stale"
  | "config_changed"
  | "discovery_completed"
  | "incident_raised"
  | "incident_recovered"
  | "database_checkpoint";

export interface NetworkEvent {
  id: number;
  at: number;
  type: EventType;
  severity: Severity;
  title: string;
  detail: string;
  subjectType: "device" | "connection" | "port" | "system";
  subjectId: number | null;
  source: string;
}

/* ------------------------------------------------------------------ */
/* Inventory records                                                   */
/* ------------------------------------------------------------------ */

export interface Device {
  id: number;
  name: string;
  hostname: string;
  category: DeviceCategory;
  manufacturer: string;
  model: string;
  serial: string;
  siteId: number | null;
  locationId: number | null;
  /** Management / observed IP address. */
  mgmtIp: string;
  mac: string;
  os: string;
  notes: string;
  criticality: Criticality;
  monitoringEnabled: boolean;
  monitorMethod: MonitorMethod;
  pollIntervalSeconds: number;
  failureThreshold: number;
  discoverySource: DiscoverySource;
  classificationConfidence: Confidence;
  /** Why the device was put in that category, in plain words. */
  classificationEvidence: string;
  healthState: HealthState;
  healthReason: string;
  firstDiscoveredAt: number | null;
  lastSeenAt: number | null;
  lastObservedAt: number | null;
  /** True while the collector is producing this device's observations. */
  simulated: boolean;
  layoutX: number | null;
  layoutY: number | null;
  createdAt: number;
  updatedAt: number;
  /** Extra IPs observed for this device. */
  ipAddresses?: string[];
  /** Extra MACs observed for this device. */
  macAddresses?: string[];
}

export interface Site {
  id: number;
  name: string;
  description: string;
  createdAt: number;
}

export interface Location {
  id: number;
  siteId: number | null;
  name: string;
  building: string;
  room: string;
  notes: string;
  createdAt: number;
}

export interface User {
  id: number;
  username: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export type UserRole = "administrator" | "operator" | "viewer";

export const USER_ROLES: readonly UserRole[] = ["administrator", "operator", "viewer"];

/* ------------------------------------------------------------------ */
/* Wire shapes used by the API                                        */
/* ------------------------------------------------------------------ */

export interface TopologyNode {
  id: string;
  deviceId: number;
  name: string;
  category: DeviceCategory;
  state: HealthState;
  /** Why the device is in that state, in plain words. */
  reason: string;
  parentId: string | null;
  locationName: string | null;
  ip: string | null;
  portLabel: string | null;
  /** Downstream device count (supplementary, never a replacement for detail). */
  childCount: number;
  x: number;
  y: number;
  /* --- Inventory detail, so the node is readable without opening it ------ */
  manufacturer: string;
  model: string;
  mac: string;
  /** Sum of the measured port rates on this device, bits/second. */
  inRateBps: number | null;
  outRateBps: number | null;
  /** Number of managed ports the device exposes (0 when none are known). */
  portCount: number;
}

export interface TopologyEdge {
  id: string;
  connectionId: number | null;
  source: string;
  target: string;
  state: string;
  sourceType: ConnectionSource;
  label: string;
  cableId: string;
  speedBps: number | null;
  inRateBps: number | null;
  outRateBps: number | null;
  verified: boolean;
  confidence: number;
  /* --- The cable as an object, for the connection inspector ------------- */
  /** Parent-side interface label ("lan0"), empty when the port is unknown. */
  sourcePort: string;
  /** Child-side interface label ("GigabitEthernet1/0/1"), empty when unknown. */
  targetPort: string;
  sourcePortId: number | null;
  targetPortId: number | null;
  /** Managed-port operational state: true up, false down, null not reported. */
  sourceLinkUp: boolean | null;
  targetLinkUp: boolean | null;
  /**
   * The physical link, kept separate from the end-to-end path state. A cable
   * can be physically up while the internet beyond it is unreachable.
   */
  physicalState: "up" | "down" | "unknown";
  connectionType: string;
  /** The evidence sentence recorded when the link state was decided. */
  evidence: string;
  lastObservedAt: number | null;
  cableDestination: string;
  inErrors: number | null;
  outErrors: number | null;
  inDiscards: number | null;
  outDiscards: number | null;
  /**
   * Where the rates came from: a switch port's counters, or the device's own
   * aggregate counters when the cable has no managed port behind it.
   */
  rateSource: "port" | "device" | null;
}

export interface TopologySnapshot {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generatedAt: number;
  /** Freshness of the newest observation in the snapshot. */
  lastObservationAt: number | null;
  /** True when the data comes from the labelled simulator, not real hardware. */
  simulated: boolean;
}
