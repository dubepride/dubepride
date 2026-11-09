/**
 * ============================================================================
 *  /api/biometrics/push & /iclock/cdata — Universal Terminal Listener
 *  (ZKTeco ADMS / eSSL / BioTime / Hikvision ISAPI / Anviz / Generic Webhook)
 * ============================================================================
 *
 *  Public endpoint that IP fingerprint, face, and card terminals dial into.
 *  Supports:
 *    1. ZKTeco / eSSL / ZKBio ADMS Push Protocol (/iclock/cdata & /api/biometrics/push)
 *       • GET ?SN=<serial>&options=all → full ADMS configuration handshake
 *       • POST ?SN=<serial>&table=ATTLOG → tab-separated (\t) or key=value lines:
 *           1001\t2026-11-09 08:02:07\t0\t1\t0\t0
 *           ID=1001&Time=2026-11-09 08:02:07&Status=0&Verify=1
 *    2. Hikvision ISAPI HTTP Listening / Event Push (JSON & multipart/form-data)
 *       • AccessControllerEvent payloads with employeeNoString / serialNo / dateTime
 *    3. Generic JSON, Array of JSON, CSV, and Query-String Webhooks
 *    4. Automatic Terminal Discovery:
 *       • Any terminal pushing with a Serial Number (SN) or MAC is automatically
 *         matched or registered in the Terminals table and marked Online.
 */

import type { NextRequest } from "next/server";
import { after } from "next/server";
import { runErpSync } from "@/lib/erp";
import { isBackgroundServicesRunning } from "@/lib/mock-generator";
import {
  findTerminal,
  getDb,
  insertPunch,
  normalizeTerminalDirectionMode,
  resolveEmployee,
  touchTerminal,
} from "@/lib/db";
import type { PunchDirection, TerminalProtocol, VerifyResult } from "@/lib/types";

/** Devices expect a plain-text acknowledgement, not JSON. */
function ack(message: string, status = 200): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Known timezone offsets (hours from UTC) for fast deterministic parsing,
 * with fallback to Intl.DateTimeFormat for any other IANA timezone.
 */
const TIMEZONE_OFFSETS: Record<string, string> = {
  "Africa/Harare": "+02:00",
  "Africa/Johannesburg": "+02:00",
  "Africa/Lusaka": "+02:00",
  "Africa/Gaborone": "+02:00",
  "Africa/Maputo": "+02:00",
  "Africa/Cairo": "+02:00",
  "Africa/Nairobi": "+03:00",
  "Africa/Lagos": "+01:00",
  UTC: "+00:00",
  "Etc/UTC": "+00:00",
  "Europe/London": "+00:00",
  "Asia/Dubai": "+04:00",
  "Asia/Shanghai": "+08:00",
};

function resolveTzOffset(tz: string | null | undefined): string {
  const clean = (tz || "Africa/Harare").trim();
  if (TIMEZONE_OFFSETS[clean]) return TIMEZONE_OFFSETS[clean];
  if (/^[+-]\d{2}:\d{2}$/.test(clean)) return clean;
  return "+02:00";
}

/**
 * Parse device timestamp into epoch milliseconds.
 * When a terminal sends local wall-clock time without an offset
 * (e.g. "2026-11-09 08:02:07"), apply the terminal's configured timezone
 * (default Africa/Harare, UTC+02:00) so cloud servers running in UTC
 * never shift attendance timestamps.
 */
function parseDeviceTime(
  value: string | null | undefined,
  timezone = "Africa/Harare"
): number {
  if (!value) return Date.now();
  const s = value.trim();
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;

  let isoish = s.replace(/\//g, "-").replace(" ", "T");
  // If no timezone indicator (Z or ±HH:MM) is present on a YYYY-MM-DDTHH:MM(:SS) string, append terminal offset
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(isoish)) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(isoish)) {
      isoish += ":00";
    }
    isoish += resolveTzOffset(timezone);
  }
  const parsed = new Date(isoish);
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

