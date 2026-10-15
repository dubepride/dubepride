import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

import { COLORS, FONT, RADIUS, SPACING } from "@/theme";

export interface StatusChipProps {
  /** True → neon and pulsing ("Geofence Active"). False → grey and still. */
  active: boolean;
  activeLabel?: string;
  idleLabel?: string;
}

/**
 * The dashboard's pulsing status pill.
 *
 * The pulse is on the dot only, driven by `useNativeDriver: true`, so it keeps
 * animating smoothly without touching the JS thread on every frame.
 */
export function StatusChip({
  active,
  activeLabel = "Geofence Active",
  idleLabel = "Searching...",
}: StatusChipProps): React.ReactElement {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={active ? activeLabel : idleLabel}
      style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}
    >
      <Animated.View
        style={[
          styles.dot,
          active ? styles.dotActive : styles.dotIdle,
          active && { opacity: pulse, transform: [{ scale: pulse }] },
        ]}
      />
      <Text style={[styles.label, active ? styles.labelActive : styles.labelIdle]}>
        {active ? activeLabel : idleLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm + 2,
    borderWidth: 1,
  },
  chipActive: {
    backgroundColor: COLORS.neonSoft,
    borderColor: COLORS.neon,
  },
  chipIdle: {
    backgroundColor: "rgba(123, 123, 143, 0.14)",
    borderColor: COLORS.idle,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: SPACING.sm,
  },
  dotActive: {
    backgroundColor: COLORS.neon,
  },
  dotIdle: {
    backgroundColor: COLORS.idle,
  },
  label: {
    fontSize: FONT.small,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
  labelActive: {
    color: COLORS.neon,
  },
  labelIdle: {
    color: COLORS.idle,
  },
});
