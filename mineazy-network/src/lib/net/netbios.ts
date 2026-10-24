/**
 * ============================================================================
 *  net/netbios.ts — ask a Windows machine what it calls itself
 * ============================================================================
 *
 *  Reverse DNS answers for almost nothing on a home LAN (routers rarely run a
 *  PTR zone), but Windows machines and many NAS boxes still answer a NetBIOS
 *  name query. The name is real data reported by the device: "DESKTOP-7F2K1"
 *  is far better evidence than an OUI guess, and it makes the map readable.
 *
 *  The query is a single UDP datagram that the operating system sends for us;
 *  a host that does not answer just returns null.
 * ============================================================================
 */

import { execFile } from "node:child_process";

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? "" : `${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });
}

/** Pull the unique <00> workstation name out of nbtstat / nmblookup output. */
function parseNetbiosTable(output: string): string | null {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    // "DESKTOP-ABC123  <00>  UNIQUE      Registered"
    const windows = /^(\S{1,15})\s+<00>\s+UNIQUE\s+Registered/i.exec(line);
    if (windows) return windows[1];
    // "<20> UNIQUE Registered" entries repeat the name as the first column.
    const nmblookup = /^(\S{1,15})\s+<00>/i.exec(line);
    if (nmblookup && !/^WORKGROUP$/i.test(nmblookup[1])) return nmblookup[1];
  }
  return null;
}

/**
 * The NetBIOS name of a host, or null.
 *
 * A name made only of the network's own workgroup is not a device name, so it
 * is discarded by the parser's workgroup check.
 */
export async function readNetbiosName(ip: string, timeoutMs = 1200): Promise<string | null> {
  if (process.platform === "win32") {
    const output = await run("nbtstat", ["-A", ip], timeoutMs);
    return output.trim() ? parseNetbiosTable(output) : null;
  }

  if (process.platform === "linux") {
    const output = await run("nmblookup", ["-A", ip], timeoutMs);
    return output.trim() ? parseNetbiosTable(output) : null;
  }

  return null;
}