/** Map ZKTeco / ADMS numeric Verify code to human-readable method. */
function mapVerifyMethod(code: string | number | null | undefined): string {
  if (code === null || code === undefined || code === "") return "Fingerprint";
  const s = String(code).trim().toLowerCase();
  if (s === "0" || s === "pwd" || s === "password" || s === "pin") return "PIN";
  if (s === "1" || s === "fp" || s === "finger" || s === "fingerprint") return "Fingerprint";
  if (s === "2" || s === "3" || s === "4" || s === "card" || s === "rfid") return "Card";
  if (s === "15" || s === "face" || s === "facial") return "Face";
  if (s === "25" || s === "palm") return "Palm";
  return "Fingerprint";
}

/** Map ZKTeco / ADMS Status code (0=Check-In, 1=Check-Out, 2=Break-Out, 3=Break-In, 4=OT-In, 5=OT-Out). */
function mapStatusToDirection(statusRaw: string | number | null | undefined): PunchDirection | undefined {
  if (statusRaw === null || statusRaw === undefined || statusRaw === "") return undefined;
  const s = String(statusRaw).trim().toUpperCase();
  if (s === "1" || s === "2" || s === "5" || s.includes("OUT") || s === "CHECKOUT" || s === "CHECK_OUT") {
    return "OUT";
  }
  if (s === "0" || s === "3" || s === "4" || s.includes("IN") || s === "CHECKIN" || s === "CHECK_IN") {
    return "IN";
  }
  return undefined;
}

interface RawEvent {
  employeeRef: string | null;
  timestamp: number;
  direction?: PunchDirection;
  /** True when the payload explicitly specified IN/OUT rather than a default numeric Status=0. */
  explicitDirection?: boolean;
  verifyMethod: string;
  deviceSn?: string | null;
  raw: string;
}

const EMP_KEYS = ["PIN", "pin", "ID", "id", "EMP", "EMPID", "EMPLOYEE", "ECode", "UserID", "eno", "employee_id", "badge_id"];
const TIME_KEYS = ["Time", "time", "DateTime", "datetime", "T", "punch_time", "timestamp", "Stamp"];
const DIR_KEYS = ["Direction", "dir", "PunchState", "InOut", "Status", "status"];
const VERIFY_KEYS = ["Verify", "verify", "VerifyMethod", "verify_method", "AuthMode"];

function firstValue(pairs: URLSearchParams, keys: string[]): string | null {
  for (const k of keys) {
    const v = pairs.get(k);
    if (v !== null && v !== "") return v;
  }
  return null;
}

function eventFromPairs(
  pairs: URLSearchParams,
  raw: string,
  timezone: string
): RawEvent | null {
  const employeeRef = firstValue(pairs, EMP_KEYS);
  const time = firstValue(pairs, TIME_KEYS);
  if (!employeeRef && !time) return null;

  const explicitDirRaw =
    pairs.get("Direction") ?? pairs.get("dir") ?? pairs.get("InOut") ?? null;
  const statusRaw =
    explicitDirRaw ?? pairs.get("Status") ?? pairs.get("status") ?? pairs.get("PunchState") ?? null;
  const direction = mapStatusToDirection(statusRaw);
  const verifyRaw = firstValue(pairs, VERIFY_KEYS);

  return {
    employeeRef,
    timestamp: parseDeviceTime(time, timezone),
    direction,
    explicitDirection: Boolean(explicitDirRaw),
    verifyMethod: mapVerifyMethod(verifyRaw),
    raw,
  };
}

/**
 * Parse a single JSON object (supports generic JSON, Hikvision AccessControllerEvent,
 * Anviz/Suprema webhooks, etc.).
 */
