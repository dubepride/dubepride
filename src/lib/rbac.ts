/**
 * ============================================================================
 *  rbac.ts — the Access Level Matrix (Phase 13/14)
 * ============================================================================
 *
 *  Single source of truth for every system function that can be gated by an
 *  Access Level. The Settings → "Access Levels" tab renders these groups and
 *  checkboxes; the sidebar, page components and the server-side proxy all
 *  consume the same keys, so a checkbox ticked by the IT admin immediately
 *  controls what every signed-in account can see and do.
 *
 *  Pure module (no React / no DB / no next imports) so it can be bundled into:
 *    • the server (db.ts, proxy.ts, API route handlers)
 *    • the client (AuthContext, Sidebar, Settings matrix, My Portal)
 *
 *  Permissions persist as a flat JSON object of `key → boolean` into
 *  Access_Levels.Permissions_JSON. Unknown keys in stored JSON are ignored
 *  on read and the object always carries every current key, so levels never
 *  go stale when the catalog grows.
 */

/**
 * Literal union of every gateable capability. Import this type anywhere a
 * permission key is accepted so the compiler rejects typos.
 */
export type PermissionKey =
  | "can_view_dashboard"
  | "can_view_my_portal"
  | "can_remote_clock"
  | "can_view_my_history"
  | "can_request_time_off"
  | "can_view_employees"
  | "can_add_employee"
  | "can_edit_employee"
  | "can_delete_employee"
  | "can_manage_fingerprints"
  | "can_view_attendance"
  | "can_manage_shifts"
  | "can_view_reports"
  | "can_export_reports"
  | "can_view_exceptions"
  | "can_view_whos_in"
  | "can_view_devices"
  | "can_config_devices"
  | "can_view_sync"
  | "can_view_settings"
  | "can_edit_settings"
  | "can_manage_branches"
  | "can_manage_access_levels"
  | "can_add_accounts";

export interface PermissionDef {
  key: PermissionKey;
  label: string;
}

export interface PermissionGroup {
  /** Module heading inside the matrix UI ("Employee Management" …). */
  module: string;
  perms: readonly PermissionDef[];
}

/** Every permission key in catalogue order (matrix rows read top → bottom). */
export const PERMISSION_KEYS: readonly PermissionKey[] = [
  "can_view_dashboard",
  "can_view_my_portal",
  "can_remote_clock",
  "can_view_my_history",
  "can_request_time_off",
  "can_view_employees",
  "can_add_employee",
  "can_edit_employee",
  "can_delete_employee",
  "can_manage_fingerprints",
  "can_view_attendance",
  "can_manage_shifts",
  "can_view_reports",
  "can_export_reports",
  "can_view_exceptions",
  "can_view_whos_in",
  "can_view_devices",
  "can_config_devices",
  "can_view_sync",
  "can_view_settings",
  "can_edit_settings",
  "can_manage_branches",
  "can_manage_access_levels",
  "can_add_accounts",
];

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    module: "Dashboard",
    perms: [{ key: "can_view_dashboard", label: "View the dashboard" }],
  },
  {
    module: "My Portal",
    perms: [
      { key: "can_view_my_portal", label: "Access My Portal" },
      { key: "can_remote_clock", label: "Remote clock in / out" },
      { key: "can_view_my_history", label: "View own punch history" },
      { key: "can_request_time_off", label: "Submit time-off requests" },
    ],
  },
  {
    module: "Employee Management",
    perms: [
      { key: "can_view_employees", label: "View the employee directory" },
      { key: "can_add_employee", label: "Add employees" },
      { key: "can_edit_employee", label: "Edit employee records" },
      { key: "can_delete_employee", label: "Delete employees" },
      { key: "can_manage_fingerprints", label: "Manage fingerprint enrolment" },
    ],
  },
  {
    module: "Attendance",
    perms: [{ key: "can_view_attendance", label: "View attendance records" }],
  },
  {
    module: "Shifts",
    perms: [{ key: "can_manage_shifts", label: "Manage shifts" }],
  },
  {
    module: "Reports",
    perms: [
      { key: "can_view_reports", label: "View reports" },
      { key: "can_export_reports", label: "Export & print reports" },
    ],
  },
  {
    module: "Exceptions",
    perms: [{ key: "can_view_exceptions", label: "View exceptions" }],
  },
  {
    module: "Who's In",
    perms: [{ key: "can_view_whos_in", label: "View Who's In" }],
  },
  {
    module: "Clocking Devices",
    perms: [
      { key: "can_view_devices", label: "View clocking devices" },
      { key: "can_config_devices", label: "Configure devices" },
    ],
  },
  {
    module: "ERP Sync",
    perms: [{ key: "can_view_sync", label: "View ERP sync logs" }],
  },
  {
    module: "Settings",
    perms: [
      { key: "can_view_settings", label: "Open Settings" },
      { key: "can_edit_settings", label: "Edit general settings" },
      { key: "can_manage_branches", label: "Manage branches" },
      { key: "can_manage_access_levels", label: "Manage access levels" },
      { key: "can_add_accounts", label: "Manage system accounts" },
    ],
  },
];

/** Flat boolean map — the wire shape of Access_Levels.Permissions_JSON. */
export type PermissionsMap = Record<PermissionKey, boolean>;

/** `true` for every key — the "IT Administrator" baseline. */
export function allPermissions(enabled: boolean): PermissionsMap {
  const map = {} as PermissionsMap;
  for (const key of PERMISSION_KEYS) map[key] = enabled;
  return map;
}

/**
 * Normalise an arbitrary stored value into a full PermissionsMap.
 * Accepts either a parsed object OR a raw JSON string (as read straight
 * from the Permissions_JSON TEXT column). Unknown keys are dropped, known
 * keys default to false — a malformed or partial JSON column still yields
 * a predictable, total matrix.
 */
export function parsePermissions(raw: unknown): PermissionsMap {
  const map = allPermissions(false);
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      obj = null;
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  }
  if (obj) {
    for (const key of PERMISSION_KEYS) {
      if (obj[key] === true) map[key] = true;
    }
  }
  return map;
}

/** Encode a PermissionsMap back into the Persmissions_JSON column. */
export function serializePermissions(permissions: PermissionsMap): string {
  return JSON.stringify(permissions);
}

/** How many capabilities are switched on for a level (matrix summary chip). */
export function countEnabled(permissions: PermissionsMap): number {
  return PERMISSION_KEYS.reduce((n: number, key) => n + (permissions[key] ? 1 : 0), 0);
}

/** Human "n of m capabilities" summary used by the level list. */
export function permissionSummary(permissions: PermissionsMap): string {
  return `${countEnabled(permissions)} of ${PERMISSION_KEYS.length} capabilities`;
}