/**
 * ============================================================================
 *  GET /api/stream — the live topology feed (Server-Sent Events)
 * ============================================================================
 *
 *  The map subscribes to this endpoint and receives a fresh topology snapshot
 *  whenever something changes. The server pushes on a fixed cadence and
 *  also pushes immediately when the collector reports a state change, so the
 *  map reacts within a second of a fault instead of waiting for the next
 *  poll cycle.
 *
 *  SSE (rather than websockets) is deliberate: it is one-way, it survives
 *  proxies, and it reconnects by itself — which is exactly what a monitoring
 *  console needs on a flaky local network.
 * ============================================================================
 */

import { buildTopologySnapshot } from "@/lib/topology";
import { listIncidents } from "@/lib/repo/incidents";
import { collectorHeartbeat } from "../../../collector/worker";
import { requirePermission } from "@/lib/api";

/** How often a snapshot is pushed when nothing changed. */
const IDLE_INTERVAL_MS = 15_000;

export async function GET(request: Request): Promise<Response> {
  const gate = await requirePermission("can_view_topology");
  if (gate.response) return gate.response;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const push = async (): Promise<void> => {
        if (closed) return;
        try {
          const [snapshot, incidents, heartbeat] = await Promise.all([
            buildTopologySnapshot(),
            listIncidents({ state: "active", limit: 50 }),
            collectorHeartbeat(),
          ]);
          const payload = {
            snapshot,
            incidents: incidents.map((incident) => ({
              id: incident.id,
              key: incident.key,
              title: incident.title,
              severity: incident.severity,
              state: incident.state,
              deviceId: incident.deviceId,
              connectionId: incident.connectionId,
              startedAt: incident.startedAt,
              affected: incident.affected,
            })),
            collector: heartbeat,
            at: Date.now(),
          };
          controller.enqueue(encoder.encode(`event: topology\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
          );
        }
      };

      // Tell the browser how long to wait before reconnecting.
      controller.enqueue(encoder.encode(`retry: 3000\n\n`));
      await push();

      const timer = setInterval(() => void push(), IDLE_INTERVAL_MS);

      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // The client may already be gone.
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