function parseJsonObject(
  o: Record<string, unknown>,
  timezone: string
): RawEvent | null {
  const str = (v: unknown) =>
    typeof v === "string" || typeof v === "number" ? String(v).trim() : null;

  // Check for Hikvision ISAPI AccessControllerEvent wrapper
  const hik =
    typeof o.AccessControllerEvent === "object" && o.AccessControllerEvent !== null
      ? (o.AccessControllerEvent as Record<string, unknown>)
      : null;

  if (hik) {
    const empRef =
      str(hik.employeeNoString) ??
      str(hik.cardNo) ??
      str(hik.userId) ??
      null;
    // Ignore pure door status events that carry no employee identifier
    if (!empRef) return null;
    const time = str(o.dateTime) ?? str(hik.time) ?? str(o.time);
    const attStatus = str(hik.attendanceStatus) ?? str(hik.status);
    const verifyMode = str(hik.currentVerifyMode) ?? str(hik.verifyNo);
    const deviceSn = str(o.deviceID) ?? str(hik.deviceNo) ?? str(o.macAddress);
    return {
      employeeRef: empRef,
      timestamp: parseDeviceTime(time, timezone),
      direction: mapStatusToDirection(attStatus),
      explicitDirection: Boolean(attStatus),
      verifyMethod: verifyMode?.toLowerCase().includes("face")
        ? "Face"
        : verifyMode?.toLowerCase().includes("card")
          ? "Card"
          : "Fingerprint",
      deviceSn,
      raw: JSON.stringify(o),
    };
  }

  const employeeRef =
    str(o.employeeId) ??
    str(o.employee_id) ??
    str(o.erpUserId) ??
    str(o.pin) ??
    str(o.PIN) ??
    str(o.userId) ??
    str(o.user_id) ??
    str(o.badge_id) ??
    str(o.id);
  const time =
    str(o.timestamp) ??
    str(o.time) ??
    str(o.punchTime) ??
    str(o.DateTime) ??
    str(o.dateTime) ??
    str(o.Time);

  if (!employeeRef && !time) return null;

  const dirRaw = str(o.direction) ?? str(o.status) ?? str(o.Status) ?? str(o.inOut);
  const verifyRaw = str(o.verifyMethod) ?? str(o.verify) ?? str(o.Verify);
  const deviceSn = str(o.sn) ?? str(o.SN) ?? str(o.serialNumber) ?? str(o.mac);

  return {
    employeeRef,
    timestamp: parseDeviceTime(time, timezone),
    direction: mapStatusToDirection(dirRaw),
    explicitDirection: Boolean(o.direction ?? o.inOut),
    verifyMethod: mapVerifyMethod(verifyRaw),
    deviceSn,
    raw: JSON.stringify(o),
  };
}

/**
 * Universal multi-format body parser:
 *  1. Hikvision / multipart JSON blocks
 *  2. Standard JSON object or array
 *  3. ZKTeco native ADMS tab-separated (\t) ATTLOG lines:
 *       PIN\tTime\tStatus\tVerify\tWorkcode\tReserved1\tReserved2
 *  4. ADMS key=value lines (ID=1001&Time=... or PIN=1001\tTime=...)
 *  5. CSV lines (1001,2026-11-09 08:02:07,IN,Fingerprint)
 */
