/**
 * /iclock/getrequest — Native ZKTeco ADMS Command Polling & Heartbeat Endpoint
 * ZKTeco terminals poll `GET /iclock/getrequest?SN=<serial>` every 10-30 seconds.
 * Updating Last_Ping here keeps the device status "Online" in real-time.
 */
import type { NextRequest } from "next/server";
import { findTerminal, getDb, touchTerminal } from "@/lib/db";

function ack(message = "OK"): Response {
  return new Response(message, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: NextRequest) {
  const serial =
    request.nextUrl.searchParams.get("SN") ??
    request.nextUrl.searchParams.get("sn") ??
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

  return ack("OK");
}

export async function POST(request: NextRequest) {
  return GET(request);
}
