/**
 * ============================================================================
 *  types.ts — the companion app's wire + local contracts
 * ============================================================================
 *
 *  These mirror the bridge's own src/lib/types.ts. They are duplicated rather
 *  than imported because the app is a separate toolchain (Metro/Hermes) with
 *  no access to the Next.js source tree — keep the two in step when either
 *  side's payload changes. Every shape here was taken from the live handlers:
 *    POST /api/mobile/login          → MobileLoginResponse
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
  | "GEOFENCE_NOT_CONFIGURED";

export type PunchDirection = "IN" | "OUT";
export type ErpSyncStatus = "Pending" | "Success" | "Failed";
export type VerifyResult = "Verified" | "Denied";

/* ------------------------------------------------------------------ */
/* POST /api/mobile/login                                              */
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
 * One registered site this phone may clock in at (Phase 17).
 *
 * Sign-in returns EVERY eligible site, not just the employee's roster branch:
 * an employee travels, so the fence that counts is the one they are standing
 * in. The bridge stays authoritative — it re-derives the governing site from
 * each GPS fix — so this list is only "which fences to listen for".
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

export interface MobileLoginResponse {
  ok: boolean;
  message: string;
  employee: {
    employeeId: number;
    erpUserId: string;
    fullName: string;
    department: string;
    branch: string;
  };
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

/** What the phone must hold to clock someone hands-free, offline included. */
export interface MobileSession {
  employee: MobileLoginResponse["employee"];
  /**
   * Every site this phone may clock in at (Phase 17). The background engine
   * watches all of them; the bridge decides which one a punch belongs to.
   */
  fences: GeoFenceSite[];
  /** The employee's own site — display only ("Home site"). */
  geofence: GeofenceConfig | null;
  /** Bridge base URL this identity was verified against (no trailing slash). */
  apiUrl: string;
  /** Shared secret sent as `x-mobile-key`. */
  mobileKey: string;
  signedInAt: number;
  /** True when this identity came from the cached session (bridge unreachable). */
  offline: boolean;
}

/* ------------------------------------------------------------------ */
/* POST /api/attendance/geopunch                                       */
/* ------------------------------------------------------------------ */

/**
 * The punch body. `direction` is deliberately omitted by the automatic path:
 * the bridge infers IN/OUT from the employee's punch sequence for the day,
 * which is the only way a hands-free punch can know which way it is going.
 */
export interface GeoPunchPayload {
  /** ERP_User_ID — the ref the bridge resolves to a roster row. */
  employeeRef: string;
  latitude: number;
  longitude: number;
  /** Device-reported GPS accuracy in metres. */
  accuracyMeters?: number | null;
  /**
   * Optional explicit site. The app deliberately does NOT send this on the
   * normal hands-free path (Phase 17): the bridge works the site out from the
   * coordinates, so a phone cannot claim a branch it is not standing in.
   * Kept for a scanned terminal/QR override and for payloads already sitting
   * in the offline queue.
   */
  branchRef?: string | null;
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
    /** Phase 17 — how the governing site was chosen, and what was nearest. */
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

/**
 * The "has this employee actually stayed put?" record.
 *
 * It is written by the geofence ENTER event, updated by every background
 * location fix, and cleared only when the employee leaves the fence — which
 * is what makes one punch happen per visit rather than per dwell window.
 */
export interface DwellState {
  /**
   * The site this visit belongs to (Phase 17). The engine watches every
   * registered fence, so the dwell has to remember WHICH one it armed on —
   * otherwise walking from one branch to another could punch at the old site.
   * Optional because a state written by an earlier build has no field for it.
   */
  branch?: string | null;
  /** epoch ms of the first fix that found the employee inside the fence. */
  enteredAt: number;
  /** epoch ms of the most recent inside fix. */
  lastFixAt: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Count of inside fixes since entering — the continuity proof. */
  samples: number;
  /** Set the instant the punch is claimed, so a later wake-up cannot re-fire. */
  firedAt: number | null;
  /** Result of the automatic punch, for the dashboard's status card. */
  outcome: "Sent" | "Queued" | "Rejected" | null;
  outcomeMessage: string | null;
}