function parseEvents(
  body: string,
  query: URLSearchParams,
  timezone = "Africa/Harare"
): RawEvent[] {
  const trimmed = body.trim();

  if (!trimmed) {
    const fromQuery = eventFromPairs(query, query.toString(), timezone);
    return fromQuery ? [fromQuery] : [];
  }

  // (a) Standard JSON object or array
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(json) ? json : [json];
      const events: RawEvent[] = [];
      for (const item of arr) {
        if (typeof item !== "object" || item === null) continue;
        const ev = parseJsonObject(item as Record<string, unknown>, timezone);
        if (ev) events.push(ev);
      }
      return events;
    } catch {
      // Fall through if not valid JSON
    }
  }

  // (b) Multipart form-data containing JSON (Hikvision ISAPI alarm/event stream)
  if (trimmed.includes("AccessControllerEvent") && trimmed.includes("{")) {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const json: unknown = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        if (typeof json === "object" && json !== null) {
          const ev = parseJsonObject(json as Record<string, unknown>, timezone);
          if (ev) return [ev];
        }
      } catch {
        // Fall through
      }
    }
  }

  // (c) Line-by-line parser: ZKTeco tab-separated (\t), key=value, and CSV
  const events: RawEvent[] = [];
  for (const segment of trimmed.split(/\r?\n|(?<=\S)&(?=(?:ID|PIN)=)/i)) {
    let line = segment.trim().replace(/^&+/, "");
    if (!line) continue;

    // Strip optional "ATTLOG\t" prefix sent by some BioTime / Push v3 firmwares
    if (/^ATTLOG[\t ]+/i.test(line)) {
      line = line.replace(/^ATTLOG[\t ]+/i, "").trim();
    }

    // Ignore non-attendance OPERLOG lines (OPLOG, USER, FP, FACE, BIODATA) that sometimes share a batch
    if (/^(?:OPLOG|USER|FP|FACE|BIODATA|USERPIC)[\t ]/i.test(line)) {
      continue;
    }

    // Case 1: Key=Value format (either &-separated or tab-separated key=value pairs)
    if (line.includes("=")) {
      const normalized = line.replace(/\t+/g, "&");
      const ev = eventFromPairs(new URLSearchParams(normalized), line, timezone);
      if (ev) events.push(ev);
      continue;
    }

    // Case 2: ZKTeco native ADMS tab-separated ATTLOG row:
    // Format: PIN \t YYYY-MM-DD HH:MM:SS \t Status \t Verify [\t Workcode \t Reserved1 \t Reserved2]
    if (line.includes("\t")) {
      const cols = line.split("\t").map((c) => c.trim());
      const [pin, time, statusCode, verifyCode] = cols;
      if (pin || time) {
        events.push({
          employeeRef: pin || null,
          timestamp: parseDeviceTime(time, timezone),
          direction: mapStatusToDirection(statusCode),
          explicitDirection: false,
          verifyMethod: mapVerifyMethod(verifyCode),
          raw: line,
        });
      }
      continue;
    }

    // Case 3: CSV (ID,Time[,Status/Direction,Verify])
    if (line.includes(",")) {
      const [id, time, statusCode, verifyCode] = line.split(",").map((c) => c.trim());
      if (id || time) {
        events.push({
          employeeRef: id || null,
          timestamp: parseDeviceTime(time, timezone),
          direction: mapStatusToDirection(statusCode),
          explicitDirection: statusCode?.toUpperCase() === "IN" || statusCode?.toUpperCase() === "OUT",
          verifyMethod: mapVerifyMethod(verifyCode),
          raw: line,
        });
      }
    }
  }
  return events;
}

/* ------------------------------------------------------------------ */
/* POST — transaction push                                              */
/* ------------------------------------------------------------------ */

