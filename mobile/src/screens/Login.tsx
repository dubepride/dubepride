/**
 * ============================================================================
 *  Login.tsx — Employee ID + PIN
 * ============================================================================
 *
 *  Dark purple panel on a pitch-black page, neon "Authenticate" button.
 *
 *  The credentials are verified by the bridge (`POST /api/mobile/login`), not
 *  by the phone: the endpoint returns both the confirmed identity and the
 *  branch geofence the employee's punches will be judged against, so the app
 *  never has to guess where "work" is.
 *
 *  The server address is tucked behind a disclosure rather than shown by
 *  default — it is set once per deployment, and on a physical phone it is the
 *  only thing standing between a fresh build and a working demo, so it must
 *  be changeable without a rebuild.
 */

import React, { useState } from "react";
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
  const { signIn, initialApiUrl } = useAuth();

  const [employeeId, setEmployeeId] = useState("");
  const [pin, setPin] = useState("");
  const [apiUrl, setApiUrl] = useState(initialApiUrl);
  const [showServer, setShowServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setError(null);

    if (!employeeId.trim()) {
      setError("Enter your Employee ID.");
      return;
    }
    if (!pin.trim()) {
      setError("Enter your PIN.");
      return;
    }

    setBusy(true);
    const outcome = await signIn({
      employeeId: employeeId.trim(),
      pin: pin.trim(),
      apiUrl,
    });
    setBusy(false);

    // On success this screen unmounts (the shell switches to the Dashboard), so
    // only failures need rendering here.
    if (!outcome.ok) setError(outcome.error);
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
          <Text style={styles.brandSub}>Hands-Free Mobile Clocking</Text>
        </View>

        <Panel title="Sign in" subtitle="Use the Employee ID and PIN issued by your administrator.">
          <Text style={styles.label}>Employee ID</Text>
          <TextInput
            value={employeeId}
            onChangeText={setEmployeeId}
            placeholder="ERP-1001"
            placeholderTextColor={COLORS.textFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="next"
            editable={!busy}
            style={styles.input}
          />

          <Text style={styles.label}>PIN</Text>
          <TextInput
            value={pin}
            onChangeText={setPin}
            placeholder="••••"
            placeholderTextColor={COLORS.textFaint}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={12}
            returnKeyType="go"
            editable={!busy}
            onSubmitEditing={() => void submit()}
            style={styles.input}
          />

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <PrimaryButton
            label="AUTHENTICATE"
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
                On the Android emulator the default 10.0.2.2:3000 reaches your
                machine. On a real phone use your machine&apos;s LAN address.
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
    letterSpacing: 5,
    color: COLORS.neon,
  },
  brandSub: {
    ...TEXT.caption,
    marginTop: SPACING.xs,
    letterSpacing: 1.4,
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
  errorText: {
    fontSize: FONT.small,
    color: COLORS.danger,
    lineHeight: 19,
  },
});
