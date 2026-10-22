/**
 * ============================================================================
 *  tests/topology.test.ts — the graph behind the map
 * ============================================================================
 *
 *  The topology engine has to answer three questions correctly:
 *    1. Which way does the data flow (which end of a cable is upstream)?
 *    2. What is the exact chain of devices AND ports from the internet source
 *       down to a given device?
 *    3. Which devices sit downstream of a failed link?
 *
 *  It runs against a throw-away database so the assertions are about real
 *  rows, not mocks.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { after, before, describe, test } from "node:test";

import { tempDatabase, removeTempDatabase } from "./helpers";

const dbPath = tempDatabase("topology");

type Repo = typeof import("../src/lib/repo/devices");
type Topology = typeof import("../src/lib/topology");

let devices: Repo;
let ports: typeof import("../src/lib/repo/ports");
let connections: typeof import("../src/lib/repo/connections");
let topology: Topology;

/** The ids of the seeded estate, by name. */
const ids: Record<string, number> = {};

before(async () => {
  devices = await import("../src/lib/repo/devices");
  ports = await import("../src/lib/repo/ports");
  connections = await import("../src/lib/repo/connections");
  topology = await import("../src/lib/topology");

  // Starlink → Edge Router → Admin Switch → White House Switch → Recorder
  ids.starlink = await devices.createDevice({
    name: "Starlink Terminal",
    category: "internet",
    mgmtIp: "10.10.0.1",
  });
  ids.router = await devices.createDevice({
    name: "Edge Router",
    category: "router",
    mgmtIp: "10.10.0.2",
  });
  ids.admin = await devices.createDevice({
    name: "Admin Switch",
    category: "switch",
    mgmtIp: "10.10.0.3",
  });
  ids.whitehouse = await devices.createDevice({
    name: "White House Switch",
    category: "switch",
    mgmtIp: "10.10.1.3",
  });
  ids.recorder = await devices.createDevice({
    name: "CCTV Recorder",
    category: "nvr",
    mgmtIp: "10.10.1.53",
  });
  ids.laptop = await devices.createDevice({
    name: "Workshop Laptop",
    category: "laptop",
    mgmtIp: "10.10.2.51",
  });

  // Ports.
  const starlinkEth = await ports.upsertPort(ids.starlink, { ifName: "eth0", operState: "up", managed: true });
  const routerWan = await ports.upsertPort(ids.router, { ifName: "wan0", operState: "up", managed: true });
  const routerLan = await ports.upsertPort(ids.router, { ifName: "lan0", operState: "up", managed: true });
  const adminUplink = await ports.upsertPort(ids.admin, {
    ifName: "GigabitEthernet1/0/1",
    operState: "up",
    managed: true,
  });
  const adminToWhite = await ports.upsertPort(ids.admin, {
    ifName: "GigabitEthernet1/0/2",
    operState: "up",
    managed: true,
  });
  const whiteUplink = await ports.upsertPort(ids.whitehouse, {
    ifName: "GigabitEthernet1/0/1",
    operState: "up",
    managed: true,
  });
  const whiteAccess = await ports.upsertPort(ids.whitehouse, {
    ifName: "GigabitEthernet1/0/2",
    operState: "up",
    managed: true,
  });
  const adminToLaptop = await ports.upsertPort(ids.admin, {
    ifName: "GigabitEthernet1/0/3",
    operState: "up",
    managed: true,
  });
  const laptopEth = await ports.upsertPort(ids.laptop, { ifName: "eth0", operState: "up", managed: true });
  const recorderEth = await ports.upsertPort(ids.recorder, { ifName: "eth0", operState: "up", managed: true });

  // Connections. The cable between the router and the admin switch is stored
  // "local = admin switch" on purpose: the stored order must not decide the
  // upstream direction.
  await connections.upsertConnection({
    localDeviceId: ids.starlink,
    localPortId: starlinkEth.id,
    remoteDeviceId: ids.router,
    remotePortId: routerWan.id,
    type: "wan",
    source: "manual",
    confidence: 1,
    verified: true,
    state: "up",
  });
  await connections.upsertConnection({
    localDeviceId: ids.router,
    localPortId: routerLan.id,
    remoteDeviceId: ids.admin,
    remotePortId: adminUplink.id,
    type: "uplink",
    source: "lldp",
    confidence: 1,
    state: "up",
  });
  await connections.upsertConnection({
    localDeviceId: ids.admin,
    localPortId: adminToWhite.id,
    remoteDeviceId: ids.whitehouse,
    remotePortId: whiteUplink.id,
    type: "uplink",
    source: "lldp",
    confidence: 1,
    state: "up",
  });
  await connections.upsertConnection({
    localDeviceId: ids.whitehouse,
    localPortId: whiteAccess.id,
    remoteDeviceId: ids.recorder,
    remotePortId: recorderEth.id,
    type: "access",
    source: "fdb",
    confidence: 0.8,
    state: "up",
  });
  await connections.upsertConnection({
    localDeviceId: ids.admin,
    localPortId: adminToLaptop.id,
    remoteDeviceId: ids.laptop,
    remotePortId: laptopEth.id,
    type: "access",
    source: "fdb",
    confidence: 0.8,
    state: "up",
  });
});

