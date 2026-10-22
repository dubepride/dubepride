/**
 * ============================================================================
 *  DeviceGlyph.tsx — one recognisable illustration per equipment type
 * ============================================================================
 *
 *  A router must not look like a printer, and a switch must not look like a
 *  computer. Every glyph in this file is drawn on the same 64 x 48 grid, with
 *  the same 2px stroke, the same dark body fill and a single status LED, so
 *  the family reads as one set rather than fifteen clip-art files.
 *
 *  The equipment outline is deliberately NEUTRAL (a lavender-grey stroke). The
 *  health of the device is carried by the LED and by the node's border, never
 *  by repainting the whole icon: an operator should recognise the equipment
 *  first and read its state second.
 *
 *  No icon package, no sprite sheet, no network fetch — the console has to work
 *  on a local island with the internet down.
 * ============================================================================
 */

"use client";

import type { DeviceCategory, HealthState } from "@/lib/types";

/** The colour every state badge, dot, border and minimap pixel uses. */
export const STATE_COLOUR: Record<HealthState, string> = {
  ONLINE: "#00e676",
  OFFLINE: "#ff5252",
  LINK_DOWN: "#ff5252",
  NO_INTERNET: "#9b6dff",
  DEGRADED: "#ffc400",
  STALE: "#ffc400",
  NO_TRAFFIC: "#ffc400",
  UNKNOWN: "#a0aec0",
  UNMONITORED: "#7b8794",
};

/** The colour for a state string, defaulting to grey rather than guessing. */
export function stateColour(state: string | null | undefined): string {
  if (!state) return STATE_COLOUR.UNKNOWN;
  return STATE_COLOUR[state as HealthState] ?? STATE_COLOUR.UNKNOWN;
}

/** The body of every device: near-black purple, so the outline reads on it. */
const BODY = "rgba(24, 16, 42, 0.95)";
/** A slightly lighter inset (screens, paper trays, drive bays). */
const INSET = "rgba(42, 30, 70, 0.95)";

/** The shared SVG shell: identical stroke geometry for every device. */
function Frame({
  size,
  className,
  label,
  children,
}: {
  size: number;
  className?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={Math.round((size * 48) / 64)}
      viewBox="0 0 64 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label={label}
    >
      {children}
    </svg>
  );
}

/** A status LED: a solid dot with a soft halo, never a plain fill. */
function Led({ cx, cy, colour, r = 1.9 }: { cx: number; cy: number; colour: string; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r * 2.4} fill={colour} opacity={0.18} stroke="none" />
      <circle cx={cx} cy={cy} r={r} fill={colour} stroke="none" />
    </g>
  );
}

/** A row of small port LEDs on a switch or router front panel. */
function PortLed({ x, y, dim = false }: { x: number; y: number; dim?: boolean }) {
  return (
    <rect
      x={x}
      y={y}
      width={4.6}
      height={3.6}
      rx={0.8}
      fill="currentColor"
      opacity={dim ? 0.28 : 0.7}
      stroke="none"
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The fifteen equipment illustrations                                        */
/* -------------------------------------------------------------------------- */

function InternetGlyph({ led }: { led: string }) {
  // A Starlink-style dish: a tilted panel on a mast with a wide base.
  return (
    <>
      <path d="M13 27 41 11l12 8-28 16z" fill={BODY} />
      <path d="M20 25.5 39 15" opacity={0.45} />
      <path d="M33 34.5V41" />
      <path d="M20 41h24" />
      <Led cx={47} cy={33} colour={led} />
    </>
  );
}

function RouterGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={9} y={26} width={46} height={14} rx={2.5} fill={BODY} />
      <path d="M16 26V13" />
      <path d="M48 26V13" />
      <circle cx={16} cy={12} r={1.5} fill="currentColor" stroke="none" />
      <circle cx={48} cy={12} r={1.5} fill="currentColor" stroke="none" />
      <PortLed x={15} y={31} />
      <PortLed x={22} y={31} />
      <PortLed x={29} y={31} dim />
      <PortLed x={36} y={31} dim />
      <Led cx={49} cy={33} colour={led} r={1.7} />
    </>
  );
}

