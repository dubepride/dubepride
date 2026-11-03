/**
 * ============================================================================
 *  App.tsx — Mine Eazy Mobile Shell
 * ============================================================================
 */

import { StatusBar } from "expo-status-bar";
import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { AuthProvider, useAuth } from "@/lib/session";
import { Dashboard } from "@/screens/Dashboard";
import { Login } from "@/screens/Login";
import { COLORS, SPACING, TEXT } from "@/theme";

/** Shown for the few frames it takes to read the saved session from the keychain. */
function Restoring(): React.ReactElement {
  return (
    <View style={styles.splash}>
      <Text style={styles.brandMark}>BIOBRIDGE</Text>
      <ActivityIndicator color={COLORS.neon} style={styles.spinner} />
      <Text style={styles.splashText}>Restoring your session…</Text>
    </View>
  );
}

function Screens(): React.ReactElement {
  const { status } = useAuth();

  if (status === "restoring") return <Restoring />;
  return status === "signed-in" ? <Dashboard /> : <Login />;
}

export default function App(): React.ReactElement {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Screens />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.background,
    padding: SPACING.xl,
  },
  brandMark: {
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: 4,
    color: COLORS.neon,
  },
  spinner: {
    marginTop: SPACING.lg,
  },
  splashText: {
    ...TEXT.caption,
    marginTop: SPACING.md,
  },
});
