/**
 * ============================================================================
 *  GET   /api/settings — the effective configuration
 *  PATCH /api/settings — change the configuration
 *  POST  /api/settings — a maintenance action ("checkpoint")
 * ============================================================================
 *
 *  Only the keys the console knows how to edit are writable, and every write
 *  is audited. SNMP secrets are NOT settings — they live in the encrypted
 *  credential store and are never readable from the browser.
 * ============================================================================
 */

import { allSettings, setSetting } from "@/lib/settings";
import { checkpoint } from "@/lib/db";
import { recordAudit } from "@/lib/repo/audit";
import { recordEvent } from "@/lib/repo/events";
import { fail, ok, readJson, requirePermission } from "@/lib/api";

/** The keys an operator may change from the Settings screen. */
const EDITABLE_KEYS = new Set([
  "site.name",
  "site.description",
  "monitor.staleAfterSeconds",
  "monitor.defaultPollSeconds",
  "monitor.failureThreshold",
  "monitor.noTrafficAfterSeconds",
  "monitor.internetTargets",
  "monitor.gatewayTargets",
  "monitor.snmpTimeoutMs",
  "monitor.snmpRetries",
  "discovery.enabled",
  "discovery.scheduleMinutes",
  "discovery.rateLimitPerSecond",
  "collector.mode",
  "retention.trafficDays",
  "retention.observationDays",
  "retention.eventDays",
  "alerts.minSeverity",
  "alerts.browserNotifications",
  "ui.animations",
  "ui.defaultMapView",
]);

const NUMERIC_KEYS = new Set([
  "monitor.staleAfterSeconds",
  "monitor.defaultPollSeconds",
  "monitor.failureThreshold",
  "monitor.noTrafficAfterSeconds",
  "monitor.snmpTimeoutMs",
  "monitor.snmpRetries",
  "discovery.scheduleMinutes",
  "discovery.rateLimitPerSecond",
  "retention.trafficDays",
  "retention.observationDays",
  "retention.eventDays",
]);

const JSON_KEYS = new Set(["monitor.internetTargets", "monitor.gatewayTargets"]);

export async function GET(): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const settings = await allSettings();
  return ok({ settings });
}

/**
 * POST /api/settings — maintenance actions.
 *
 *   { "action": "checkpoint" }
 *
 * Flushes the write-ahead log into the database file so that copying
 * `data/mineazy.db` on its own produces a complete, consistent snapshot.
 * This is the operation a backup script needs before it copies anything.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePermission("can_config_monitoring");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";

  if (action !== "checkpoint") {
    return fail(
      `Unknown action "${action}". The only supported action is "checkpoint".`
    );
  }

  const result = await checkpoint();
  if (!result.ok) return fail(result.detail, 500);

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "checkpoint",
    entity: "database",
    entityId: "",
    note: result.detail,
  });
  await recordEvent({
    type: "database_checkpoint",
    severity: "info",
    title: "Database checkpoint completed",
    detail: result.detail,
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ action, detail: result.detail });
}

export async function PATCH(request: Request): Promise<Response> {
  const gate = await requirePermission("can_config_monitoring");
  if (gate.response) return gate.response;

  const body = await readJson(request);
  const changes = body.settings && typeof body.settings === "object" ? (body.settings as Record<string, unknown>) : body;

  const applied: Record<string, string> = {};
  const rejected: string[] = [];

  for (const [key, rawValue] of Object.entries(changes)) {
    if (!EDITABLE_KEYS.has(key)) {
      rejected.push(key);
      continue;
    }

    let value: string;
    if (typeof rawValue === "string") {
      value = rawValue;
    } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      value = String(rawValue);
    } else if (JSON_KEYS.has(key)) {
      value = JSON.stringify(rawValue);
    } else {
      rejected.push(key);
      continue;
    }

    if (NUMERIC_KEYS.has(key)) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        rejected.push(key);
        continue;
      }
      value = String(parsed);
    }

    if (JSON_KEYS.has(key)) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) {
          rejected.push(key);
          continue;
        }
      } catch {
        rejected.push(key);
        continue;
      }
    }

    if (key === "collector.mode" && !["real", "simulated", "off"].includes(value)) {
      rejected.push(key);
      continue;
    }

    await setSetting(key, value);
    applied[key] = value;
  }

  if (Object.keys(applied).length === 0) {
    return fail(
      rejected.length > 0
        ? `No settings were applied. Rejected keys: ${rejected.join(", ")}.`
        : "No settings were supplied."
    );
  }

  await recordAudit({
    userId: gate.account.id,
    userName: gate.account.username,
    action: "update",
    entity: "settings",
    after: applied,
    note: "Configuration changed from the Settings screen.",
  });
  await recordEvent({
    type: "config_changed",
    severity: "info",
    title: "Configuration updated",
    detail: `Changed: ${Object.keys(applied).join(", ")}.`,
    subjectType: "system",
    subjectId: null,
    source: "console",
  });

  return ok({ applied, rejected, settings: await allSettings() });
}
