/**
 * ============================================================================
 *  GET /api/traffic — traffic history and per-link rates
 * ============================================================================
 *
 *  Rates only ever come from `Traffic_Samples`, where each row stores the
 *  measured window and a `Counter_Valid` flag. A sample whose counter reset
 *  is returned with `counterValid: false` and a null rate, so the UI can say
 *  "measurement invalid" instead of drawing a spike.
 * ============================================================================
 */

import { samplesSince, latestSample, topSubjects } from "@/lib/repo/traffic";
import { listDevices } from "@/lib/repo/devices";
import { listAllPorts } from "@/lib/repo/ports";
import { listConnections } from "@/lib/repo/connections";
import { formatBandwidth, utilisationPct } from "@/lib/traffic";
import { requirePermission, ok, numberParam, intParam } from "@/lib/api";

const WINDOW_HOURS = 24;

export async function GET(request: Request): Promise<Response> {
  const gate = await requirePermission("can_view_traffic");
  if (gate.response) return gate.response;

  const url = new URL(request.url);
  const hours = Math.min(168, Math.max(1, intParam(request, "hours", WINDOW_HOURS)));
  const since = Date.now() - hours * 60 * 60 * 1000;

  const subjectType = url.searchParams.get("subjectType");
  const subjectId = numberParam(request, "subjectId");

  // A single subject (device or port) was requested.
  if ((subjectType === "device" || subjectType === "port") && subjectId !== null) {
    const samples = await samplesSince(subjectType, subjectId, since, 1000);
    return ok({
      subjectType,
      subjectId,
      hours,
      samples,
      latest: await latestSample(subjectType, subjectId),
      formatted: samples.map((sample) => ({
        at: sample.sampledAt,
        in: formatBandwidth(sample.inRateBps),
        out: formatBandwidth(sample.outRateBps),
        valid: sample.counterValid,
      })),
    });
  }

  // The overview: every port's current rate, plus the busiest subjects.
  const [devices, ports, connections, top] = await Promise.all([
    listDevices(),
    listAllPorts(),
    listConnections(),
    topSubjects(since, 20),
  ]);

  const deviceNames = new Map(devices.map((device) => [device.id, device.name]));
  const portOwners = new Map(ports.map((port) => [port.id, port.deviceId]));

  const links = connections
    .map((connection) => {
      const localPort = ports.find((port) => port.id === connection.localPortId);
      const remotePort = ports.find((port) => port.id === connection.remotePortId);
      const port = localPort ?? remotePort;
      const ownerId = port ? portOwners.get(port.id) : undefined;
      const speedBps = port?.speedBps ?? null;
      const inRate = port?.inRateBps ?? null;
      const outRate = port?.outRateBps ?? null;
      return {
        connectionId: connection.id,
        state: connection.state,
        source: connection.source,
        deviceName: ownerId !== undefined ? deviceNames.get(ownerId) ?? null : null,
        deviceId: ownerId ?? null,
        portName: port?.ifName ?? null,
        portId: port?.id ?? null,
        speedBps,
        inRateBps: inRate,
        outRateBps: outRate,
        utilisationPct: utilisationPct(Math.max(inRate ?? 0, outRate ?? 0), speedBps),
        measured: inRate !== null || outRate !== null,
      };
    })
    .sort((a, b) => (b.utilisationPct ?? -1) - (a.utilisationPct ?? -1));

  const topSubjectsWithNames = await Promise.all(
    top.map(async (entry) => {
      const name =
        entry.subjectType === "device"
          ? deviceNames.get(entry.subjectId) ?? `Device ${entry.subjectId}`
          : (() => {
              const port = ports.find((p) => p.id === entry.subjectId);
              if (!port) return `Port ${entry.subjectId}`;
              const owner = deviceNames.get(port.deviceId);
              return owner ? `${owner} ${port.ifName}` : port.ifName;
            })();
      return { ...entry, name, formattedTotal: formatBandwidth(entry.maxRateBps) };
    })
  );

  return ok({
    hours,
    links,
    top: topSubjectsWithNames,
    deviceCount: devices.length,
    portCount: ports.length,
  });
}
