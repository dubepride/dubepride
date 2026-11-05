/**
 * ============================================================================
 *  theme.ts — the BIOBRIDGE design tokens, shared by every screen
 * ============================================================================
 *
 *  Deliberately a hand-rolled token file (no styled-components / theme
 *  provider): the palette is fixed and small, and keeping it as plain objects
 *  means background-task code can import it without pulling in React.
 *
 *  The palette follows the opening screen: near-black canvas, quiet charcoal
 *  surfaces, soft hairlines, and a single neon-green accent. There is no
 *  purple in the product chrome — the brand is BIOBRIDGE, full stop.
 */

import type { TextStyle, ViewStyle } from "react-native";

export const COLORS = {
  /** Pitch black page background. */
  background: "#0a0a0a",
  /** Raised card surface — one step above the canvas. */
  panel: "#121218",
  /** Recessed surface (inputs, nested cards) — one step below `panel`. */
  panelDeep: "#0d0d12",
  /** Hairline border around panels and inputs. */
  border: "#2b2b38",
  /** Even quieter divider used inside cards. */
  borderSoft: "rgba(255, 255, 255, 0.06)",
  /** Neon green accent — buttons, active states, focus rings. */
  neon: "#00e676",
  /** 14% neon, for chips/pills that shouldn't shout. */
  neonSoft: "rgba(0, 230, 118, 0.14)",
  /** 45% neon, for outlined neon controls. */
  neonBorder: "rgba(0, 230, 118, 0.45)",
  white: "#f4f4f7",
  /** Secondary body copy. */
  textMuted: "#b9b3c6",
  /** Tertiary / caption copy. */
  textFaint: "#7d748f",
  /** "Locating…" idle grey. */
  idle: "#6e6781",
  danger: "#ff5c5c",
  dangerSoft: "rgba(255, 92, 92, 0.12)",
  warning: "#ffb300",
  warningSoft: "rgba(255, 179, 0, 0.12)",
  black: "#000000",
  /** Accent used by the map chrome. */
  accent: "#7c3aed",
} as const;

/** 4-point spacing scale. */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const RADIUS = {
  sm: 10,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

export const FONT = {
  tiny: 11,
  caption: 12,
  small: 13,
  body: 15,
  title: 18,
  heading: 24,
  display: 30,
} as const;

/** Neon glow used on the primary button + active chip dot. */
export const GLOW: ViewStyle = {
  shadowColor: COLORS.neon,
  shadowOpacity: 0.32,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 0 },
  elevation: 4,
};

export const TEXT = {
  /** Screen headline. */
  display: { fontSize: FONT.display, fontWeight: "700", color: COLORS.white } as TextStyle,
  heading: { fontSize: FONT.heading, fontWeight: "700", color: COLORS.white } as TextStyle,
  title: { fontSize: FONT.title, fontWeight: "600", color: COLORS.white } as TextStyle,
  body: { fontSize: FONT.body, color: COLORS.textMuted } as TextStyle,
  /** All-caps field label above an input. */
  label: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: COLORS.textFaint,
  } as TextStyle,
  caption: { fontSize: FONT.caption, color: COLORS.textFaint } as TextStyle,
} as const;
