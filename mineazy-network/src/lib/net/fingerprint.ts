/**
 * ============================================================================
 *  net/fingerprint.ts — classify by what the device actually answers
 * ============================================================================
 *
 *  A MAC prefix says who made the radio inside a device, not what the device
 *  is. Mapping every Liteon or Huawei OUI to "camera" is how a network ends up
 *  with fifteen NVRs that do not exist.
 *
 *  A port that answers is direct evidence. This module opens a plain TCP
 *  connection to a short list of service ports and reports which ones accepted
 *  it. Nothing is sent beyond the handshake, and a closed port is treated as
 *  "no evidence" — never as proof that the device is not that thing.
 *
 *  The rules are deliberately few. When the ports do not distinguish two
 *  device types the answer stays "unknown" and says so.
 * ============================================================================
 */

import { tcpProbe } from "./probes";
import type { Classification } from "./classify";

/**
 * Ports worth asking about, and what an open one means:
 *
 *   22     SSH            — servers, access points, some cameras
 *   53     DNS            — routers, Pi-hole
 *   80/443 HTTP(S)        — a web UI; says nothing about the device type
 *   445    SMB            — Windows, NAS, some printers
 *   554    RTSP           — video streaming: camera or recorder
 *   631    IPP            — printer
 *   8000   Hikvision web  — camera / NVR
 *   8080   HTTP alt       — camera web UI, proxies
 *   8443   HTTPS alt
 *   9100   raw printing   — printer
 *   37777  Dahua control  — camera / NVR
 *   62078  Apple lockdown — iPhone / iPad
 */
export const FINGERPRINT_PORTS = [22, 53, 80, 443, 445, 554, 631, 8000, 8080, 8443, 9100, 37777, 62078];

export interface HostFingerprint {
  ip: string;
  openPorts: number[];
  /** Ports that were actually asked, so "none open" is not confused with "not tested". */
  probedPorts: number[];
}

/** Open a TCP connection to each service port; report the ones that answer. */
export async function fingerprintHost(ip: string, timeoutMs = 400): Promise<HostFingerprint> {
  const results = await Promise.all(
    FINGERPRINT_PORTS.map(async (port) => ({ port, ok: (await tcpProbe(ip, port, timeoutMs)).ok }))
  );
  return {
    ip,
    openPorts: results.filter((entry) => entry.ok).map((entry) => entry.port),
    probedPorts: FINGERPRINT_PORTS,
  };
}

const CAMERA_VENDORS = [
  "foscam",
  "hikvision",
  "dahua",
  "reolink",
  "amcrest",
  "anpviz",
  "axis",
  "vivotek",
  "uniview",
  "ezviz",
  "lorex",
  "swann",
];

const NAS_VENDORS = ["qnap", "synology", "western digital", "asustor", "terramaster", "drobo"];
const PRINTER_VENDORS = ["hewlett", "hp ", "epson", "brother", "canon", "lexmark", "kyocera", "xerox", "ricoh"];

/**
 * Decide a category from open ports.
 *
 * Returns null when the ports do not decide anything — which is the common and
 * correct answer for a phone or a laptop behind a firewall.
 */
export function classifyFromPorts(input: {
  openPorts: number[];
  manufacturer?: string | null;
  hostname?: string | null;
}): Classification | null {
  const open = new Set(input.openPorts);
  const vendor = (input.manufacturer ?? "").toLowerCase();
  const hostname = (input.hostname ?? "").toLowerCase();
  const cameraVendor = CAMERA_VENDORS.some((name) => vendor.includes(name));
  const nasVendor = NAS_VENDORS.some((name) => vendor.includes(name));
  const printerVendor = PRINTER_VENDORS.some((name) => vendor.includes(name));
  const namedRecorder = /\b(nvr|xvr|dvr)\b/.test(hostname);
  const namedCamera = /\b(cam|ipc|doorbell)\b/.test(hostname);

  const list = (ports: number[]): string =>
    ports.filter((port) => open.has(port)).map((port) => `TCP ${port}`).join(", ");

  // A printer is one of the few devices whose role is unambiguous from a port.
  if (open.has(9100) || open.has(631)) {
    return {
      category: "printer",
      confidence: "probable",
      evidence: `${list([9100, 631])} answered — that is a print service, not a guess from the MAC.`,
    };
  }

  // Apple's lockdown port is specific to iOS devices.
  if (open.has(62078)) {
    return {
      category: "phone",
      confidence: "probable",
      evidence: "TCP 62078 answered — the Apple mobile-device service. Only iOS devices listen on it.",
    };
  }

  const videoPorts = [554, 37777, 8000].filter((port) => open.has(port));
  if (videoPorts.length > 0) {
    const isRecorder = namedRecorder || (open.has(37777) && !namedCamera && !cameraVendor);
    return {
      category: isRecorder ? "nvr" : "camera",
      confidence: isRecorder ? "probable" : cameraVendor ? "confirmed" : "probable",
      evidence: `${list(videoPorts)} answered${cameraVendor ? `, and the MAC belongs to ${input.manufacturer}` : ""}. ` +
        (isRecorder
          ? "A recorder control port answered; the device is treated as a recorder."
          : "That is a video service; without a recorder-specific port the device is treated as a camera."),
    };
  }

  if (nasVendor && (open.has(445) || open.has(443) || open.has(8080))) {
    return {
      category: "nas",
      confidence: "probable",
      evidence: `${list([445, 443, 8080])} answered and the MAC belongs to ${input.manufacturer}.`,
    };
  }

  if (printerVendor && open.has(80) && !open.has(445)) {
    // A printer web UI without a print port is still a printer, but weaker.
    return {
      category: "printer",
      confidence: "probable",
      evidence: `The MAC belongs to ${input.manufacturer} and TCP 80 answered, with no file-sharing port.`,
    };
  }

  if (open.has(445)) {
    if (/\b(nas|storage)\b/.test(hostname)) {
      return {
        category: "nas",
        confidence: "probable",
        evidence: "TCP 445 answered and the device calls itself storage.",
      };
    }
    if (/\b(desktop|pc|workstation)\b/.test(hostname)) {
      return {
        category: "desktop",
        confidence: "probable",
        evidence: "TCP 445 answered and the hostname identifies a desktop.",
      };
    }
    if (/\b(laptop|notebook|thinkpad|macbook)\b/.test(hostname)) {
      return {
        category: "laptop",
        confidence: "probable",
        evidence: "TCP 445 answered and the hostname identifies a laptop.",
      };
    }
    // SMB without a hostname is a computer of some kind. Saying which would be
    // a guess, so the category stays open and the evidence names the port.
    return null;
  }

  return null;
}
