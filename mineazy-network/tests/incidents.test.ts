/**
 * ============================================================================
 *  tests/incidents.test.ts — the alerting engine
 * ============================================================================
 *
 *  The properties under test:
 *    1. One open incident per dedupe key — a flapping device does not flood
 *       the notification centre.
 *    2. A downstream symptom behind a known upstream fault is CORRELATED to
 *       the parent incident instead of duplicating it.
 *    3. Recovery is recorded and the incident is closed.
 *    4. A collector outage never becomes "every device is offline".
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { tempDatabase, removeTempDatabase } from "./helpers";

const dbPath = tempDatabase("incidents");

let devices: typeof import("../src/lib/repo/devices");
let incidents: typeof import("../src/lib/repo/incidents");
let engine: typeof import("../src/lib/incidents");
let events: typeof import("../src/lib/repo/events");
let connections: typeof import("../src/lib/repo/connections");

/** Gateway → switch → endpoint. */
const ids: Record<string, number> = {};

before(async () => {
  devices = await import("../src/lib/repo/devices");
  incidents = await import("../src/lib/repo/incidents");
  engine = await import("../src/lib/incidents");
  events = await import("../src/lib/repo/events");
  connections = await import("../src/lib/repo/connections");

  ids.gateway = await devices.createDevice({ name: "Gateway", category: "gateway", failureThreshold: 2 });
  ids.switch = await devices.createDevice({ name: "Core Switch", category: "switch", failureThreshold: 2 });
  ids.host = await devices.createDevice({ name: "Workstation", category: "desktop", failureThreshold: 2 });
});

after(() => {
  removeTempDatabase(dbPath);
});

describe("dedupe keys", () => {
  test("each device state has its own key", () => {
    assert.equal(engine.deviceIncidentKey(7, "OFFLINE"), "device:7:offline");
    assert.equal(engine.deviceIncidentKey(7, "LINK_DOWN"), "device:7:link_down");
    assert.equal(engine.deviceIncidentKey(7, "NO_INTERNET"), "device:7:no_internet");
  });

  test("a connection and the internet have their own keys", () => {
    assert.equal(engine.connectionIncidentKey(3), "connection:3:down");
    assert.equal(engine.INTERNET_INCIDENT_KEY, "network:internet:down");
  });
});

describe("raiseOrUpdateIncident", () => {
  test("the same key updates the open incident instead of creating a second one", async () => {
    const first = await engine.raiseOrUpdateIncident({
      key: "device:999:offline",
      category: "offline",
      severity: "critical",
      title: "Test device is offline",
      evidence: "First observation.",
    });
    assert.equal(first.created, true);

    const second = await engine.raiseOrUpdateIncident({
      key: "device:999:offline",
      category: "offline",
      severity: "critical",
      title: "Test device is offline",
      evidence: "Second observation.",
    });
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);

    const open = await incidents.listIncidents({ state: "active" });
    assert.equal(open.filter((incident) => incident.key === "device:999:offline").length, 1);
  });

  test("raising an incident writes an operational event", async () => {
    const before = await events.listEvents({ limit: 500 });
    await engine.raiseOrUpdateIncident({
      key: "device:1001:degraded",
      category: "degraded",
      severity: "minor",
      title: "Test device is degraded",
      evidence: "Evidence.",
    });
    const after = await events.listEvents({ limit: 500 });
    assert.ok(after.length > before.length);
    assert.ok(after.some((event) => event.type === "incident_raised"));
  });
});

describe("recovery", () => {
  test("resolving by key closes the incident and records the recovery", async () => {
    const raised = await engine.raiseOrUpdateIncident({
      key: "device:1002:offline",
      category: "offline",
      severity: "critical",
      title: "Recovering device is offline",
      evidence: "Evidence.",
    });

    const resolved = await engine.resolveIncidentByKey("device:1002:offline", "Power restored.");
    assert.equal(resolved, true);

    const incident = await incidents.getIncident(raised.id);
    assert.equal(incident?.state, "resolved");
    assert.match(incident?.notes ?? "", /Power restored/);

    assert.equal(await engine.resolveIncidentByKey("device:1002:offline"), false);
  });
});

