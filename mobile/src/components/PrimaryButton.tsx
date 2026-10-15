import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { COLORS, FONT, GLOW, RADIUS, SPACING } from "@/theme";

export type ButtonVariant = "neon" | "ghost" | "danger";

export interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: ButtonVariant;
  style?: StyleProp<ViewStyle>;
}

/**
 * The one button style in the app. `neon` is the call to action (Authenticate,
 * Sync Now, Clock In / Out); `ghost` is a secondary action; `danger` is sign-out.
 */
export function PrimaryButton({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant = "neon",
  style,
}: PrimaryButtonProps): React.ReactElement {
  const inert = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy: loading }}
      onPress={onPress}
      disabled={inert}
      style={({ pressed }) => [
        styles.base,
        variant === "neon" && styles.neon,
        variant === "neon" && !inert && GLOW,
        variant === "ghost" && styles.ghost,
        variant === "danger" && styles.danger,
        inert && styles.disabled,
        pressed && !inert && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === "neon" ? COLORS.background : COLORS.neon}
          size="small"
        />
      ) : (
        <Text
          style={[
            styles.label,
            variant === "neon" ? styles.labelOnNeon : styles.labelOnPanel,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  neon: {
    backgroundColor: COLORS.neon,
  },
  ghost: {
    backgroundColor: "transparent",
    borderColor: COLORS.border,
  },
  danger: {
    backgroundColor: "transparent",
    borderColor: COLORS.danger,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.85,
  },
  label: {
    fontSize: FONT.body,
    fontWeight: "700",
    letterSpacing: 1,
  },
  labelOnNeon: {
    color: COLORS.background,
  },
  labelOnPanel: {
    color: COLORS.neon,
  },
});
