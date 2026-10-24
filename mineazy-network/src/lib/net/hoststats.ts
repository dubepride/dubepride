/**
 * ============================================================================
 *  net/hoststats.ts — real byte counters from the monitoring host
 * ============================================================================
 *
 *  Not every network can be polled with SNMP. What can always be measured is
 *  the machine running the console: the operating system keeps cumulative
 *  byte counters for its interfaces. Deltas between two reads give a real
 *  throughput figure for the host's own link — not a guess and not a
 *  fabricated number.
 *
 *  Everything here is read-only. Nothing is sent to the network.
 * ============================================================================
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";

export interface HostTrafficTotals {
  /** Bytes received since boot, summed over physical interfaces. */
  rxBytes: number;
  /** Bytes sent since boot. */
  txBytes: number;
  /** When the reading was taken. */
  at: number;
  /** What the numbers cover, shown in the UI. */
  scope: string;
}

function run(command: string, args: string[], timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? "" : `${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });
}

/** Read the host's cumulative byte counters, or null when unavailable. */
export async function readHostTrafficTotals(): Promise<HostTrafficTotals | null> {
  const at = Date.now();

  if (process.platform === "win32") {
    // "netstat -e" prints a "Bytes" row: received then sent.
    const output = await run("netstat", ["-e"]);
    const line = output.split(/\r?\n/).find((row) => /^\s*Bytes\b/i.test(row));
    if (!line) return null;
    const numbers = line.match(/\d+/g);
    if (!numbers || numbers.length < 2) return null;
    return {
      rxBytes: Number(numbers[0]),
      txBytes: Number(numbers[1]),
      at,
      scope: "all host interfaces",
    };
  }

  if (process.platform === "linux") {
    try {
      const names = await fs.readdir("/sys/class/net");
      let rxBytes = 0;
      let txBytes = 0;
      for (const name of names) {
        if (name === "lo") continue;
        try {
          const rx = await fs.readFile(`/sys/class/net/${name}/statistics/rx_bytes`, "utf8");
          const tx = await fs.readFile(`/sys/class/net/${name}/statistics/tx_bytes`, "utf8");
          rxBytes += Number(rx.trim());
          txBytes += Number(tx.trim());
        } catch {
          // An interface can disappear between readdir and read.
        }
      }
      if (rxBytes === 0 && txBytes === 0) return null;
      return { rxBytes, txBytes, at, scope: "all host interfaces" };
    } catch {
      return null;
    }
  }

  // macOS and anything else: "netstat -ib" repeats the counters per address
  // family, so the highest value per column is the interface total.
  const output = await run("netstat", ["-ib"]);
  if (!output.trim()) return null;
  let rxBytes = 0;
  let txBytes = 0;
  for (const row of output.split(/\r?\n/).slice(1)) {
    const columns = row.trim().split(/\s+/);
    if (columns.length < 10) continue;
    const ibytes = Number(columns[6]);
    const obytes = Number(columns[9]);
    if (Number.isFinite(ibytes)) rxBytes += ibytes;
    if (Number.isFinite(obytes)) txBytes += obytes;
  }
  if (rxBytes === 0 && txBytes === 0) return null;
  return { rxBytes, txBytes, at, scope: "all host interfaces" };
}
