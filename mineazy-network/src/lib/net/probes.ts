/**
 * ============================================================================
 *  net/probes.ts — active reachability probes
 * ============================================================================
 *
 *  Three probe types, all with a hard timeout so one unreachable device can
 *  never stall a polling cycle:
 *
 *    • ICMP  — the system ping utility (no raw sockets, so the collector runs
 *              without administrator privileges on Windows and Linux).
 *    • TCP   — a TCP connect to a specific port. The reliable fallback for
 *              devices that drop ICMP (printers and cameras often do).
 *    • HTTP  — an HTTP(S) health check for devices that expose a web UI.
 *
 *  Every probe returns the same shape so the evidence panel can render them
 *  uniformly: did it answer, how long did it take, and what was the reason
 *  for a failure.
 */

import { execFile } from "node:child_process";
import net from "node:net";

/** The result of one probe. */
export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  reason: string;
  target: string;
  type: "icmp" | "tcp" | "http";
}

const DEFAULT_TIMEOUT_MS = 2000;

function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * ICMP echo through the platform ping utility.
 *
 * Windows: `ping -n 1 -w <ms> <host>`; POSIX: `ping -c 1 -W <s> <host>`.
 */
export function pingProbe(
  host: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const args = isWindows()
      ? ["-n", "1", "-w", String(timeoutMs), host]
      : ["-c", "1", "-W", String(Math.max(1, Math.round(timeoutMs / 1000))), host];

    execFile(isWindows() ? "ping" : "ping", args, { timeout: timeoutMs + 500 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}\n${stderr ?? ""}`;
      const latencyMatch = /time[=<]\s*([\d.]+)\s*ms/i.exec(output);
      const latencyMs = latencyMatch ? Number(latencyMatch[1]) : null;

      if (!error && latencyMatch) {
        resolve({ ok: true, latencyMs, reason: `Echo reply in ${latencyMs} ms`, target: host, type: "icmp" });
        return;
      }

      const reason = /unreachable|unreachable host|host is down|timed out|timeout/i.test(output)
        ? "No echo reply before the timeout."
        : (stderr || output || error?.message || "Ping failed.").trim().split(/\r?\n/)[0];
      resolve({
        ok: false,
        latencyMs: null,
        reason: reason || "No echo reply before the timeout.",
        target: host,
        type: "icmp",
      });
    });
  });
}

/** TCP connect probe. */
export function tcpProbe(
  host: string,
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ok,
        latencyMs: ok ? Date.now() - started : null,
        reason,
        target: `${host}:${port}`,
        type: "tcp",
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, `TCP connect succeeded in ${Date.now() - started} ms`));
    socket.once("timeout", () => finish(false, `No TCP response within ${timeoutMs} ms`));
    socket.once("error", (err: Error) => finish(false, `TCP connect failed: ${err.message}`));
    socket.connect(port, host);
  });
}

/** HTTP(S) health check. Any 2xx/3xx status counts as healthy. */
export async function httpProbe(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "MineazyNetwork/1.0 (local network monitor)" },
    });
    const latencyMs = Date.now() - started;
    // Drain the body so the socket can be reused.
    await response.text().catch(() => undefined);
    const ok = response.status >= 200 && response.status < 400;
    return {
      ok,
      latencyMs: ok ? latencyMs : null,
      reason: ok
        ? `HTTP ${response.status} in ${latencyMs} ms`
        : `HTTP ${response.status} ${response.statusText}`.trim(),
      target: url,
      type: "http",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      latencyMs: null,
      reason:
        message.includes("abort") || message.includes("timeout")
          ? `No HTTP response within ${timeoutMs} ms`
          : `HTTP request failed: ${message}`,
      target: url,
      type: "http",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Dispatch a probe by type. */
export async function runProbe(
  target: { host: string; type: "icmp" | "tcp" | "http"; port?: number },
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ProbeResult> {
  if (target.type === "tcp") {
    return tcpProbe(target.host, target.port ?? 80, timeoutMs);
  }
  if (target.type === "http") {
    return httpProbe(target.host.startsWith("http") ? target.host : `http://${target.host}`, timeoutMs);
  }
  return pingProbe(target.host, timeoutMs);
}

/** Probe a set of targets; the device is considered reachable if ANY answer. */
export async function probeAny(
  targets: { host: string; type: "icmp" | "tcp" | "http"; port?: number; name?: string }[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ ok: boolean; results: ProbeResult[]; reason: string }> {
  if (targets.length === 0) {
    return {
      ok: false,
      results: [],
      reason: "No reachability probe is configured for this device.",
    };
  }
  const results: ProbeResult[] = [];
  for (const target of targets) {
    const result = await runProbe(target, timeoutMs);
    results.push(result);
    if (result.ok) {
      return {
        ok: true,
        results,
        reason: `${target.name ?? target.host} answered (${result.reason}).`,
      };
    }
  }
  return {
    ok: false,
    results,
    reason: results.map((r) => `${r.target}: ${r.reason}`).join(" "),
  };
}