function GatewayGlyph({ led }: { led: string }) {
  // A gateway is a router that faces the outside: the globe is the tell.
  return (
    <>
      <circle cx={32} cy={13} r={7.5} fill={BODY} />
      <path d="M24.5 13h15" opacity={0.5} />
      <path d="M32 5.5v15" opacity={0.5} />
      <rect x={8} y={25} width={48} height={15} rx={2.5} fill={BODY} />
      <path d="M14 32.5h6m-2.6-2.6 2.6 2.6-2.6 2.6" />
      <Led cx={49} cy={32.5} colour={led} r={1.7} />
    </>
  );
}

function SwitchGlyph({ led }: { led: string }) {
  // Front panel with two rows of Ethernet ports and individually lit LEDs.
  const ports = [10, 17.2, 24.4, 31.6, 38.8, 46];
  return (
    <>
      <rect x={4} y={15} width={56} height={19} rx={2.5} fill={BODY} />
      {ports.map((x, i) => (
        <PortLed key={`a${i}`} x={x} y={20} dim={i > 3} />
      ))}
      {ports.map((x, i) => (
        <PortLed key={`b${i}`} x={x} y={26.4} dim={i > 2} />
      ))}
      <Led cx={55} cy={30} colour={led} r={1.5} />
    </>
  );
}

function DesktopGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={11} y={7} width={42} height={26} rx={2.5} fill={BODY} />
      <rect x={15.5} y={11} width={33} height={17.5} rx={1.2} fill={INSET} stroke="none" />
      <path d="M32 33v6" />
      <path d="M21 40h22" />
      <Led cx={47} cy={29.5} colour={led} r={1.6} />
    </>
  );
}

function LaptopGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={15} y={9} width={34} height={21} rx={2} fill={BODY} />
      <rect x={19} y={12.5} width={26} height={13} rx={1} fill={INSET} stroke="none" />
      <path d="M11 30h42l4 7H7z" fill={BODY} />
      <path d="M27 33.5h10" opacity={0.6} />
      <Led cx={45} cy={26} colour={led} r={1.5} />
    </>
  );
}

function PrinterGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={20} y={5} width={24} height={11} rx={1} fill={INSET} />
      <rect x={12} y={16} width={40} height={18} rx={2.5} fill={BODY} />
      <rect x={21} y={34} width={22} height={8} rx={1} fill={INSET} />
      <path d="M24 23h16" opacity={0.6} />
      <Led cx={46} cy={29} colour={led} r={1.6} />
    </>
  );
}

function ServerGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={19} y={4} width={28} height={40} rx={2.5} fill={BODY} />
      <path d="M19 17h28" opacity={0.5} />
      <path d="M19 30h28" opacity={0.5} />
      <path d="M25 10.5h9" opacity={0.6} />
      <path d="M25 23.5h9" opacity={0.6} />
      <path d="M25 36.5h9" opacity={0.6} />
      <Led cx={41} cy={10.5} colour={led} r={1.4} />
      <circle cx={41} cy={23.5} r={1.4} fill="currentColor" opacity={0.35} stroke="none" />
      <circle cx={41} cy={36.5} r={1.4} fill="currentColor" opacity={0.35} stroke="none" />
    </>
  );
}

function NvrGlyph({ led }: { led: string }) {
  // A recorder: a box with a big front bezel and a record LED.
  return (
    <>
      <rect x={9} y={10} width={46} height={28} rx={3} fill={BODY} />
      <circle cx={24} cy={24} r={8.5} />
      <circle cx={24} cy={24} r={3.8} fill="currentColor" opacity={0.3} stroke="none" />
      <path d="M36 18.5h10" opacity={0.6} />
      <path d="M36 24h10" opacity={0.6} />
      <path d="M36 29.5h6" opacity={0.6} />
      <Led cx={48} cy={32} colour={led} r={1.6} />
    </>
  );
}

function CameraGlyph({ led }: { led: string }) {
  return (
    <>
      <path d="M12 20h26l12 6-12 6H12z" fill={BODY} />
      <circle cx={19.5} cy={26} r={5.5} />
      <circle cx={19.5} cy={26} r={2.2} fill="currentColor" opacity={0.45} stroke="none" />
      <path d="M38 20v-8h9" />
      <Led cx={45} cy={34} colour={led} r={1.5} />
    </>
  );
}

function AccessPointGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={22} y={29} width={20} height={8} rx={2.5} fill={BODY} />
      <path d="M25.5 21a8.5 8.5 0 0 1 13 0" />
      <path d="M29 25.3a4.2 4.2 0 0 1 6 0" />
      <Led cx={32} cy={33} colour={led} r={1.6} />
      <path d="M16 41h32" opacity={0.35} />
    </>
  );
}

function NasGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={17} y={7} width={30} height={15} rx={2} fill={BODY} />
      <rect x={17} y={26} width={30} height={15} rx={2} fill={BODY} />
      <path d="M29 14.5h12" opacity={0.55} />
      <path d="M29 33.5h12" opacity={0.55} />
      <Led cx={23} cy={14.5} colour={led} r={1.5} />
      <circle cx={23} cy={33.5} r={1.5} fill="currentColor" opacity={0.35} stroke="none" />
    </>
  );
}

function VoipGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={11} y={21} width={36} height={16} rx={2.5} fill={BODY} />
      <rect x={9} y={7} width={9} height={13} rx={2.5} fill={INSET} />
      <path d="M18 13.5h4" opacity={0.6} />
      <path d="M17 26.5h.01M23 26.5h.01M29 26.5h.01M17 31.5h.01M23 31.5h.01M29 31.5h.01" />
      <Led cx={41} cy={34} colour={led} r={1.5} />
    </>
  );
}

function IndustrialGlyph({ led }: { led: string }) {
  return (
    <>
      <rect x={15} y={12} width={34} height={22} rx={2} fill={BODY} />
      <path d="M9 40h46" />
      <path d="M9 40v-4M55 40v-4" />
      <circle cx={21} cy={18} r={1.5} fill="currentColor" opacity={0.45} stroke="none" />
      <circle cx={27} cy={18} r={1.5} fill="currentColor" opacity={0.45} stroke="none" />
      <circle cx={37} cy={18} r={1.5} fill="currentColor" opacity={0.45} stroke="none" />
      <circle cx={43} cy={18} r={1.5} fill="currentColor" opacity={0.45} stroke="none" />
      <path d="M21 27h14" opacity={0.5} />
      <Led cx={43} cy={28} colour={led} r={1.5} />
    </>
  );
}

function UnknownGlyph({ led }: { led: string }) {
  return (
    <>
      <rect
        x={18}
        y={12}
        width={28}
        height={24}
        rx={3}
        fill={BODY}
        strokeDasharray="4 3"
      />
      <text
        x={32}
        y={29}
        textAnchor="middle"
        fontSize={15}
        fontWeight={700}
        fill="currentColor"
        stroke="none"
      >
        ?
      </text>
      <Led cx={49} cy={36} colour={led} r={1.4} />
    </>
  );
}

/* -------------------------------------------------------------------------- */

const GLYPHS: Record<DeviceCategory, (props: { led: string }) => React.ReactElement> = {
  internet: InternetGlyph,
  router: RouterGlyph,
  gateway: GatewayGlyph,
  switch: SwitchGlyph,
  desktop: DesktopGlyph,
  laptop: LaptopGlyph,
  printer: PrinterGlyph,
  server: ServerGlyph,
  nvr: NvrGlyph,
  camera: CameraGlyph,
  access_point: AccessPointGlyph,
  nas: NasGlyph,
  voip_phone: VoipGlyph,
  industrial: IndustrialGlyph,
  unknown: UnknownGlyph,
};

/**
 * The equipment illustration for a category.
 *
 * `led` is the health colour; pass the device's state so the indicator on the
 * equipment matches the badge next to it. The stroke colour comes from the
 * surrounding CSS (`text-*` / `color`).
 */
export function DeviceGlyph({
  category,
  size = 40,
  led = STATE_COLOUR.ONLINE,
  className,
  title,
}: {
  category: string;
  size?: number;
  led?: string;
  className?: string;
  title?: string;
}) {
  const Glyph = GLYPHS[category as DeviceCategory] ?? GLYPHS.unknown;
  return (
    <Frame size={size} className={className} label={title ?? `${category} icon`}>
      <Glyph led={led} />
    </Frame>
  );
}

export default DeviceGlyph;