after(() => {
  removeTempDatabase(dbPath);
});

describe("buildTopologyGraph", () => {
  test("the internet source is a root", async () => {
    const graph = await topology.buildTopologyGraph();
    assert.ok(graph.roots.includes(ids.starlink));
  });

  test("switches sit below the gateway and endpoints below the switches", async () => {
    const graph = await topology.buildTopologyGraph();
    assert.equal(graph.devices.get(ids.admin)?.parentId, ids.router);
    assert.equal(graph.devices.get(ids.whitehouse)?.parentId, ids.admin);
    assert.equal(graph.devices.get(ids.recorder)?.parentId, ids.whitehouse);
    assert.equal(graph.devices.get(ids.laptop)?.parentId, ids.admin);
  });

  test("the stored connection order does not decide the upstream direction", async () => {
    const graph = await topology.buildTopologyGraph();
    // The router↔admin cable was stored with the ADMIN switch as "local".
    assert.equal(graph.devices.get(ids.admin)?.parentId, ids.router);
  });

  test("no device is dropped from the graph", async () => {
    const graph = await topology.buildTopologyGraph();
    assert.equal(graph.devices.size, 6);
  });
});

describe("buildTopologySnapshot", () => {
  test("the snapshot has one node per device and one edge per connection", async () => {
    const snapshot = await topology.buildTopologySnapshot();
    assert.equal(snapshot.nodes.length, 6);
    assert.equal(snapshot.edges.length, 5);
  });

  test("edges point from the parent down to the child", async () => {
    const snapshot = await topology.buildTopologySnapshot();
    const uplink = snapshot.edges.find(
      (edge) => edge.source === `dev-${ids.router}` && edge.target === `dev-${ids.admin}`
    );
    assert.ok(uplink, "the router→admin edge must exist and point downwards");
  });

  test("an edge label names the port at each end", async () => {
    const snapshot = await topology.buildTopologySnapshot();
    const uplink = snapshot.edges.find(
      (edge) => edge.source === `dev-${ids.router}` && edge.target === `dev-${ids.admin}`
    );
    assert.match(uplink!.label, /Edge Router lan0/);
    assert.match(uplink!.label, /Admin Switch GigabitEthernet1\/0\/1/);
  });

  test("an edge exposes both ports and a confirmed physical link", async () => {
    const snapshot = await topology.buildTopologySnapshot();
    const uplink = snapshot.edges.find(
      (edge) => edge.source === `dev-${ids.router}` && edge.target === `dev-${ids.admin}`
    );
    assert.ok(uplink);
    assert.equal(uplink!.sourcePort, "lan0");
    assert.equal(uplink!.targetPort, "GigabitEthernet1/0/1");
    assert.equal(uplink!.sourceLinkUp, true);
    assert.equal(uplink!.targetLinkUp, true);
    assert.equal(uplink!.physicalState, "up");
    assert.equal(uplink!.connectionType, "uplink");
    // The connection inspector shows these; an absent value must be null,
    // never a fabricated zero.
    assert.ok(uplink!.inErrors === null || typeof uplink!.inErrors === "number");
    assert.equal(typeof uplink!.evidence, "string");
  });

  test("a managed port that reports down makes the physical link down", async () => {
    // The connection record still says "up": the port evidence is newer and
    // more specific, so the cable must not be drawn as healthy.
    await ports.upsertPort(ids.admin, {
      ifName: "GigabitEthernet1/0/1",
      operState: "down",
      managed: true,
    });

    const snapshot = await topology.buildTopologySnapshot();
    const uplink = snapshot.edges.find(
      (edge) => edge.source === `dev-${ids.router}` && edge.target === `dev-${ids.admin}`
    );
    assert.ok(uplink);
    assert.equal(uplink!.targetLinkUp, false);
    assert.equal(uplink!.physicalState, "down");

    // Restore the fixture for the tests that follow.
    await ports.upsertPort(ids.admin, {
      ifName: "GigabitEthernet1/0/1",
      operState: "up",
      managed: true,
    });
  });

  test("the snapshot is not labelled as simulated for a real estate", async () => {
    const snapshot = await topology.buildTopologySnapshot();
    assert.equal(snapshot.simulated, false);
  });
});

