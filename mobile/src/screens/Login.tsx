/**
 * ============================================================================
 *  Login.tsx — BioBridge Mobile Employee Number Sign-In & Device Binding
 * ============================================================================
 *
 *  Employees sign in using ONLY their Employee Number (e.g. EMP1001 or 1001).
 *  On sign-in, BioBridge Mobile sends this phone's persistent hardware device
 *  ID so the employee is bound 1-to-1 to their handset on the main system.
 *  If anyone tries to use that Employee Number on another phone, the server
 *  rejects it with a clear "Wrong Device" error.
 */

import React, { useEffect, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { PrimaryButton } from "@/components/PrimaryButton";
import { useAuth } from "@/lib/session";
import { COLORS, FONT, RADIUS, SPACING, TEXT } from "@/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import LOGO from "../../assets/icon.png";

export function Login(): React.ReactElement {
  const { signIn, initialApiUrl, deviceId, deviceName } = useAuth();
  const insets = useSafeAreaInsets();

  const [employeeNumber, setEmployeeNumber] = useState("");
  const [apiUrl, setApiUrl] = useState(initialApiUrl);
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialApiUrl) setApiUrl(initialApiUrl);
  }, [initialApiUrl]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setError(null);

    const trimmed = employeeNumber.trim();
    if (!trimmed) {
      setError("Please enter your Employee Number.");
      return;
    }

    setBusy(true);
    const outcome = await signIn({
      employeeNumber: trimmed,
      employeeId: trimmed,
      apiUrl,
    });
    setBusy(false);

    if (!outcome.ok) {
      setError(outcome.error ?? "Could not sign in with that Employee Number.");
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + SPACING.xl,
            paddingBottom: insets.bottom + SPACING.xl,
            paddingLeft: insets.left + SPACING.xl,
            paddingRight: insets.right + SPACING.xl,
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.content}>
          <View style={styles.brandBlock}>
            <View style={styles.logoWrap}>
              <Image source={LOGO} style={styles.logo} resizeMode="cover" />
            </View>
            <Text style={styles.brandMark}>BIOBRIDGE</Text>
            <Text style={styles.brandSub}>TIME &amp; ATTENDANCE</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Employee sign in</Text>
            <Text style={styles.cardSubtitle}>
              Enter your Employee Number to continue.
            </Text>

            <Text style={styles.label}>Employee Number</Text>
            <TextInput
              value={employeeNumber}
              onChangeText={setEmployeeNumber}
              placeholder="e.g. 1001"
              placeholderTextColor={COLORS.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="go"
              editable={!busy}
              onSubmitEditing={() => void submit()}
              style={styles.input}
            />

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Sign-in rejected</Text>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <PrimaryButton
              label="SIGN IN"
              variant="soft"
              onPress={() => void submit()}
              loading={busy}
              style={styles.submit}
            />

            <Pressable onPress={() => setShowServer((open) => !open)} hitSlop={8}>
              <Text style={styles.disclosure}>
                {showServer ? "Hide server address" : "Change server address"}
              </Text>
            </Pressable>

            {showServer ? (
              <View style={styles.serverBox}>
                <Text style={styles.label}>Bridge URL</Text>
                <TextInput
                  value={apiUrl}
                  onChangeText={setApiUrl}
                  placeholder="https://biobridge-attendance.vercel.app"
                  placeholderTextColor={COLORS.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!busy}
                  style={styles.input}
                />
                <Text style={styles.hint}>
                  On the Android emulator, http://10.0.2.2:3000 reaches your machine.
                  On a physical device, use your machine&apos;s LAN address or the public
                  server URL.
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.deviceRow}>
            <View style={styles.deviceDot} />
            <Text style={styles.deviceText}>
              Device locked{deviceName ? ` · ${deviceName}` : ""}
            </Text>
          </View>
          <Text style={styles.deviceId}>
            Hardware ID: {deviceId ?? "initialising…"}
          </Text>

          <Text style={styles.note}>
            Clocking stays manual. Location is shared while you are signed in.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.xxl,
  },
  content: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
  },
  brandBlock: {
    alignItems: "center",
    marginBottom: SPACING.xl,
  },
  logoWrap: {
    width: 84,
    height: 84,
    borderRadius: 22,
    marginBottom: SPACING.lg,
    backgroundColor: COLORS.panel,
    shadowColor: COLORS.neon,
    shadowOpacity: 0.35,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  logo: {
    width: 84,
    height: 84,
    borderRadius: 22,
  },
  brandMark: {
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: 6.5,
    color: COLORS.white,
    textAlign: "center",
  },
  brandSub: {
    marginTop: SPACING.sm,
    fontSize: 9,
    fontWeight: "600",
    letterSpacing: 2.6,
    color: COLORS.textFaint,
    textAlign: "center",
  },
  card: {
    backgroundColor: COLORS.panel,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACING.xl,
  },
  cardTitle: {
    ...TEXT.title,
    fontSize: 18,
  },
  cardSubtitle: {
    ...TEXT.caption,
    lineHeight: 18,
    marginTop: 6,
    marginBottom: SPACING.lg,
  },
  label: {
    ...TEXT.label,
    marginBottom: SPACING.sm,
  },
  input: {
    backgroundColor: COLORS.panelDeep,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: 14,
    fontSize: FONT.body,
    color: COLORS.white,
  },
  submit: {
    marginTop: SPACING.lg,
  },
  disclosure: {
    marginTop: SPACING.lg,
    fontSize: FONT.tiny,
    fontWeight: "600",
    color: COLORS.textMuted,
    textDecorationLine: "underline",
    textAlign: "center",
  },
  serverBox: {
    marginTop: SPACING.lg,
    paddingTop: SPACING.lg,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  hint: {
    ...TEXT.caption,
    marginTop: SPACING.sm,
    lineHeight: 17,
  },
  errorBox: {
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: "rgba(255, 92, 92, 0.45)",
    backgroundColor: COLORS.dangerSoft,
  },
  errorTitle: {
    fontSize: FONT.caption,
    fontWeight: "700",
    color: COLORS.danger,
    marginBottom: 4,
  },
  errorText: {
    fontSize: FONT.caption,
    color: COLORS.danger,
    lineHeight: 18,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: SPACING.xl,
  },
  deviceDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: COLORS.neon,
  },
  deviceText: {
    fontSize: FONT.tiny,
    color: COLORS.textFaint,
    letterSpacing: 0.2,
  },
  deviceId: {
    marginTop: 4,
    fontSize: 10,
    color: COLORS.textFaint,
    textAlign: "center",
    opacity: 0.75,
  },
  note: {
    marginTop: SPACING.xl,
    fontSize: FONT.tiny,
    lineHeight: 18,
    color: COLORS.textFaint,
    textAlign: "center",
    alignSelf: "center",
    maxWidth: 260,
  },
});
