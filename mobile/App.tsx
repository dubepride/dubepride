/**
 * ============================================================================
 *  App.tsx — Mine Eazy Mobile Shell
 * ============================================================================
 *
 *  Cold start plays a short branded opening — the mark settles in, geofence
 *  rings pulse out of it, then the wordmark and progress rail fade up — while
 *  the saved session is read from the keychain. The intro lingers until the
 *  auth state has resolved (bounded, so a bad keychain read cannot trap the
 *  user), then fades into the login screen or the dashboard.
 */

import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AuthProvider, useAuth } from "@/lib/session";
import { Dashboard } from "@/screens/Dashboard";
import { Login } from "@/screens/Login";
import { COLORS, SPACING, TEXT } from "@/theme";

import LOGO from "./assets/icon.png";

/** Long enough for the opening to read, short enough not to annoy. */
const INTRO_MIN_MS = 1_700;
/** Hard ceiling: reveal the app even if the keychain read never settles. */
const INTRO_MAX_MS = 4_200;
const INTRO_FADE_MS = 420;

/* -------------------------------------------------------------------------- */
/* Opening animation                                                          */
/* -------------------------------------------------------------------------- */

function ringStyle(value: Animated.Value) {
  return {
    opacity: value.interpolate({
      inputRange: [0, 0.1, 0.65, 1],
      outputRange: [0, 0.5, 0.18, 0],
    }),
    transform: [
      {
        scale: value.interpolate({
          inputRange: [0, 1],
          outputRange: [0.45, 1.55],
        }),
      },
    ],
  };
}

