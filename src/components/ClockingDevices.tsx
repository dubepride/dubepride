"use client";

import { useEffect, useMemo, useState } from "react";
import { formatRelative } from "@/lib/format";
import { methodUsesTerminal } from "@/lib/geofence";
import type {
  TerminalDirectionMode,
  TerminalDto,
  TerminalProtocol,
  TerminalsResponse,
} from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import MetricCard from "./MetricCard";
import { IconClock, IconScan, IconServer, IconX } from "./icons";
import {
  ClockingMethodBadge,
  ClockingMethodFields,
  clockingPayload,
  emptyClockingFields,
  type ClockingFieldsValue,
} from "./ClockingMethodFields";

/**
 * ============================================================================
 *  Clocking Devices — branch-first hardware & geofence device console
 * ============================================================================
 */

const BRANCHES: string[] = [];

type ModalMode = "add" | "edit" | "remove" | "setup";

interface ModalState {
  mode: ModalMode;
  device: TerminalDto | null;
}

const PROTOCOL_OPTIONS: ReadonlyArray<{
  value: TerminalProtocol;
  label: string;
  defaultPort: number;
  hint: string;
}> = [
  {
    value: "ADMS",
    label: "ZKTeco / eSSL / BioTime (ADMS / iClock Push)",
    defaultPort: 4370,
    hint: "Standard ZKTeco Cloud Server (ADMS) protocol — pushes tab-separated ATTLOG records to /iclock/cdata or /api/biometrics/push.",
  },
  {
    value: "Hikvision",
    label: "Hikvision / MinMoe (ISAPI HTTP Listening)",
    defaultPort: 80,
    hint: "Hikvision Access Control & Face terminals — pushes AccessControllerEvent JSON/multipart frames to /api/biometrics/push.",
  },
  {
    value: "Anviz",
    label: "Anviz CrossChex (HTTP Push / Webhook)",
    defaultPort: 5010,
    hint: "Anviz fingerprint & face terminals pushing attendance payloads over HTTP/JSON.",
  },
  {
    value: "Suprema",
    label: "Suprema BioStar 2 (Webhook / REST Push)",
    defaultPort: 443,
    hint: "Suprema BioEntry / FaceStation terminals pushing JSON events to /api/biometrics/push.",
  },
  {
    value: "Webhook",
    label: "Generic HTTP / JSON / CSV Terminal",
    defaultPort: 80,
    hint: "Any custom biometric reader, RFID controller, or script posting JSON, key=value, or CSV.",
  },
];

const DIRECTION_MODE_OPTIONS: ReadonlyArray<{
  value: TerminalDirectionMode;
  label: string;
  badge: string;
}> = [
  {
    value: "Auto",
    label: "Auto-Alternate (IN ↔ OUT per employee's daily sequence)",
    badge: "Auto IN/OUT",
  },
  {
    value: "Device",
    label: "Honor Device Key (Check-In / Check-Out button on terminal)",
    badge: "Device Key",
  },
  {
    value: "IN_Only",
    label: "Entrance Reader Only (Force all scans = IN)",
    badge: "IN Only",
  },
  {
    value: "OUT_Only",
    label: "Exit Reader Only (Force all scans = OUT)",
    badge: "OUT Only",
  },
];

const TIMEZONE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Africa/Harare", label: "Africa/Harare (CAT · UTC+02:00 — Zimbabwe / SA / Zambia)" },
  { value: "Africa/Johannesburg", label: "Africa/Johannesburg (SAST · UTC+02:00)" },
  { value: "Africa/Lusaka", label: "Africa/Lusaka (CAT · UTC+02:00)" },
  { value: "Africa/Nairobi", label: "Africa/Nairobi (EAT · UTC+03:00)" },
  { value: "Africa/Lagos", label: "Africa/Lagos (WAT · UTC+01:00)" },
  { value: "UTC", label: "UTC (UTC+00:00)" },
];

