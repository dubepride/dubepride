/**
 * ============================================================================
 *  /api/biometrics/push — Terminal Listener (ADMS / HTTP Push receiver)
 * ============================================================================
 *
 *  This is the public endpoint that IP fingerprint terminals dial into.
 *  It accepts the standard ADMS "HTTP Push" protocol used by ZKTeco-class
 *  devices (and tolerant variants used by comparable hardware):
 *
 *    • GET  /api/biometrics/push?SN=<serial>&table=ATTLOG&Stamp=…
 *          → device handshake / keep-alive. ACK'd with 200 so firmware
 *            stops retransmitting.
 *
 *    • POST /api/biometrics/push?SN=<serial>&table=ATTLOG
 *          → transaction batch. Body is line-delimited, e.g.
 *
 *              ID=1001&Name=Amara&Time=2026-10-07 08:02:07&Status=0&Verify=1
 *              ID=1002&Time=2026-10-07 08:04:44&Status=0&Verify=1
 *
 *            CSV bodies ("1001,2026-10-07 08:02:07,…") and JSON bodies
 *            ({"employeeId":"ERP-1001","timestamp":"…"}) are also accepted
 *            so generic terminals / test scripts can integrate easily.
 *
 *  Flow: parse → resolve terminal → resolve employee → INSERT into
 *  Attendance_Logs with ERP_Sync_Status = 'Pending' → ACK "OK".
 *  The ERP Sync Engine later drains Pending records (offline buffering).
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  CONNECTING REAL HARDWARE (example — ZKTeco push settings):
 *    Server URL : http://<bridge-host>:3000/api/biometrics/push
 *    Protocol   : HTTP Push  (a.k.a. ADMS / cserver)
 *    User / Pwd : leave empty or match your reverse proxy auth
 *    The device transmits SN=<serial>; register it as Terminal_MAC (or add
 *    a Serial_Number column + lookup in findTerminal() below).
 *  ─────────────────────────────────────────────────────────────────────
 */

import type { NextRequest } from "next/server";
import {
  findTerminal,
  getDb,
  insertPunch,
  resolveEmployee,
  touchTerminal,
} from "@/lib/db";
import type { PunchDirection, VerifyResult } from "@/lib/types";

/** Devices expect a tiny plain-text acknowledgement, not JSON. */
function ack(message: string, status = 200): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store", // never let proxies cache device ACKs
    },
  });
}

/** Device timestamps arrive as "YYYY-MM-DD HH:MM:SS" (device local time),
 *  "YYYY/MM/DD …" or raw epoch seconds/milliseconds. Normalise to epoch ms. */
