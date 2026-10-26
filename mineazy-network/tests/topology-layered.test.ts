import assert from "node:assert/strict";
import test from "node:test";
import { layoutLayered, worstState } from "../src/lib/topology-layered";
import type { TopologyNode } from "../src/lib/types";

function node(over: Partial<TopologyNode>): TopologyNode {
  return {
    id: "dev-1",
    deviceId: 1,
    name: "Device 1",
    category: "camera",
    state: "ONLINE",
    reason: "reachable",
    parentId: null,
    locationName: null,
    ip: "192.168.1.10",
    portLabel: null,
    childCount: 0,
    x: 0,
    y: 0,
    manufacturer: "",
    model: "",
    mac: "",
    inRateBps: null,
    outRateBps: null,
    portCount: 0,
    ...over,
  };
}

const gateway = node({
  id: "dev-1",
  deviceId: 1,
  name: "Router",
  category: "router",
  ip: "192.168.1.1",
});

const fleet: TopologyNode[] = [
  gateway,
  node({ id: "dev-2", deviceId: 2, name: "Camera A" }),
  node({ id: "dev-3", deviceId: 3, name: "Camera B", state: "OFFLINE" }),
  node({ id: "dev-4", deviceId: 4, name: "Printer", category: "printer" }),
  node({ id: "dev-5", deviceId: 5, name: "Phone", category: "phone" }),
  node({ id: "dev-6", deviceId: 6, name: "Mystery", category: "unknown" }),
];

test("the gateway is not repeated as a group member", () => {
  const layout = layoutLayered(fleet, new Set());
  assert.equal(layout.gateway?.id, gateway.id);
  const members = layout.groups.flatMap((g) => g.devices.map((d) => d.id));
  assert.ok(!members.includes(gateway.id));
});

test("groups are ordered by equipment type, with unclassified last", () => {
  const layout = layoutLayered(fleet, new Set());
  assert.deepEqual(
    layout.groups.map((g) => g.key),
    ["camera", "phone", "printer", "unknown"]
  );
});

test("a closed group reserves a row but places no devices", () => {
  const layout = layoutLayered(fleet, new Set());
  assert.equal(layout.positions.size, 0);
  assert.ok(layout.groups.every((g) => g.collapsed));
  assert.ok(layout.groups.every((g) => g.height === 62));
});

test("opening a group lays its devices out below its header", () => {
  const layout = layoutLayered(fleet, new Set(["camera"]));
  const camera = layout.groups.find((g) => g.key === "camera");
  assert.ok(camera && !camera.collapsed);

  const first = layout.positions.get("dev-2");
  const second = layout.positions.get("dev-3");
  assert.ok(first && second);
  assert.equal(first.y, camera.y + 62 + 8);
  assert.equal(first.y, second.y);
  assert.notEqual(first.x, second.x);
  assert.equal(layout.positions.size, 2);
});

test("opening a group pushes the rows below it down by its real height", () => {
  const closed = layoutLayered(fleet, new Set());
  const open = layoutLayered(fleet, new Set(["camera"]));
  const closedPhone = closed.groups.find((g) => g.key === "phone");
  const openPhone = open.groups.find((g) => g.key === "phone");
  assert.ok(closedPhone && openPhone);
  assert.ok(openPhone.y > closedPhone.y);
});

test("groups share one left edge so the connectors form a single trunk", () => {
  const layout = layoutLayered(fleet, new Set(["camera"]));
  const lefts = new Set(layout.groups.map((g) => g.x));
  assert.equal(lefts.size, 1);
  assert.ok(layout.gatewayPosition.x < Math.min(...layout.groups.map((g) => g.x)));
});

test("a closed group still reports the size of the grid it will open into", () => {
  const closed = layoutLayered(fleet, new Set());
  const camera = closed.groups.find((g) => g.key === "camera");
  assert.ok(camera);
  assert.equal(camera.openHeight, 62 + 142 + 18);
  assert.equal(camera.openWidth, 760);

  const open = layoutLayered(fleet, new Set(["camera"])).groups.find((g) => g.key === "camera");
  assert.equal(open?.openHeight, camera.openHeight);
  assert.equal(open?.openWidth, camera.openWidth);
});

test("the group state is the worst state of its members", () => {
  assert.equal(worstState(["ONLINE", "OFFLINE", "DEGRADED"]), "OFFLINE");
  assert.equal(worstState(["ONLINE", "STALE"]), "STALE");
  assert.equal(worstState(["ONLINE"]), "ONLINE");
  assert.equal(worstState([]), "UNKNOWN");
});