/* ------------------------------------------------------------------ */
/* Modal shell — shared glassmorphism panel                            */
/* ------------------------------------------------------------------ */

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
  width = "max-w-2xl",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="fixed inset-0 cursor-default bg-black/60 backdrop-blur-md"
      />
      <div className="relative flex min-h-full items-center justify-center py-6">
        <div
          className={`glass rise relative w-full ${width} overflow-hidden`}
        >
          <div className="accent-line" aria-hidden="true" />
          <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
            <div>
              <h3 className="text-sm font-bold tracking-[0.18em] text-ink uppercase">{title}</h3>
              {subtitle ? <p className="mt-1 text-xs text-muted">{subtitle}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg border border-white/10 bg-white/[0.04] p-2 text-muted transition hover:border-white/25 hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add / Edit-Move form                                                */
/* ------------------------------------------------------------------ */

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-muted/60 focus:border-neon/50 focus:bg-white/[0.06]";
const LABEL = "mb-1.5 block text-[10px] font-bold tracking-[0.18em] text-muted uppercase";

function DeviceForm({
  mode,
  device,
  branches,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  device: TerminalDto | null;
  branches: string[];
  onClose: () => void;
  onSaved: (next: TerminalDto) => void;
}) {
  const [protocol, setProtocol] = useState<TerminalProtocol>(device?.protocol ?? "ADMS");
  const [serialNumber, setSerialNumber] = useState(
    device?.serialNumber ?? (device?.mac && !device.mac.includes(":") && !device.mac.startsWith("GEO-") ? device.mac : "")
  );
  const [mac, setMac] = useState(device?.mac ?? "");
  const [ip, setIp] = useState(device?.ip ?? "");
  const [port, setPort] = useState(String(device?.port ?? 4370));
  const [commKey, setCommKey] = useState(device?.commKey ?? "");
  const [directionMode, setDirectionMode] = useState<TerminalDirectionMode>(
    device?.directionMode ?? "Auto"
  );
  const [timezone, setTimezone] = useState(device?.timezone || "Africa/Harare");
  const [name, setName] = useState(device?.location ?? "");
  const [branch, setBranch] = useState(device?.branch || branches[0] || "");
  const [status, setStatus] = useState<"Online" | "Offline">(device?.status ?? "Offline");
  const [clocking, setClocking] = useState<ClockingFieldsValue>(() =>
    emptyClockingFields(
      device?.clockingMethod ?? "Biometric",
      device?.latitude ?? null,
      device?.longitude ?? null,
      device?.geofenceRadiusMeters ?? null
    )
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isAdd = mode === "add";
  const usesTerminal = methodUsesTerminal(clocking.clockingMethod);
  const selectedProtocolMeta =
    PROTOCOL_OPTIONS.find((p) => p.value === protocol) ?? PROTOCOL_OPTIONS[0];

  function handleProtocolChange(nextProto: TerminalProtocol) {
    setProtocol(nextProto);
    const meta = PROTOCOL_OPTIONS.find((p) => p.value === nextProto);
    if (meta && (port === "4370" || port === "80" || port === "443" || port === "5010" || !port)) {
      setPort(String(meta.defaultPort));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!branch.trim()) {
      setFormError("A branch is required. Create a branch in Settings → Branches or type a branch name.");
      return;
    }
    const cleanSn = serialNumber.trim();
    const cleanMac = mac.trim() || cleanSn;
    if (usesTerminal && !cleanMac && !cleanSn) {
      setFormError("Enter either the Device Serial Number (SN) or Terminal MAC Address.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const numericPort = Number(port) || selectedProtocolMeta.defaultPort;
      const bodyPayload = {
        ...(isAdd ? {} : { id: device?.id }),
        mac: cleanMac,
        serialNumber: cleanSn || null,
        ip: ip.trim(),
        port: numericPort,
        commKey: commKey.trim(),
        protocol,
        directionMode,
        timezone,
        location: name.trim() || cleanSn || cleanMac || "Clocking Terminal",
        branch: branch.trim(),
        status,
        ...clockingPayload(clocking),
      };

      const res = await fetch("/api/terminals", {
        method: isAdd ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        id?: number;
        error?: string;
      } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);

      const payload = clockingPayload(clocking);
      onSaved({
        id: isAdd ? Number(json.id ?? 0) : Number(device?.id ?? 0),
        mac: cleanMac || device?.mac || "",
        serialNumber: cleanSn || null,
        ip: ip.trim(),
        port: numericPort,
        commKey: commKey.trim(),
        protocol,
        directionMode,
        timezone,
        location: name.trim() || cleanSn || cleanMac || device?.location || "Geofenced site",
        branch: branch.trim(),
        status,
        lastPing: status === "Online" ? Date.now() : (device?.lastPing ?? null),
        scansToday: device?.scansToday ?? 0,
        clockingMethod: payload.clockingMethod,
        latitude: payload.latitude ?? null,
        longitude: payload.longitude ?? null,
        geofenceRadiusMeters: payload.geofenceRadiusMeters ?? null,
      });
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title={isAdd ? "Configure & Connect Terminal Device" : "Edit Terminal Configuration"}
      subtitle={
        isAdd
          ? "Register a fingerprint/face hardware terminal, a geofenced site, or a hybrid station."
          : `Configuring ${device?.location ?? device?.serialNumber ?? device?.mac ?? ""}`
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4 px-5 py-5">
        <ClockingMethodFields
          value={clocking}
          onChange={(patch) => setClocking((prev) => ({ ...prev, ...patch }))}
          idPrefix="dev"
        />

        {usesTerminal ? (
          <div className="space-y-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold tracking-[0.18em] text-neon uppercase">
                Hardware Connection & Protocol Settings
              </p>
              <span className="font-mono text-[10px] text-muted">
                /iclock/cdata · /api/biometrics/push
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className={LABEL} htmlFor="dev-protocol">
                  Terminal Brand / Communication Protocol
                </label>
                <select
                  id="dev-protocol"
                  className={INPUT}
                  value={protocol}
                  onChange={(e) => handleProtocolChange(e.target.value as TerminalProtocol)}
                >
                  {PROTOCOL_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-muted">{selectedProtocolMeta.hint}</p>
              </div>

              <div>
                <label className={LABEL} htmlFor="dev-sn">
                  Device Serial Number (SN) <span className="text-neon">*</span>
                </label>
                <input
                  id="dev-sn"
                  className={`${INPUT} font-mono`}
                  value={serialNumber}
                  onChange={(e) => setSerialNumber(e.target.value)}
                  placeholder="e.g. CJSX213460192"
                  autoComplete="off"
                />
                <p className="mt-1 text-[10px] text-muted">
                  Found on the back sticker or Menu → System Info → Device Info.
                </p>
              </div>

              <div>
                <label className={LABEL} htmlFor="dev-mac">
                  Terminal MAC Address (or Secondary ID)
                </label>
                <input
                  id="dev-mac"
                  className={`${INPUT} font-mono`}
                  value={mac}
                  onChange={(e) => setMac(e.target.value)}
                  placeholder="e.g. A4:1F:72:0C:9B:31 (optional if SN set)"
                  autoComplete="off"
                />
                <p className="mt-1 text-[10px] text-muted">
                  Leave blank to use the Serial Number as the primary hardware ID.
                </p>
              </div>

              <div>
                <label className={LABEL} htmlFor="dev-ip">
                  Terminal IP Address (LAN / Static IP)
                </label>
                <input
                  id="dev-ip"
                  className={`${INPUT} font-mono`}
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                  placeholder="192.168.1.201"
                  autoComplete="off"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={LABEL} htmlFor="dev-port">
                    Port
                  </label>
                  <input
                    id="dev-port"
                    type="number"
                    min={1}
                    max={65535}
                    className={`${INPUT} font-mono`}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="4370"
                  />
                </div>
                <div>
                  <label className={LABEL} htmlFor="dev-commkey">
                    Comm Key / Password
                  </label>
                  <input
                    id="dev-commkey"
                    className={`${INPUT} font-mono`}
                    value={commKey}
                    onChange={(e) => setCommKey(e.target.value)}
                    placeholder="0 (default)"
                    autoComplete="off"
                  />
                </div>
              </div>

              <div>
                <label className={LABEL} htmlFor="dev-direction">
                  Punch Direction Mode
                </label>
                <select
                  id="dev-direction"
                  className={INPUT}
                  value={directionMode}
                  onChange={(e) => setDirectionMode(e.target.value as TerminalDirectionMode)}
                >
                  {DIRECTION_MODE_OPTIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className={LABEL} htmlFor="dev-timezone">
                  Terminal Clock Timezone
                </label>
                <select
                  id="dev-timezone"
                  className={INPUT}
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-neon/20 bg-neon/[0.04] px-3 py-2.5 text-[11px] leading-relaxed text-muted">
            Geofence-only site — no physical terminal required. Employees clock in from the
            mobile app or tablet station when inside the configured GPS radius.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={LABEL} htmlFor="dev-name">
              Device / Location Label
            </label>
            <input
              id="dev-name"
              className={INPUT}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main Gate — Biometric Reader"
              autoComplete="off"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="dev-branch">
              Assigned Branch
            </label>
            {branches.length > 0 ? (
              <select
                id="dev-branch"
                className={INPUT}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="dev-branch"
                className={INPUT}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="e.g. Belmont"
              />
            )}
          </div>

          <div>
            <label className={LABEL} htmlFor="dev-status">
              Initial State
            </label>
            <select
              id="dev-status"
              className={INPUT}
              value={status}
              onChange={(e) => setStatus(e.target.value === "Online" ? "Online" : "Offline")}
            >
              <option value="Online">Online</option>
              <option value="Offline">Offline (Wait for Push)</option>
            </select>
          </div>
        </div>

        {formError ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.07] pt-4">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            Cancel
          </button>
          <button type="submit" className="btn btn--neon" disabled={saving}>
            {saving ? <span className="spinner" aria-hidden="true" /> : null}
            {isAdd ? "Register Device" : "Save Configuration"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Setup Guide & Live Test Modal                                       */
/* ------------------------------------------------------------------ */

function SetupGuideModal({
  device,
  onClose,
  onTested,
}: {
  device: TerminalDto;
  onClose: () => void;
  onTested: () => void;
}) {
  const [origin, setOrigin] = useState("https://dubepride.vercel.app");
  const [hostOnly, setHostOnly] = useState("dubepride.vercel.app");
  const [testing, setTesting] = useState<"ping" | "punch" | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
      setHostOnly(window.location.host);
    }
  }, []);

  const sn = device.serialNumber || device.mac;
  const iclockUrl = `${origin}/iclock/cdata?SN=${encodeURIComponent(sn)}`;
  const pushUrl = `${origin}/api/biometrics/push?SN=${encodeURIComponent(sn)}&table=ATTLOG`;

  function copyText(key: string, value: string) {
    navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  }

  async function runSimulatedTest(kind: "ping" | "punch") {
    setTesting(kind);
    setTestResult(null);
    try {
      if (kind === "ping") {
        const res = await fetch(
          `/iclock/cdata?SN=${encodeURIComponent(sn)}&options=all`,
          { method: "GET", cache: "no-store" }
        );
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
        setTestResult({
          ok: true,
          msg: `Handshake OK! Terminal "${device.location}" is now marked Online. Server replied with ADMS options.`,
        });
      } else {
        // Send a realistic tab-separated ZKTeco ATTLOG frame for EMP1001
        const res = await fetch(
          `/iclock/cdata?SN=${encodeURIComponent(sn)}&table=ATTLOG`,
          {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: `EMP1001\t\t0\t1\t0\t0`,
          }
        );
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
        setTestResult({
          ok: true,
          msg: `Simulated biometric scan delivered (${text.trim()}). Check Attendance Records or Dashboard!`,
        });
      }
      onTested();
    } catch (err) {
      setTestResult({
        ok: false,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(null);
    }
  }

  return (
    <ModalShell
      title={`Hardware Setup Guide — ${device.location}`}
      subtitle={`Protocol: ${device.protocol} · Serial/MAC: ${sn} · Branch: ${device.branch || "Unassigned"}`}
      onClose={onClose}
      width="max-w-2xl"
    >
      <div className="space-y-4 px-5 py-5">
        {/* Copyable Server Endpoints */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="glass-inset rounded-xl p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold tracking-[0.16em] text-neon uppercase">
                Server Domain / Host (ADMS Keypad)
              </span>
              <button
                type="button"
                onClick={() => copyText("host", hostOnly)}
                className="rounded border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-ink hover:border-neon/40 hover:text-neon"
              >
                {copiedKey === "host" ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="mt-1.5 truncate font-mono text-xs text-ink">{hostOnly}</p>
            <p className="mt-1 text-[10px] text-muted">
              ZKTeco / eSSL terminals automatically append <code>/iclock/cdata</code>.
            </p>
          </div>

          <div className="glass-inset rounded-xl p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold tracking-[0.16em] text-neon uppercase">
                Device Serial Number (SN)
              </span>
              <button
                type="button"
                onClick={() => copyText("sn", sn)}
                className="rounded border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-ink hover:border-neon/40 hover:text-neon"
              >
                {copiedKey === "sn" ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="mt-1.5 truncate font-mono text-xs text-ink">{sn}</p>
            <p className="mt-1 text-[10px] text-muted">
              Direction: <strong>{device.directionMode}</strong> · TZ: <strong>{device.timezone}</strong>
            </p>
          </div>

          <div className="glass-inset rounded-xl p-3.5 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold tracking-[0.16em] text-muted uppercase">
                Full HTTP Push / Webhook Endpoint
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => copyText("iclock", iclockUrl)}
                  className="rounded border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-ink hover:border-neon/40 hover:text-neon"
                >
                  {copiedKey === "iclock" ? "Copied!" : "Copy /iclock URL"}
                </button>
                <button
                  type="button"
                  onClick={() => copyText("push", pushUrl)}
                  className="rounded border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-ink hover:border-neon/40 hover:text-neon"
                >
                  {copiedKey === "push" ? "Copied!" : "Copy /api/biometrics/push"}
                </button>
              </div>
            </div>
            <p className="mt-1.5 break-all font-mono text-xs text-ink">{pushUrl}</p>
          </div>
        </div>

        {/* Step-by-step instructions tailored to the device protocol */}
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
          <h4 className="text-xs font-bold tracking-[0.16em] text-ink uppercase">
            On-Device Keypad / Web Setup ({device.protocol})
          </h4>
          {device.protocol === "ADMS" ? (
            <ol className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-muted">
              <li>
                <strong className="text-ink">1. Open Comm Menu:</strong> On the terminal keypad, press{" "}
                <code className="text-neon">M/OK</code> → <strong>Comm.</strong> →{" "}
                <strong>Cloud Server Setting (or ADMS)</strong>.
              </li>
              <li>
                <strong className="text-ink">2. Enable Domain Name:</strong> Turn{" "}
                <strong>Enable Domain Name = ON</strong> (if connecting to{" "}
                <code className="text-ink">{hostOnly}</code>) or enter the local bridge IP.
              </li>
              <li>
                <strong className="text-ink">3. Server Address & Port:</strong> Enter{" "}
                <code className="text-neon">{hostOnly}</code> (or{" "}
                <code className="text-neon">{origin}</code>). If on LAN HTTP, set Port to{" "}
                <code>80</code> or <code>3000</code>; if HTTPS is supported on firmware, enable HTTPS.
              </li>
              <li>
                <strong className="text-ink">4. Employee IDs:</strong> Enrol staff on the terminal using the numeric part of their Employee ID (e.g.{" "}
                <code className="text-neon">1001</code> for <code>EMP1001</code>) — BIOBRIDGE automatically matches both <code>1001</code> and <code>EMP1001</code>.
              </li>
            </ol>
          ) : device.protocol === "Hikvision" ? (
            <ol className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-muted">
              <li>
                <strong className="text-ink">1. Open Web UI:</strong> Browse to{" "}
                <code className="text-neon">http://{device.ip || "<device-ip>"}</code> and sign in.
              </li>
              <li>
                <strong className="text-ink">2. HTTP Listening:</strong> Go to{" "}
                <strong>Configuration → Network → Advanced Settings → HTTP Listening</strong>.
              </li>
              <li>
                <strong className="text-ink">3. Destination:</strong> Set Server IP/Domain to{" "}
                <code className="text-neon">{hostOnly}</code> and URL to{" "}
                <code className="text-neon">/api/biometrics/push?SN={sn}</code>.
              </li>
            </ol>
          ) : (
            <ol className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-muted">
              <li>
                <strong className="text-ink">1. Webhook URL:</strong> Configure your terminal or middleware to{" "}
                <code>POST</code> attendance events to{" "}
                <code className="text-neon">{pushUrl}</code>.
              </li>
              <li>
                <strong className="text-ink">2. Accepted Formats:</strong> JSON{" "}
                <code>{`{"employeeId":"EMP1001","timestamp":"2026-11-09 08:00:00"}`}</code>, ADMS{" "}
                <code>ID=1001&amp;Time=...</code>, or CSV <code>1001,2026-11-09 08:00:00</code>.
              </li>
            </ol>
          )}
        </div>

        {/* Live Diagnostic Test Buttons */}
        <div className="rounded-xl border border-neon/25 bg-neon/[0.04] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold tracking-[0.14em] text-ink uppercase">
                Verify Connection Now
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                Simulate an ADMS handshake or a live fingerprint scan from this terminal.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={testing !== null}
                onClick={() => runSimulatedTest("ping")}
                className="btn btn--ghost text-xs"
              >
                {testing === "ping" ? <span className="spinner" aria-hidden="true" /> : null}
                Test Handshake (Mark Online)
              </button>
              <button
                type="button"
                disabled={testing !== null}
                onClick={() => runSimulatedTest("punch")}
                className="btn btn--neon text-xs"
              >
                {testing === "punch" ? <span className="spinner" aria-hidden="true" /> : null}
                Simulate Scan (EMP1001)
              </button>
            </div>
          </div>

          {testResult ? (
            <p
              className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                testResult.ok
                  ? "border-neon/40 bg-neon/10 text-neon"
                  : "border-danger/40 bg-danger/10 text-danger"
              }`}
            >
              {testResult.msg}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end border-t border-white/[0.07] pt-3">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            Done
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Remove confirmation                                                 */
/* ------------------------------------------------------------------ */

function RemoveConfirm({
  device,
  onClose,
  onRemoved,
}: {
  device: TerminalDto;
  onClose: () => void;
  onRemoved: (id: number) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/terminals", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: device.id }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      onRemoved(device.id);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell
      title="Remove Device"
      subtitle="This deregisters the terminal from its branch."
      onClose={onClose}
      width="max-w-md"
    >
      <div className="space-y-4 px-5 py-5">
        <div className="glass-inset rounded-xl p-4">
          <p className="text-sm font-semibold text-ink">{device.location}</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {device.clockingMethod === "Geofence"
              ? `${device.clockingMethod} · ${device.latitude ?? "—"}, ${device.longitude ?? "—"} @ ${device.geofenceRadiusMeters ?? "—"} m`
              : `${device.protocol} · SN: ${device.serialNumber || device.mac} · IP: ${device.ip || "—"}`}
          </p>
          <p className="mt-1 text-xs text-muted">{device.branch || "Unassigned"}</p>
        </div>

        <p className="text-xs leading-relaxed text-muted">
          Removing the device only affects this bridge — punches already captured stay in the
          attendance history and the ERP buffer.
        </p>

        {formError ? (
          <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.07] pt-4">
          <button type="button" onClick={onClose} className="btn btn--ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            className="btn"
            disabled={saving}
            style={{ background: "#ff5252", color: "#1b0505" }}
          >
            {saving ? <span className="spinner" aria-hidden="true" /> : null}
            Remove Device
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function ClockingDevices() {
  const { data, loading, error, refresh } = usePoll<TerminalsResponse>("/api/terminals", 3000);

  const [override, setOverride] = useState<{ terminals: TerminalDto[]; generatedAt: number } | null>(
    null
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [modal, setModal] = useState<ModalState | null>(null);
  const [pingingId, setPingingId] = useState<number | null>(null);
  const [originUrl, setOriginUrl] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOriginUrl(window.location.origin);
    }
  }, []);

  const terminals = useMemo(() => {
    if (override && (!data || data.generatedAt <= override.generatedAt)) return override.terminals;
    return data?.terminals ?? [];
  }, [data, override]);

  const branchOptions = useMemo(() => {
    const set = new Set<string>();
    for (const b of data?.branches ?? []) {
      if (b.trim()) set.add(b.trim());
    }
    for (const b of BRANCHES) set.add(b);
    for (const t of terminals) {
      if (t.branch?.trim()) set.add(t.branch.trim());
    }
    return [...set];
  }, [data?.branches, terminals]);

  const groups = useMemo(() => {
    const map = new Map<string, TerminalDto[]>();
    for (const b of branchOptions) map.set(b, []);
    for (const t of terminals) {
      const key = t.branch || "Unassigned";
      const bucket = map.get(key);
      if (bucket) bucket.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()];
  }, [branchOptions, terminals]);

  // Auto-expand the first branch that has devices, or the first branch overall
  useEffect(() => {
    if (groups.length > 0 && Object.keys(expanded).length === 0) {
      const withDevices = groups.find(([, rows]) => rows.length > 0)?.[0] ?? groups[0][0];
      if (withDevices) {
        setExpanded({ [withDevices]: true });
      }
    }
  }, [groups, expanded]);

  const online = terminals.filter((t) => t.status === "Online").length;
  const offline = terminals.length - online;
  const scans = terminals.reduce((sum, t) => sum + t.scansToday, 0);

  const applyNext = (mutate: (rows: TerminalDto[]) => TerminalDto[]) => {
    setOverride({ terminals: mutate(terminals), generatedAt: Date.now() });
    refresh();
  };

  const handleSaved = (next: TerminalDto) => {
    applyNext((rows) =>
      rows.some((r) => r.id === next.id)
        ? rows.map((r) => (r.id === next.id ? { ...r, ...next } : r))
        : [...rows, next]
    );
    if (next.branch) {
      setExpanded((prev) => ({ ...prev, [next.branch]: true }));
    }
  };

  const handleRemoved = (id: number) => {
    applyNext((rows) => rows.filter((r) => r.id !== id));
  };

  async function quickPingDevice(d: TerminalDto) {
    setPingingId(d.id);
    try {
      const sn = d.serialNumber || d.mac;
      await fetch(`/iclock/cdata?SN=${encodeURIComponent(sn)}&options=all`, {
        method: "GET",
        cache: "no-store",
      });
      applyNext((rows) =>
        rows.map((r) =>
          r.id === d.id ? { ...r, status: "Online", lastPing: Date.now() } : r
        )
      );
    } finally {
      setPingingId(null);
    }
  }

  const toggle = (branch: string) =>
    setExpanded((prev) => ({ ...prev, [branch]: !prev[branch] }));

  return (
    <div className="space-y-6">
      {/* Header ------------------------------------------------------ */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Clocking Devices</h1>
          <p className="mt-1 text-sm text-muted">
            Configure ZKTeco ADMS, eSSL, Hikvision ISAPI, Anviz, Suprema &amp; Geofence clocking terminals per branch.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="chip chip--muted">Auto-Discovery Active · 3s Poll</span>
          <button
            type="button"
            className="btn btn--neon"
            onClick={() => setModal({ mode: "add", device: null })}
          >
            + Add / Connect Device
          </button>
        </div>
      </div>

      {/* Live Gateway Banner ----------------------------------------- */}
      <div className="glass relative overflow-hidden px-5 py-4">
        <div className="accent-line" aria-hidden="true" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-[11px] font-bold tracking-[0.18em] text-neon uppercase">
              Universal Biometric Push Listener Ready
            </p>
            <p className="text-xs text-muted">
              Point any ZKTeco / eSSL (ADMS) terminal at{" "}
              <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-ink">
                {originUrl || "<bridge-host>"}/iclock/cdata
              </code>{" "}
              or HTTP Push / Hikvision / Webhook devices at{" "}
              <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-ink">
                {originUrl || "<bridge-host>"}/api/biometrics/push
              </code>
              . Terminals with a Serial Number (<code className="font-mono text-neon">SN</code>) auto-discover on first heartbeat.
            </p>
          </div>
        </div>
      </div>

      {/* Metrics ----------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          label="Devices Online"
          value={`${online}/${terminals.length}`}
          sub="reporting within heartbeat window"
          icon={<IconServer />}
          tone={terminals.length > 0 && online === terminals.length ? "neon" : "warn"}
          loading={loading && !data}
        />
        <MetricCard
          label="Devices Offline"
          value={offline}
          sub={offline > 0 ? "awaiting push heartbeat" : "fleet fully reachable"}
          icon={<IconClock />}
          tone={offline > 0 ? "danger" : "neon"}
          loading={loading && !data}
        />
        <MetricCard
          label="Scans Today"
          value={scans}
          sub="captured across all branches"
          icon={<IconScan />}
          tone="neon"
          loading={loading && !data}
        />
      </div>

      {error && !data ? (
        <p className="rise rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          Device registry unavailable — {error}. Retrying…
        </p>
      ) : null}

      {/* Branch accordion -------------------------------------------- */}
      <section className="glass relative overflow-hidden">
        <div className="accent-line" aria-hidden="true" />
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-xs font-bold tracking-[0.24em] text-ink uppercase">
            Devices by Branch
          </h2>
          <span className="font-mono text-[11px] tracking-wider text-muted">
            {groups.length} BRANCHES · {terminals.length} DEVICES
          </span>
        </header>

        <div className="divide-y divide-white/[0.05]">
          {groups.map(([branch, rows]) => {
            const open = !!expanded[branch];
            const branchOnline = rows.filter((r) => r.status === "Online").length;
            const summary =
              rows.length === 0
                ? "No devices registered"
                : `${rows.length} Device${rows.length === 1 ? "" : "s"} · ${branchOnline} Online`;

            return (
              <div key={branch}>
                {/* Branch row ------------------------------------------- */}
                <button
                  type="button"
                  onClick={() => toggle(branch)}
                  aria-expanded={open}
                  className={`flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03] ${
                    open ? "bg-white/[0.02]" : ""
                  }`}
                >
                  <span
                    className={`grid h-6 w-6 flex-none place-items-center rounded-md border border-white/10 bg-white/[0.04] text-[10px] text-muted transition-transform duration-200 ${
                      open ? "rotate-90 border-neon/40 text-neon" : ""
                    }`}
                    aria-hidden="true"
                  >
                    ▸
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{branch}</span>
                    <span className="block truncate text-[11px] text-muted">{summary}</span>
                  </span>

                  <span className="hidden items-center gap-2 sm:flex">
                    <span
                      className={`status-dot ${
                        rows.length > 0 && branchOnline === rows.length
                          ? "status-dot--on"
                          : branchOnline > 0
                            ? "status-dot--warn"
                            : "status-dot--off"
                      }`}
                    />
                    <span className="font-mono text-[11px] text-muted">
                      {branchOnline}/{rows.length}
                    </span>
                  </span>
                </button>

                {/* Device table ---------------------------------------- */}
                {open ? (
                  <div className="border-t border-white/[0.05] bg-black/25">
                    {rows.length === 0 ? (
                      <p className="px-5 py-6 text-center text-xs text-muted">
                        This branch has no clocking device yet — use{" "}
                        <span className="text-neon">+ Add / Connect Device</span> to register one.
                      </p>
                    ) : (
                      <div className="scroll-thin overflow-x-auto">
                        <table className="w-full min-w-[980px] border-collapse">
                          <thead className="tbl-head">
                            <tr>
                              <th>Status</th>
                              <th>Method</th>
                              <th>Device Name</th>
                              <th>Protocol &amp; Mode</th>
                              <th>Serial (SN) / MAC</th>
                              <th>IP : Port</th>
                              <th>Last Ping</th>
                              <th className="text-right">Scans</th>
                              <th className="text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((d) => {
                              const isOn = d.status === "Online";
                              const geoOnly = d.clockingMethod === "Geofence";
                              const dirBadge =
                                DIRECTION_MODE_OPTIONS.find((o) => o.value === d.directionMode)
                                  ?.badge ?? d.directionMode;
                              return (
                                <tr key={d.id} className="tbl-row transition-colors">
                                  <td>
                                    <span
                                      className={`chip ${isOn ? "chip--neon" : "chip--danger"}`}
                                    >
                                      <span
                                        className={`status-dot ${
                                          isOn ? "status-dot--on" : "status-dot--off"
                                        }`}
                                      />
                                      {d.status}
                                    </span>
                                  </td>
                                  <td>
                                    <ClockingMethodBadge
                                      method={d.clockingMethod}
                                      radiusMeters={d.geofenceRadiusMeters}
                                    />
                                  </td>
                                  <td className="font-semibold text-ink">{d.location}</td>
                                  <td>
                                    {geoOnly ? (
                                      <span className="text-xs text-muted">GPS Virtual</span>
                                    ) : (
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="rounded-md border border-neon/30 bg-neon/[0.08] px-2 py-0.5 font-mono text-[10px] font-semibold text-neon">
                                          {d.protocol || "ADMS"}
                                        </span>
                                        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-muted">
                                          {dirBadge}
                                        </span>
                                      </div>
                                    )}
                                  </td>
                                  <td className="font-mono text-xs text-muted">
                                    {geoOnly ? (
                                      "—"
                                    ) : (
                                      <div>
                                        <span className="text-ink">
                                          {d.serialNumber || d.mac || "—"}
                                        </span>
                                        {d.serialNumber && d.mac && d.serialNumber !== d.mac ? (
                                          <span className="block text-[10px] text-muted/75">
                                            MAC: {d.mac}
                                          </span>
                                        ) : null}
                                      </div>
                                    )}
                                  </td>
                                  <td className="font-mono text-xs text-muted">
                                    {geoOnly
                                      ? "—"
                                      : d.ip
                                        ? `${d.ip}:${d.port || 4370}`
                                        : `Push :${d.port || 4370}`}
                                  </td>
                                  <td className="font-mono text-xs text-muted">
                                    {isOn ? formatRelative(d.lastPing) : "— offline —"}
                                  </td>
                                  <td className="text-right font-mono text-ink tabular-nums">
                                    {d.scansToday}
                                  </td>
                                  <td>
                                    <div className="flex items-center justify-end gap-1.5">
                                      {!geoOnly ? (
                                        <>
                                          <button
                                            type="button"
                                            disabled={pingingId === d.id}
                                            className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-muted transition hover:border-neon/40 hover:text-neon"
                                            onClick={() => quickPingDevice(d)}
                                            title="Send simulated heartbeat to mark Online"
                                          >
                                            {pingingId === d.id ? "Pinging…" : "Test Ping"}
                                          </button>
                                          <button
                                            type="button"
                                            className="rounded-lg border border-neon/30 bg-neon/[0.06] px-2.5 py-1 text-[11px] font-semibold text-neon transition hover:border-neon/60 hover:bg-neon/15"
                                            onClick={() => setModal({ mode: "setup", device: d })}
                                          >
                                            Setup Guide
                                          </button>
                                        </>
                                      ) : null}
                                      <button
                                        type="button"
                                        className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-muted transition hover:border-neon/40 hover:text-neon"
                                        onClick={() => setModal({ mode: "edit", device: d })}
                                      >
                                        Edit
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-muted transition hover:border-danger/50 hover:text-danger"
                                        onClick={() => setModal({ mode: "remove", device: d })}
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* Modals ------------------------------------------------------ */}
      {modal?.mode === "add" || modal?.mode === "edit" ? (
        <DeviceForm
          key={`${modal.mode}-${modal.device?.id ?? "new"}`}
          mode={modal.mode}
          device={modal.device}
          branches={branchOptions}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      ) : null}

      {modal?.mode === "setup" && modal.device ? (
        <SetupGuideModal
          key={`setup-${modal.device.id}`}
          device={modal.device}
          onClose={() => setModal(null)}
          onTested={() => refresh()}
        />
      ) : null}

      {modal?.mode === "remove" && modal.device ? (
        <RemoveConfirm
          key={`remove-${modal.device.id}`}
          device={modal.device}
          onClose={() => setModal(null)}
          onRemoved={handleRemoved}
        />
      ) : null}
    </div>
  );
}
