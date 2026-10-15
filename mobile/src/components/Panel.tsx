import React from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { COLORS, RADIUS, SPACING, TEXT } from "@/theme";

export interface PanelProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** The deep-purple card every screen is built from. */
export function Panel({ title, subtitle, children, style }: PanelProps): React.ReactElement {
  return (
    <View style={[styles.panel, style]}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: COLORS.panel,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.lg,
    width: "100%",
  },
  title: {
    ...TEXT.title,
    marginBottom: SPACING.xs,
  },
  subtitle: {
    ...TEXT.caption,
    marginBottom: SPACING.md,
  },
});