describe("syncDeviceIncident", () => {
  test("a healthy device raises nothing", async () => {
    const device = await devices.getDevice(ids.host);
    const result = await engine.syncDeviceIncident({
      device: device!,
      state: "ONLINE",
      reason: "All good.",
      evidence: "Probe answered.",
      severity: "info",
    });
    assert.equal(result.incidentId, null);
  });

  test("an offline device raises exactly one incident", async () => {
    const device = await devices.getDevice(ids.host);
    const result = await engine.syncDeviceIncident({
      device: device!,
      state: "OFFLINE",
      reason: "Failed 2 consecutive reachability checks.",
      evidence: "icmp: no echo reply",
      severity: "critical",
    });
    assert.ok(result.incidentId);
    assert.equal(result.correlated, false);

    const incident = await incidents.getIncident(result.incidentId!);
    assert.equal(incident?.key, `device:${ids.host}:offline`);
    assert.equal(incident?.severity, "critical");
    assert.match(incident?.evidence ?? "", /no echo reply/);
  });

  test("a second failure updates the same incident rather than raising a new one", async () => {
    const device = await devices.getDevice(ids.host);
    const second = await engine.syncDeviceIncident({
      device: device!,
      state: "OFFLINE",
      reason: "Still failing.",
      evidence: "icmp: no echo reply (second attempt)",
      severity: "critical",
    });
    const open = await incidents.listIncidents({ state: "active" });
    assert.equal(
      open.filter((incident) => incident.key === `device:${ids.host}:offline`).length,
      1,
      "a flapping device must not flood the incident list"
    );
    assert.ok(second.incidentId);
  });

  test("recovery clears the device incident", async () => {
    const device = await devices.getDevice(ids.host);
    await engine.syncDeviceIncident({
      device: device!,
      state: "ONLINE",
      reason: "Back.",
      evidence: "Probe answered.",
      severity: "info",
    });
    const open = await incidents.listIncidents({ state: "active" });
    assert.equal(
      open.filter((incident) => incident.key === `device:${ids.host}:offline`).length,
      0
    );
  });

  test("NO_INTERNET raises one global incident, not one per device", async () => {
    const gateway = await devices.getDevice(ids.gateway);
    await engine.syncDeviceIncident({
      device: gateway!,
      state: "NO_INTERNET",
      reason: "External checks failed.",
      evidence: "icmp to 1.1.1.1 failed",
      severity: "major",
    });

    const open = await incidents.listIncidents({ state: "active" });
    const internetIncidents = open.filter((incident) => incident.key === engine.INTERNET_INCIDENT_KEY);
    assert.equal(internetIncidents.length, 1);
    assert.equal(internetIncidents[0].severity, "major");
  });

  test("a stale collector produces a STALE incident, never an OFFLINE flood", async () => {
    const device = await devices.getDevice(ids.switch);
    const result = await engine.syncDeviceIncident({
      device: device!,
      state: "STALE",
      reason: "The newest observation is 3600s old.",
      evidence: "Collector heartbeat missing.",
      severity: "minor",
    });
    assert.ok(result.incidentId);
    const incident = await incidents.getIncident(result.incidentId!);
    assert.equal(incident?.key, `device:${ids.switch}:stale`);
    assert.notEqual(incident?.severity, "critical");
  });

  test("the global internet incident closes when the boundary recovers", async () => {
    const gateway = await devices.getDevice(ids.gateway);
    await engine.syncDeviceIncident({
      device: gateway!,
      state: "NO_INTERNET",
      reason: "External checks failed.",
      evidence: "icmp to 1.1.1.1 failed",
      severity: "major",
    });

    let open = await incidents.listIncidents({ state: "active" });
    assert.equal(open.filter((incident) => incident.key === engine.INTERNET_INCIDENT_KEY).length, 1);

    // The boundary device is healthy again — the global incident must close.
    await engine.syncDeviceIncident({
      device: gateway!,
      state: "ONLINE",
      reason: "Back.",
      evidence: "Probe answered.",
      severity: "info",
    });

    open = await incidents.listIncidents({ state: "active" });
    assert.equal(
      open.filter((incident) => incident.key === engine.INTERNET_INCIDENT_KEY).length,
      0,
      "the internet incident must not stay open forever"
    );
  });

  test("the internet incident stays open while another boundary device is still down", async () => {
    const router = await devices.createDevice({
      name: "Edge Router",
      category: "router",
      failureThreshold: 2,
    });
    await devices.setDeviceHealth(router, "NO_INTERNET", "SIMULATED: the external checks failed.");

    const gateway = await devices.getDevice(ids.gateway);
    await engine.syncDeviceIncident({
      device: gateway!,
      state: "NO_INTERNET",
      reason: "External checks failed.",
      evidence: "icmp to 1.1.1.1 failed",
      severity: "major",
    });

    await engine.syncDeviceIncident({
      device: gateway!,
      state: "ONLINE",
      reason: "Back.",
      evidence: "Probe answered.",
      severity: "info",
    });

    const open = await incidents.listIncidents({ state: "active" });
    assert.equal(
      open.filter((incident) => incident.key === engine.INTERNET_INCIDENT_KEY).length,
      1,
      "the incident must stay open while a boundary device is still without internet"
    );
  });
});

