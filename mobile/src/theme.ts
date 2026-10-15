/**
 * ============================================================================
 *  theme.ts — the BIOBRIDGE design tokens, shared by every screen
 * ============================================================================
 *
 *  Deliberately a hand-rolled token file (no styled-components / theme
 *  provider): the palette is fixed and small, and keeping it as plain objects
 *  means background-task code can import it without pulling in React.
 *
 *  The four required anchors match the Next.js dashboard exactly:
 *    background #0a0a0a  ·  panel #2d1b4e  ·  text #ffffff  ·  accent #00e676
 */

import type { TextStyle, ViewStyle } from "react-native";

export const COLORS = {
  /** Pitch black page background. */
  background: "#0a0a0a",
  /** Deep purple panel surface. */
  panel: "#2d1b4e",
  /** Recessed panel (inputs, nested cards) — one step deeper than `panel`. */
  panelDeep: "#1d1233",
  /** Hairline border around panels. */
  border: "#452f6b",
  /** Neon green accent — buttons, active states, focus rings. */
  neon: "#00e676",
  /** 18% neon, for chips/pills that shouldn't shout. */
  neonSoft: "rgba(0, 230, 118, 0.16)",
  white: "#ffffff",
  /** Secondary body copy on purple panels. */
  textMuted: "#c9bce4",
  /** Tertiary / caption copy. */
  textFaint: "#9086ad",
  /** "Searching…" idle grey. */
  idle: "#7b7b8f",
  danger: "#ff5252",
  dangerSoft: "rgba(255, 82, 82, 0.16)",
  warning: "#ffb300",
  warningSoft: "rgba(255, 179, 0, 0.16)",
  black: "#000000",
  /** Accent for labels/badges. */
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
  sm: 8,
  md: 12,
  lg: 18,
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

/** Neon glow used on the primary button + active chip dot (iOS shadow / Android elevation). */
export const GLOW: ViewStyle = {
  shadowColor: COLORS.neon,
  shadowOpacity: 0.45,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 0 },
  elevation: 6,
};

export const TEXT = {
  /** Screen headline. */
  display: { fontSize: FONT.display, fontWeight: "700", color: COLORS.white } as TextStyle,
  heading: { fontSize: FONT.heading, fontWeight: "700", color: COLORS.white } as TextStyle,
  title: { fontSize: FONT.title, fontWeight: "600", color: COLORS.white } as TextStyle,
  body: { fontSize: FONT.body, color: COLORS.textMuted } as TextStyle,
  /** All-caps field label above an input. */
  label: {
    fontSize: FONT.caption,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: COLORS.textFaint,
  } as TextStyle,
  caption: { fontSize: FONT.caption, color: COLORS.textFaint } as TextStyle,
} as const;
