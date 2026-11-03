/**
 * ============================================================================
 *  Login.tsx — BioBridge Mobile Employee ID Sign-In & Hardware Device Binding
 * ============================================================================
 *
 *  Employees sign in using ONLY their Employee ID / Number (e.g. EMP1001 or 1001).
 *  Upon sign-in, BioBridge Mobile sends this phone's persistent Hardware Device ID
 *  so the employee's ID is bound 1-to-1 to their phone on the main system.
 *  If anyone tries to sign in with that Employee ID on another device, the server
 *  rejects it with a clear "Wrong Device" error.
 */

import React, { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Panel } from "@/components/Panel";
import { PrimaryButton } from "@/components/PrimaryButton";
import { useAuth } from "@/lib/session";
import { COLORS, FONT, RADIUS, SPACING, TEXT } from "@/theme";

export function Login(): React.ReactElement {
  const { signIn, initialApiUrl, deviceId, deviceName } = useAuth();

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
      setError("Please enter your Employee ID.");
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
      setError(outcome.error ?? "Could not sign in with that Employee ID.");
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <Text style={styles.brandMark}>BIOBRIDGE</Text>
          <Text style={styles.brandSub}>BioBridge Mobile · Time & Attendance</Text>
        </View>

        <Panel
          title="Employee Sign In"
          subtitle="Enter your Employee ID to sign in. Your ID is locked to this device so no one else can clock in on your behalf."
        >
          <Text style={styles.label}>Employee ID / Number</Text>
          <TextInput
            value={employeeNumber}
            onChangeText={setEmployeeNumber}
            placeholder="e.g. EMP1001 or 1001"
            placeholderTextColor={COLORS.textFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            editable={!busy}
            onSubmitEditing={() => void submit()}
            style={styles.input}
          />

          <View style={styles.deviceBindBadge}>
            <Text style={styles.deviceBindTitle}>
              🔒 DEVICE BINDING ACTIVE
            </Text>
            <Text style={styles.deviceBindMeta}>
              {deviceName ? `${deviceName} · ` : ""}ID: {deviceId ?? "Initializing…"}
            </Text>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>⚠ Sign-In Rejected</Text>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <PrimaryButton
            label="LOG IN"
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
            <>
              <Text style={styles.label}>Bridge URL</Text>
              <TextInput
                value={apiUrl}
                onChangeText={setApiUrl}
                placeholder="http://192.168.1.42:3000"
                placeholderTextColor={COLORS.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!busy}
                style={styles.input}
              />
              <Text style={styles.hint}>
                On the Android emulator, http://10.0.2.2:3000 reaches your machine.
                On a physical device, use your machine&apos;s LAN address or public server URL.
              </Text>
            </>
          ) : null}
        </Panel>
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
    padding: SPACING.xl,
  },
  brand: {
    marginBottom: SPACING.xl,
  },
  brandMark: {
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 4,
    color: COLORS.neon,
  },
  brandSub: {
    ...TEXT.caption,
    marginTop: SPACING.xs,
    letterSpacing: 1.2,
  },
  label: {
    ...TEXT.label,
    marginBottom: SPACING.sm,
    marginTop: SPACING.md,
  },
  input: {
    backgroundColor: COLORS.panelDeep,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    fontSize: FONT.body,
    color: COLORS.white,
  },
  deviceBindBadge: {
    marginTop: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelDeep,
  },
  deviceBindTitle: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: COLORS.neon,
  },
  deviceBindMeta: {
    fontSize: FONT.small,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  submit: {
    marginTop: SPACING.lg,
  },
  disclosure: {
    marginTop: SPACING.lg,
    fontSize: FONT.caption,
    fontWeight: "600",
    color: COLORS.textMuted,
    textDecorationLine: "underline",
  },
  hint: {
    ...TEXT.caption,
    marginTop: SPACING.sm,
    lineHeight: 17,
  },
  errorBox: {
    marginTop: SPACING.lg,
    padding: SPACING.md,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.danger,
    backgroundColor: COLORS.dangerSoft,
  },
  errorTitle: {
    fontSize: FONT.small,
    fontWeight: "700",
    color: COLORS.danger,
    marginBottom: 4,
  },
  errorText: {
    fontSize: FONT.small,
    color: COLORS.danger,
    lineHeight: 19,
  },
});