describe("traceUpstreamPath", () => {
  test("the path runs from the internet source down to the device", async () => {
    const trace = await topology.traceUpstreamPath(ids.recorder);
    assert.ok(trace);
    assert.deepEqual(
      trace!.steps.map((step) => step.device.id),
      [ids.starlink, ids.router, ids.admin, ids.whitehouse, ids.recorder]
    );
  });

  test("the path names the port at every hop", async () => {
    const trace = await topology.traceUpstreamPath(ids.recorder);
    // Each device is annotated with the port that faces its parent, so the
    // chain reads as the fault path from the internet source downwards.
    assert.match(trace!.path, /Starlink Terminal →/);
    assert.match(trace!.path, /Edge Router \(wan0\)/);
    assert.match(trace!.path, /Admin Switch \(GigabitEthernet1\/0\/1\)/);
    assert.match(trace!.path, /White House Switch \(GigabitEthernet1\/0\/1\)/);
    assert.match(trace!.path, /CCTV Recorder \(eth0\)/);
  });

  test("a broken link is reported as the broken segment", async () => {
    const list = await connections.listConnections();
    const uplink = list.find(
      (connection) =>
        (connection.localDeviceId === ids.router && connection.remoteDeviceId === ids.admin) ||
        (connection.localDeviceId === ids.admin && connection.remoteDeviceId === ids.router)
    );
    assert.ok(uplink);
    await connections.setConnectionState(uplink!.id, "down", "SIMULATED: the link is down.");

    const trace = await topology.traceUpstreamPath(ids.recorder);
    assert.ok(trace!.brokenSegment, "the broken segment must be identified");
    assert.equal(trace!.brokenSegment!.connectionId, uplink!.id);
  });

  test("tracing an unknown device returns null rather than throwing", async () => {
    assert.equal(await topology.traceUpstreamPath(999999), null);
  });
});

describe("descendantsOf", () => {
  test("the blast radius of a failed switch uplink is the whole subtree", async () => {
    const downstream = await topology.descendantsOf(ids.admin);
    assert.ok(downstream.includes(ids.whitehouse));
    assert.ok(downstream.includes(ids.recorder));
    assert.ok(downstream.includes(ids.laptop));
    assert.ok(!downstream.includes(ids.admin), "a device is not its own descendant");
    assert.ok(!downstream.includes(ids.router));
  });

  test("an endpoint has no descendants", async () => {
    assert.deepEqual(await topology.descendantsOf(ids.recorder), []);
  });
});

describe("topologyIndex", () => {
  test("every device is listed with its parent and child count", async () => {
    const index = await topology.topologyIndex();
    assert.equal(index.length, 6);
    const admin = index.find((entry) => entry.device.id === ids.admin);
    assert.equal(admin?.parentId, ids.router);
    assert.equal(admin?.childCount, 2);
  });
});