function parseDeviceTime(value: string | null | undefined): number {
  if (!value) return Date.now();
  const s = value.trim();
  if (/^\d{13}$/.test(s)) return Number(s); // epoch milliseconds
  if (/^\d{10}$/.test(s)) return Number(s) * 1000; // epoch seconds
  const isoish = s.replace(" ", "T").replace(/\//g, "-");
  const parsed = new Date(isoish); // interpreted as server-local time
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

interface RawEvent {
  employeeRef: string | null;
  timestamp: number;
  direction?: PunchDirection;
  raw: string;
}

/** Keys various firmware lines use for the employee identifier. */
const EMP_KEYS = ["ID", "EMP", "EMPID", "EMPLOYEE", "ECode", "UserID", "eno", "employee_id", "badge_id"];
/** Keys used for the punch timestamp. */
const TIME_KEYS = ["Time", "DateTime", "datetime", "T", "punch_time", "timestamp", "Stamp"];
/** Keys used for clock direction. */
const DIR_KEYS = ["Direction", "dir", "PunchState", "InOut"];

function firstValue(pairs: URLSearchParams, keys: string[]): string | null {
  for (const k of keys) {
    const v = pairs.get(k);
    if (v !== null && v !== "") return v;
  }
  return null;
}

function eventFromPairs(pairs: URLSearchParams, raw: string): RawEvent | null {
  const employeeRef = firstValue(pairs, EMP_KEYS);
  const time = firstValue(pairs, TIME_KEYS);
  // A line with neither an ID nor a time is not a transaction (could be a
  // keep-alive echo or an unsupported record type) — acknowledge, skip.
  if (!employeeRef && !time) return null;

  const dirRaw = firstValue(pairs, DIR_KEYS)?.toUpperCase();
  const direction: PunchDirection | undefined =
    dirRaw && (dirRaw.includes("OUT") || dirRaw === "1") ? "OUT" : dirRaw ? "IN" : undefined;

  return {
    employeeRef,
    timestamp: parseDeviceTime(time),
    direction,
    raw,
  };
}

/**
 * Tolerant multi-format body parser.
 * Order matters: JSON → line-delimited `k=v` (ADMS classic) → CSV.
 */
function parseEvents(body: string, query: URLSearchParams): RawEvent[] {
  const trimmed = body.trim();

  // No body at all — some firmware puts the single event on the query string.
  if (!trimmed) {
    const fromQuery = eventFromPairs(query, query.toString());
    return fromQuery ? [fromQuery] : [];
  }

  // (a) JSON — used by modern terminals, Postman tests and curl scripts.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(json) ? json : [json];
      const events: RawEvent[] = [];
      for (const item of arr) {
        if (typeof item !== "object" || item === null) continue;
        const o = item as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
        const employeeRef =
          str(o.employeeId) ?? str(o.employee_id) ?? str(o.id) ?? str(o.userId) ?? str(o.erpUserId);
        const time = str(o.timestamp) ?? str(o.time) ?? str(o.punchTime) ?? str(o.Time);
        events.push({
          employeeRef,
          timestamp: parseDeviceTime(time),
          direction:
            String(o.direction ?? "").toUpperCase() === "OUT"
              ? "OUT"
              : String(o.direction ?? "").toUpperCase() === "IN"
                ? "IN"
                : undefined,
          raw: JSON.stringify(item),
        });
      }
      return events;
    } catch {
      // Malformed JSON — fall through to the line parser below.
    }
  }

  // (b) ADMS line format: one transaction per line, `&`-separated key=value
  //     pairs (some firmware joins batches with `&` instead of newlines).
  const events: RawEvent[] = [];
  for (const segment of trimmed.split(/\r?\n|(?<=\S)&(?=ID=)/)) {
    const line = segment.trim().replace(/^&+/, "");
    if (!line) continue;

    if (line.includes("=")) {
      const ev = eventFromPairs(new URLSearchParams(line), line);
      if (ev) events.push(ev);
    } else if (line.includes(",")) {
      // (c) CSV: ID,Time[,Status,Verify,…]
      const [id, time] = line.split(",");
      events.push({
        employeeRef: id?.trim() || null,
        timestamp: parseDeviceTime(time),
        raw: line,
      });
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

  // ── 1. Filter packet types ──────────────────────────────────────────
  // Devices also push DeviceInfo / Userinfo / template / photo packets.
  // Only ATTLOG (transaction) frames become attendance logs; everything
  // else gets a 200 ACK so the firmware stops retransmitting it.
  // ── WIRE HERE LATER ─────────────────────────────────────────────────
  // table=Userinfo → sync enrolled templates to your HR system, etc.
  // ────────────────────────────────────────────────────────────────────
  if (table && table.toUpperCase() !== "ATTLOG") {
    return ack(`OK: ignored table=${table}`);
  }

  const body = await request.text();

  // ── 2. Identify the sending terminal ────────────────────────────────
  // Match order: serial number (SN ≙ MAC) → source IP (direct L2 network
  // or reverse-proxy header). Unknown sources still get an ACK, but their
  // punches are stored with Terminal_ID = NULL (never dropped).
  // ────────────────────────────────────────────────────────────────────
  const serial = url.searchParams.get("SN") ?? url.searchParams.get("sn");
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientIp = forwarded || request.headers.get("x-real-ip") || null;

  const db = await getDb();
  const terminal = await findTerminal(db, { mac: serial, ip: clientIp });
  if (terminal) {
    // Keep-alive stamp — same path as the GET handshake below.
    await touchTerminal(db, terminal.Terminal_ID);
  }

  // ── 3. Parse transactions ───────────────────────────────────────────
  const events = parseEvents(body, url.searchParams);
  if (events.length === 0) {
    // Handshake / heartbeat with no punch data.
    return ack("OK");
  }

  // ── 4. Persist each event as Pending for the ERP sync engine ────────
  let received = 0;
  for (const ev of events) {
    const employee = ev.employeeRef ? await resolveEmployee(db, ev.employeeRef) : undefined;
    await insertPunch({
      employeeRef: ev.employeeRef, // unknown IDs land as Employee_ID = NULL
      timestamp: ev.timestamp,
      terminalId: terminal?.Terminal_ID ?? null,
      direction: ev.direction,
      // ID present but not enrolled in this bridge → Denied (quarantined).
      verifyResult: (employee ? "Verified" : "Denied") as VerifyResult,
      verifyMethod: "Fingerprint",
      rawPayload: ev.raw,
    });
    received += 1;
  }

  // ── 5. ACK ──────────────────────────────────────────────────────────
  // Returning 200 makes the device mark the batch as delivered; without
  // it the firmware retransmits for hours (that IS the offline buffer).
  return ack(`OK: received=${received}`);
}

/* ------------------------------------------------------------------ */
/* GET — handshake / keep-alive                                          */
/* ------------------------------------------------------------------ */

export async function GET(request: NextRequest) {
  const serial = request.nextUrl.searchParams.get("SN");
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientIp = forwarded || request.headers.get("x-real-ip") || null;

  const db = await getDb();
  const terminal = await findTerminal(db, { mac: serial, ip: clientIp });
  if (terminal) await touchTerminal(db, terminal.Terminal_ID);

  // ── WIRE HERE LATER ─────────────────────────────────────────────────
  // The handshake response can carry a command queue for the device, e.g.
  //   ack("C:({-Ok})")                     → ZKTeco "clear buffer" ack
  //   ack("Set Comm Key = 123456\n...")    → push encryption setup
  // For now a plain 200 OK keeps firmware happy and stamps Last_Ping so
  // the Terminal Manager shows the device Online.
  // ────────────────────────────────────────────────────────────────────
  return ack("OK");
}
