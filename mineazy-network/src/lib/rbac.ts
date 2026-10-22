/**
 * ============================================================================
 *  rbac.ts — roles and capability gates
 * ============================================================================
 *
 *  Three roles, one closed set of capabilities:
 *
 *    administrator — full configuration, users, discovery, monitoring
 *    operator      — diagnostics, incident handling, inventory edits
 *    viewer        — read-only topology, states, metrics, incidents
 *
 *  Pure module (no React / no DB / no next imports) so the server, the
 *  API routes and the browser bundle can all share it. The UI hides what a
 *  role cannot do, and every API handler re-checks server-side — hiding a
 *  button is never the only barrier.
 */

export type UserRole = "administrator" | "operator" | "viewer";

export const USER_ROLES: readonly UserRole[] = ["administrator", "operator", "viewer"];

export type PermissionKey =
  /** See the console (overview, map, devices, switches, incidents…). */
  | "can_view_topology"
  /** See traffic + performance history. */
  | "can_view_traffic"
  /** See the event history and reports. */
  | "can_view_reports"
  /** Acknowledge incidents, add notes, assign. */
  | "can_manage_incidents"
  /** Edit devices, ports, locations, manual connections. */
  | "can_edit_inventory"
  /** Run discovery jobs and change authorised scan ranges. */
  | "can_run_discovery"
  /** Change monitoring configuration (intervals, thresholds, targets). */
  | "can_config_monitoring"
  /** Manage SNMP credentials (write-only from the browser). */
  | "can_manage_credentials"
  /** Manage users + roles. */
  | "can_manage_users"
  /** Import / export inventory CSV. */
  | "can_export_data";

export const PERMISSION_KEYS: readonly PermissionKey[] = [
  "can_view_topology",
  "can_view_traffic",
  "can_view_reports",
  "can_manage_incidents",
  "can_edit_inventory",
  "can_run_discovery",
  "can_config_monitoring",
  "can_manage_credentials",
  "can_manage_users",
  "can_export_data",
];

export interface RoleDefinition {
  role: UserRole;
  label: string;
  description: string;
  permissions: Record<PermissionKey, boolean>;
}

function perms(...keys: PermissionKey[]): Record<PermissionKey, boolean> {
  const map = {} as Record<PermissionKey, boolean>;
  for (const key of PERMISSION_KEYS) map[key] = false;
  for (const key of keys) map[key] = true;
  return map;
}

/** The role catalogue. */
export const ROLES: readonly RoleDefinition[] = [
  {
    role: "administrator",
    label: "Administrator",
    description: "Full configuration, user management, discovery and monitoring controls.",
    permissions: perms(...PERMISSION_KEYS),
  },
  {
    role: "operator",
    label: "Network Operator",
    description: "Diagnostics, incident acknowledgement and authorised inventory management.",
    permissions: perms(
      "can_view_topology",
      "can_view_traffic",
      "can_view_reports",
      "can_manage_incidents",
      "can_edit_inventory",
      "can_run_discovery",
      "can_export_data"
    ),
  },
  {
    role: "viewer",
    label: "Viewer",
    description: "Read-only topology, device states, performance metrics and incidents.",
    permissions: perms("can_view_topology", "can_view_traffic", "can_view_reports"),
  },
];

/** The permission map for a role (unknown roles get read-only access). */
export function permissionsForRole(role: string): Record<PermissionKey, boolean> {
  const found = ROLES.find((r) => r.role === role);
  if (found) return { ...found.permissions };
  return perms("can_view_topology", "can_view_traffic", "can_view_reports");
}

/** Human-readable role label. */
export function roleLabel(role: string): string {
  return ROLES.find((r) => r.role === role)?.label ?? "Unknown role";
}
