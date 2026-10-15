/**
 * ============================================================================
 *  App.tsx — the shell: one context, two screens
 * ============================================================================
 *
 *  Routing is deliberately state-based rather than a navigator. There are two
 *  destinations and the app is either authenticated or it is not, so a routing
 *  library would add a dependency, a config surface and a failure mode without
 *  buying anything. If a third screen ever appears, this is the single place
 *  that has to change.
 *
 *  The context holds exactly what the brief asks for — the authenticated
 *  employee's identity and the coordinates of their branch's target fence — and
 *  nothing else; the queue and dwell state live in storage, because the
 *  background tasks must be able to read them with no React runtime present.
 *
 *  `@/tasks/geofenceTask` is imported by index.ts, not here, so that the task
 *  definitions are registered before `registerRootComponent` runs.
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
      {/* SDK 57 forces edge-to-edge, so expo-status-bar no longer takes a
          backgroundColor: the app's own dark background shows through. */}
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
    letterSpacing: 5,
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