describe("syncConnectionIncident", () => {
  test("a down link raises one incident naming both ends", async () => {
    const result = await engine.syncConnectionIncident({
      connectionId: 4242,
      state: "down",
      evidence: "The local interface reports operStatus \"down\".",
      localDeviceId: ids.switch,
      remoteDeviceId: ids.host,
    });
    assert.ok(result.incidentId);

    const incident = await incidents.getIncident(result.incidentId!);
    assert.equal(incident?.key, "connection:4242:down");
    assert.equal(incident?.severity, "critical");
    assert.match(incident?.title ?? "", /Core Switch/);
    assert.match(incident?.title ?? "", /Workstation/);
  });

  test("a link that comes back resolves the incident", async () => {
    await engine.syncConnectionIncident({
      connectionId: 4242,
      state: "up",
      evidence: "Both interfaces report operStatus \"up\".",
      localDeviceId: ids.switch,
      remoteDeviceId: ids.host,
    });
    const open = await incidents.listIncidents({ state: "active" });
    assert.equal(open.filter((incident) => incident.key === "connection:4242:down").length, 0);
  });
});

describe("link cascades", () => {
  /** The ids of the two cables in the cascade fixture. */
  let uplinkId = 0;
  let accessId = 0;

  before(async () => {
    const uplink = await connections.upsertConnection({
      localDeviceId: ids.gateway,
      localPortId: null,
      remoteDeviceId: ids.switch,
      remotePortId: null,
      type: "uplink",
      source: "manual",
      confidence: 1,
      state: "up",
    });
    const access = await connections.upsertConnection({
      localDeviceId: ids.switch,
      localPortId: null,
      remoteDeviceId: ids.host,
      remotePortId: null,
      type: "access",
      source: "manual",
      confidence: 1,
      state: "up",
    });
    uplinkId = uplink.id;
    accessId = access.id;
  });

  test("a broken link below a broken link joins the root incident", async () => {
    // The uplink breaks first — it is the root cause.
    await connections.setConnectionState(uplinkId, "down", "The local interface reports down.");
    const root = await engine.syncConnectionIncident({
      connectionId: uplinkId,
      state: "down",
      evidence: "The local interface reports down.",
      localDeviceId: ids.gateway,
      remoteDeviceId: ids.switch,
    });
    assert.ok(root.incidentId);
    assert.equal(root.correlated, false);

    // The access link below it breaks as a consequence.
    await connections.setConnectionState(accessId, "down", "The local interface reports down.");
    const symptom = await engine.syncConnectionIncident({
      connectionId: accessId,
      state: "down",
      evidence: "The local interface reports down.",
      localDeviceId: ids.switch,
      remoteDeviceId: ids.host,
    });

    assert.equal(symptom.correlated, true, "a symptom link must not raise a second incident");
    assert.equal(symptom.incidentId, root.incidentId);

    const open = await incidents.listIncidents({ state: "active" });
    const linkIncidents = open.filter((incident) => incident.key.startsWith("connection:"));
    assert.equal(linkIncidents.length, 1, "one root cause, not one incident per cable");

    // The blast radius is on the root incident.
    const incident = await incidents.getIncident(root.incidentId!);
    assert.ok(incident?.affected.includes(ids.host), "the endpoint below must be listed as affected");
  });

  test("the cascade clears when the root cause is repaired", async () => {
    await connections.setConnectionState(uplinkId, "up", "Both interfaces report up.");
    await engine.syncConnectionIncident({
      connectionId: uplinkId,
      state: "up",
      evidence: "Both interfaces report up.",
      localDeviceId: ids.gateway,
      remoteDeviceId: ids.switch,
    });
    await connections.setConnectionState(accessId, "up", "Both interfaces report up.");
    await engine.syncConnectionIncident({
      connectionId: accessId,
      state: "up",
      evidence: "Both interfaces report up.",
      localDeviceId: ids.switch,
      remoteDeviceId: ids.host,
    });

    const open = await incidents.listIncidents({ state: "active" });
    assert.equal(open.filter((incident) => incident.key.startsWith("connection:")).length, 0);
  });
});

describe("acknowledgement", () => {  test("an incident can be acknowledged and the acknowledgement is recorded", async () => {
    const raised = await engine.raiseOrUpdateIncident({
      key: "device:1003:offline",
      category: "offline",
      severity: "critical",
      title: "Acknowledgement test",
      evidence: "Evidence.",
    });
    await incidents.acknowledgeIncident(raised.id, "operator");
    const incident = await incidents.getIncident(raised.id);
    assert.equal(incident?.acknowledged, true);
    assert.equal(incident?.acknowledgedBy, "operator");
    assert.equal(incident?.state, "acknowledged");
  });
});

describe("activeIncidentSummary", () => {
  test("the summary counts the open incidents by severity", async () => {
    const summary = await engine.activeIncidentSummary();
    const open = await incidents.listIncidents({ state: "active" });
    assert.equal(summary.total, open.length);
    assert.equal(
      summary.critical,
      open.filter((incident) => incident.severity === "critical").length
    );
    assert.equal(summary.major, open.filter((incident) => incident.severity === "major").length);
    assert.equal(summary.minor, open.filter((incident) => incident.severity === "minor").length);
    assert.equal(
      summary.acknowledged,
      open.filter((incident) => incident.acknowledged).length
    );
  });
});
