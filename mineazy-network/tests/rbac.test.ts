/**
 * ============================================================================
 *  tests/rbac.test.ts — the three roles and their capability gates
 * ============================================================================
 *
 *  The UI hides what a role cannot do, but the API re-checks every request.
 *  These tests pin the capability map so a refactor cannot quietly widen a
 *  role.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  PERMISSION_KEYS,
  ROLES,
  permissionsForRole,
  roleLabel,
  USER_ROLES,
  type PermissionKey,
} from "../src/lib/rbac";

describe("the role catalogue", () => {
  test("there are exactly three roles", () => {
    assert.deepEqual([...USER_ROLES], ["administrator", "operator", "viewer"]);
    assert.equal(ROLES.length, 3);
  });

  test("every role defines every permission", () => {
    for (const role of ROLES) {
      for (const key of PERMISSION_KEYS) {
        assert.equal(typeof role.permissions[key], "boolean", `${role.role} / ${key}`);
      }
    }
  });

  test("the administrator can do everything", () => {
    const admin = permissionsForRole("administrator");
    for (const key of PERMISSION_KEYS) {
      assert.equal(admin[key], true, `administrator should hold ${key}`);
    }
  });

  test("the operator can run discovery but cannot manage credentials or users", () => {
    const operator = permissionsForRole("operator");
    assert.equal(operator.can_run_discovery, true);
    assert.equal(operator.can_manage_incidents, true);
    assert.equal(operator.can_edit_inventory, true);
    assert.equal(operator.can_config_monitoring, false);
    assert.equal(operator.can_manage_credentials, false);
    assert.equal(operator.can_manage_users, false);
  });

  test("the viewer is strictly read-only", () => {
    const viewer = permissionsForRole("viewer");
    assert.equal(viewer.can_view_topology, true);
    assert.equal(viewer.can_view_traffic, true);
    assert.equal(viewer.can_view_reports, true);
    for (const key of PERMISSION_KEYS) {
      if (key.startsWith("can_view_")) continue;
      assert.equal(viewer[key], false, `viewer must not hold ${key}`);
    }
  });

  test("an unknown role falls back to read-only, never to administrator", () => {
    const fallback = permissionsForRole("superuser");
    assert.equal(fallback.can_view_topology, true);
    assert.equal(fallback.can_manage_users, false);
    assert.equal(fallback.can_manage_credentials, false);
    assert.equal(fallback.can_config_monitoring, false);
  });

  test("the returned map is a copy — mutating it cannot widen a role", () => {
    const first = permissionsForRole("viewer");
    first.can_manage_users = true;
    const second = permissionsForRole("viewer");
    assert.equal(second.can_manage_users, false);
  });
});

describe("role labels", () => {
  test("the three roles have human labels", () => {
    assert.equal(roleLabel("administrator"), "Administrator");
    assert.equal(roleLabel("operator"), "Network Operator");
    assert.equal(roleLabel("viewer"), "Viewer");
  });

  test("an unknown role is labelled honestly", () => {
    assert.equal(roleLabel("wizard"), "Unknown role");
  });
});

describe("the permission vocabulary", () => {
  test("the vocabulary is closed and every key is namespaced", () => {
    for (const key of PERMISSION_KEYS) {
      assert.match(key, /^can_[a-z_]+$/);
    }
    assert.equal(new Set(PERMISSION_KEYS).size, PERMISSION_KEYS.length);
  });

  test("the sensitive capabilities are separate keys, not one big admin flag", () => {
    const sensitive: PermissionKey[] = [
      "can_manage_users",
      "can_manage_credentials",
      "can_config_monitoring",
      "can_run_discovery",
    ];
    for (const key of sensitive) {
      assert.ok(PERMISSION_KEYS.includes(key));
    }
  });
});