export async function POST(request: NextRequest) {
  const url = request.nextUrl;
  const table = url.searchParams.get("table");

  const body = await request.text();

  // Extract serial / MAC from query string, headers, or JSON body
  const serial =
    url.searchParams.get("SN") ??
    url.searchParams.get("sn") ??
    url.searchParams.get("mac") ??
    url.searchParams.get("deviceId") ??
    request.headers.get("x-device-sn") ??
    null;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientIp = forwarded || request.headers.get("x-real-ip") || null;

  const isHikvision = body.includes("AccessControllerEvent");
  const protocolHint: TerminalProtocol = isHikvision ? "Hikvision" : "ADMS";

  const db = await getDb();
  let terminal = await findTerminal(db, {
    sn: serial,
    mac: serial,
    ip: clientIp,
    autoDiscover: true,
    protocol: protocolHint,
  });
  if (terminal) {
    await touchTerminal(db, terminal.Terminal_ID);
  }

  // Non-attendance tables (OPERLOG, Userinfo, options, etc.) are acknowledged immediately
  // after updating the terminal's heartbeat so the device stays Online.
  if (table && table.toUpperCase() !== "ATTLOG") {
    return ack("OK");
  }

  const timezone = terminal?.Timezone || "Africa/Harare";
  const events = parseEvents(body, url.searchParams, timezone);

  // If the terminal was not identified from query/IP, check if the JSON payload carried a deviceSn
  if (!terminal && events.length > 0 && events[0].deviceSn) {
    terminal = await findTerminal(db, {
      sn: events[0].deviceSn,
      mac: events[0].deviceSn,
      ip: clientIp,
      autoDiscover: true,
      protocol: protocolHint,
    });
    if (terminal) {
      await touchTerminal(db, terminal.Terminal_ID);
    }
  }

  if (events.length === 0) {
    return ack("OK");
  }

  const dirMode = normalizeTerminalDirectionMode(terminal?.Direction_Mode);

  let received = 0;
  for (const ev of events) {
    const employee = ev.employeeRef ? await resolveEmployee(db, ev.employeeRef) : undefined;

    // Resolve final direction according to the terminal's Direction_Mode
    let finalDirection: PunchDirection | undefined;
    if (dirMode === "IN_Only") {
      finalDirection = "IN";
    } else if (dirMode === "OUT_Only") {
      finalDirection = "OUT";
    } else if (dirMode === "Device") {
      finalDirection = ev.direction ?? "IN";
    } else {
      // "Auto": alternate IN/OUT based on the employee's punches today,
      // unless an explicit IN/OUT override was sent in a test/JSON payload.
      finalDirection = ev.explicitDirection ? ev.direction : undefined;
    }

    await insertPunch({
      employeeRef: ev.employeeRef,
      timestamp: ev.timestamp,
      terminalId: terminal?.Terminal_ID ?? null,
      direction: finalDirection,
      verifyResult: (employee ? "Verified" : "Denied") as VerifyResult,
      verifyMethod: ev.verifyMethod || "Fingerprint",
      rawPayload: ev.raw,
    });
    received += 1;
  }

  if (!isBackgroundServicesRunning()) {
    after(async () => {
      try {
        await runErpSync("Auto");
      } catch (err) {
        console.error("[push] post-ack ERP sync failed:", err);
      }
    });
  }

  return ack(`OK: ${received}`);
}

/* ------------------------------------------------------------------ */
/* GET — ADMS handshake / options / keep-alive                          */
/* ------------------------------------------------------------------ */

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const serial =
    params.get("SN") ??
    params.get("sn") ??
    params.get("mac") ??
    params.get("deviceId") ??
    request.headers.get("x-device-sn") ??
    null;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientIp = forwarded || request.headers.get("x-real-ip") || null;

  const db = await getDb();
  const terminal = await findTerminal(db, {
    sn: serial,
    mac: serial,
    ip: clientIp,
    autoDiscover: true,
    protocol: "ADMS",
  });
  if (terminal) {
    await touchTerminal(db, terminal.Terminal_ID);
  }

  // ZKTeco / eSSL ADMS initial handshake: GET /iclock/cdata?SN=xxx&options=all
  // Returning the standard ADMS option block instructs the device firmware to
  // push attendance logs in real-time (Realtime=1, TransFlag=1111000000).
  const options = params.get("options");
  if (options && serial) {
    const admsOptions = [
      `GET OPTION FROM: ${serial}`,
      "ATTLOGStamp=0",
      "OPERLOGStamp=9999",
      "ATTPHOTOStamp=None",
      "ErrorDelay=30",
      "Delay=10",
      "TransTimes=00:00;14:05",
      "TransInterval=1",
      "TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser\tEnrollFP\tChgFP\tFACE",
      "TimeZone=2",
      "Realtime=1",
      "Encrypt=0",
    ].join("\n");
    return ack(admsOptions + "\n");
  }

  return ack("OK");
}