function Intro({ fade }: { fade: Animated.Value }): React.ReactElement {
  const enter = useRef(new Animated.Value(0)).current;
  const copy = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;
  const ringA = useRef(new Animated.Value(0)).current;
  const ringB = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.parallel([
      // The mark springs in…
      Animated.spring(enter, {
        toValue: 1,
        friction: 7,
        tension: 55,
        useNativeDriver: true,
      }),
      // …then the wordmark follows.
      Animated.timing(copy, {
        toValue: 1,
        delay: 260,
        duration: 620,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      // A thin rail fills while the session is read.
      Animated.timing(progress, {
        toValue: 1,
        delay: 300,
        duration: 1_250,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      // Two geofence rings, half a cycle apart.
      Animated.loop(
        Animated.sequence([
          Animated.timing(ringA, {
            toValue: 1,
            duration: 2_400,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(ringA, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      ),
      Animated.loop(
        Animated.sequence([
          Animated.delay(1_200),
          Animated.timing(ringB, {
            toValue: 1,
            duration: 2_400,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(ringB, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      ),
    ]);

    animation.start();
    return () => animation.stop();
  }, [copy, enter, progress, ringA, ringB]);

  const logoStyle = {
    opacity: enter.interpolate({
      inputRange: [0, 0.45, 1],
      outputRange: [0, 0.85, 1],
    }),
    transform: [
      {
        scale: enter.interpolate({
          inputRange: [0, 1],
          outputRange: [0.72, 1],
        }),
      },
      {
        translateY: enter.interpolate({
          inputRange: [0, 1],
          outputRange: [18, 0],
        }),
      },
    ],
  };

  const copyStyle = {
    opacity: copy,
    transform: [
      {
        translateY: copy.interpolate({
          inputRange: [0, 1],
          outputRange: [14, 0],
        }),
      },
    ],
  };

  const progressStyle = {
    transform: [
      {
        translateX: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [-70, 0],
        }),
      },
      { scaleX: progress },
    ],
  };

  return (
    <Animated.View
      style={[styles.intro, { opacity: fade }]}
      accessibilityLabel="Mine Eazy is opening"
      accessibilityRole="progressbar"
    >
      <View style={styles.stage}>
        <View style={styles.stageGlow} />
        <Animated.View style={[styles.ring, ringStyle(ringA)]} />
        <Animated.View style={[styles.ring, ringStyle(ringB)]} />
        <Animated.View style={[styles.logoWrap, logoStyle]}>
          <Image source={LOGO} style={styles.logo} resizeMode="cover" />
        </Animated.View>
      </View>

      <Animated.View style={[styles.brandBlock, copyStyle]}>
        <Text style={styles.brand}>BIOBRIDGE</Text>
        <Text style={styles.tagline}>MINE EAZY · TIME &amp; ATTENDANCE</Text>
      </Animated.View>

      <View style={styles.progressTrack}>
        <Animated.View style={[styles.progressFill, progressStyle]} />
      </View>
    </Animated.View>
  );
}

/* -------------------------------------------------------------------------- */
/* Fallback while a slow session restore finishes after the intro             */
/* -------------------------------------------------------------------------- */

function Restoring(): React.ReactElement {
  return (
    <View style={styles.splash}>
      <Image source={LOGO} style={styles.splashLogo} resizeMode="cover" />
      <Text style={styles.brandMark}>BIOBRIDGE</Text>
      <ActivityIndicator color={COLORS.neon} style={styles.spinner} />
      <Text style={styles.splashText}>Restoring your session…</Text>
    </View>
  );
}

function Screens(): React.ReactElement {
  const { status } = useAuth();
  const [introVisible, setIntroVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const [minElapsed, setMinElapsed] = useState(false);
  const [maxElapsed, setMaxElapsed] = useState(false);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const min = setTimeout(() => setMinElapsed(true), INTRO_MIN_MS);
    const max = setTimeout(() => setMaxElapsed(true), INTRO_MAX_MS);
    return () => {
      clearTimeout(min);
      clearTimeout(max);
    };
  }, []);

  const authSettled = status !== "restoring";

  useEffect(() => {
    if (!introVisible || leaving) return;
    if (!minElapsed) return;
    if (!authSettled && !maxElapsed) return;
    setLeaving(true);
  }, [authSettled, introVisible, leaving, maxElapsed, minElapsed]);

  useEffect(() => {
    if (!leaving) return;
    const animation = Animated.timing(fade, {
      toValue: 0,
      duration: INTRO_FADE_MS,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setIntroVisible(false);
    });
    return () => animation.stop();
  }, [fade, leaving]);

  return (
    <View style={styles.root}>
      {status === "signed-in" ? (
        <Dashboard />
      ) : status === "signed-out" ? (
        <Login />
      ) : (
        <Restoring />
      )}
      {introVisible ? <Intro fade={fade} /> : null}
    </View>
  );
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
  root: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  /* Opening ---------------------------------------------------------------- */
  intro: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.background,
  },
  stage: {
    width: 280,
    height: 280,
    alignItems: "center",
    justifyContent: "center",
  },
  stageGlow: {
    position: "absolute",
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: "rgba(0, 230, 118, 0.10)",
  },
  ring: {
    position: "absolute",
    width: 210,
    height: 210,
    borderRadius: 105,
    borderWidth: 1,
    borderColor: COLORS.neon,
  },
  logoWrap: {
    width: 124,
    height: 124,
    borderRadius: 30,
    shadowColor: COLORS.neon,
    shadowOpacity: 0.5,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  logo: {
    width: 124,
    height: 124,
    borderRadius: 30,
  },
  brandBlock: {
    alignItems: "center",
    marginTop: SPACING.xl,
  },
  brand: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 7,
    color: COLORS.white,
    textAlign: "center",
  },
  tagline: {
    marginTop: SPACING.sm,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 2.4,
    color: COLORS.textFaint,
    textAlign: "center",
  },
  progressTrack: {
    width: 140,
    height: 3,
    marginTop: SPACING.xxl,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  progressFill: {
    width: 140,
    height: 3,
    borderRadius: 2,
    backgroundColor: COLORS.neon,
    shadowColor: COLORS.neon,
    shadowOpacity: 0.8,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },

  /* Slow-restore fallback --------------------------------------------------- */
  splash: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.background,
    padding: SPACING.xl,
  },
  splashLogo: {
    width: 84,
    height: 84,
    borderRadius: 20,
    marginBottom: SPACING.lg,
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
