/**
 * ============================================================================
 *  types.ts — the companion app's wire + local contracts
 * ============================================================================
 *
 *  These mirror the bridge's own src/lib/types.ts. Every shape here matches
 *  the live handlers:
 *    POST /api/mobile/login          → MobileLoginResponse
 *    GET  /api/mobile/geofences      → live geofences + employee + dayStatus
 *    POST /api/attendance/geopunch   → GeoPunchResponse
 */

/** How a site accepts clock-ins — mirrors the bridge's ClockingMethod. */
export type ClockingMethod = "Biometric" | "Geofence" | "Both";

/** Machine-readable punch outcome — the app switches on this, never on prose. */
export type GeoPunchReason =
  | "CLOCKED_IN"
  | "CLOCKED_OUT"
  | "OUTSIDE_GEOFENCE"
  | "BIOMETRIC_ONLY"
  | "UNAUTHORIZED_DEVICE"
  | "GEOFENCE_NOT_CONFIGURED";

export type PunchDirection = "IN" | "OUT";
export type ErpSyncStatus = "Pending" | "Success" | "Failed";
export type VerifyResult = "Verified" | "Denied";

/* ------------------------------------------------------------------ */
/* POST /api/mobile/login & GET /api/mobile/geofences                  */
/* ------------------------------------------------------------------ */

export interface GeofenceConfig {
  /** False when the site allows mobile clocking but has no centre/radius yet. */
  configured: boolean;
  method: ClockingMethod;
  label: string | null;
  branch: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number | null;
}

/**
 * One registered site this phone may clock in at.
 */
export interface GeoFenceSite {
  id: number;
  /** Branches.Branch_Name — what the bridge reports as the detected site. */
  branch: string;
  method: ClockingMethod;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface MobileEmployee {
  employeeId: number;
  erpUserId: string;
  fullName: string;
  department: string;
  branch: string;
  status?: string;
  boundDeviceId?: string | null;
  boundDeviceName?: string | null;
  boundDeviceAt?: number | null;
}

export interface MobileDayStatus {
  clockedIn: boolean;
  lastPunchAt: number | null;
  lastDirection: PunchDirection | null;
}

export interface MobileLoginResponse {
  ok: boolean;
  message: string;
  employee: MobileEmployee;
  /** The employee's own (roster) site — displayed as "Home site". */
  geofence: GeofenceConfig | null;
  /** Every site this phone may clock in at. Empty = nothing set up yet. */
  fences: GeoFenceSite[];
  generatedAt: number;
  reason?: GeoPunchReason;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Local session (SecureStore)                                         */
/* ------------------------------------------------------------------ */

/** What the phone holds to authenticate punches and display live site data. */
export interface MobileSession {
  employee: MobileEmployee;
  /** Every site this phone may clock in at. */
  fences: GeoFenceSite[];
  /** The employee's own site — display ("Home site"). */
  geofence: GeofenceConfig | null;
  /** Live day status synced from the main system. */
  dayStatus?: MobileDayStatus | null;
  /** Bridge base URL this identity was verified against (no trailing slash). */
  apiUrl: string;
  /** Shared secret sent as `x-mobile-key`. */
  mobileKey: string;
  /** Persistent hardware device ID locked to this employee on first login. */
  deviceId?: string;
  deviceName?: string;
  signedInAt: number;
  /** True when this identity came from the cached session (bridge unreachable). */
  offline: boolean;
}

/* ------------------------------------------------------------------ */
/* POST /api/mobile/presence — Field Tracker heartbeat                 */
/* ------------------------------------------------------------------ */

/** Latest location reported by a signed-in phone (no history). */
export interface PresencePayload {
  /** ERP_User_ID — the ref the bridge resolves to a roster row. */
  employeeRef: string;
  latitude: number;
  longitude: number;
  /** Device-reported GPS accuracy in metres. */
  accuracyMeters?: number | null;
  /** Display hint only — the server decides fence containment. */
  branch?: string | null;
  /** epoch ms of the fix (clamped server-side). */
  timestamp?: number;
  deviceId?: string | null;
  deviceName?: string | null;
}

/* ------------------------------------------------------------------ */
/* POST /api/attendance/geopunch                                       */
/* ------------------------------------------------------------------ */

export interface GeoPunchPayload {
  /** ERP_User_ID — the ref the bridge resolves to a roster row. */
  employeeRef: string;
  latitude: number;
  longitude: number;
  /** Device-reported GPS accuracy in metres. */
  accuracyMeters?: number | null;
  /** Optional explicit site override. */
  branchRef?: string | null;
  /** Hardware device identifier and model name for anti-buddy clocking verification. */
  deviceId?: string | null;
  deviceName?: string | null;
  /** epoch ms — the ORIGINAL punch time, preserved verbatim through the queue. */
  timestamp: number;
}

export interface GeoPunchResponse {
  ok: boolean;
  reason: GeoPunchReason;
  message: string;
  punch: {
    logId: number | null;
    employeeId: number;
    employeeName: string;
    erpUserId: string;
    timestamp: number;
    direction: PunchDirection;
    verifyMethod: string;
    syncStatus: ErpSyncStatus | null;
    verifyResult: VerifyResult | null;
  } | null;
  geo: {
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
    distanceMeters: number;
    radiusMeters: number;
    withinGeofence: boolean;
    method: ClockingMethod;
    location: string | null;
    branch: string | null;
    detectedBy?: "terminal" | "branchRef" | "auto";
    insideAnySite?: boolean;
    nearestBranch?: string | null;
    nearestDistanceMeters?: number | null;
  } | null;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Offline queue (AsyncStorage)                                        */
/* ------------------------------------------------------------------ */

/** One punch the phone could not deliver, kept verbatim until it can. */
export interface QueuedPunch {
  /** Stable id — `${employeeRef}:${timestamp}` so a re-queue cannot duplicate. */
  id: string;
  payload: GeoPunchPayload;
  queuedAt: number;
  /** Why it was queued (transport error / bridge 5xx) — shown in the UI. */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Dwell state machine (AsyncStorage)                                  */
/* ------------------------------------------------------------------ */

export interface DwellState {
  branch?: string | null;
  enteredAt: number;
  lastFixAt: number | null;
  latitude: number | null;
  longitude: number | null;
  samples: number;
  firedAt: number | null;
  outcome: "Sent" | "Queued" | "Rejected" | null;
  outcomeMessage: string | null;
}
