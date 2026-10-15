/**
 * ============================================================================
 *  Dashboard.tsx — the one screen the employee actually lives in
 * ============================================================================
 *
 *  Four things, in order of how often they matter:
 *
 *   1. A pulsing status chip — "Geofence Active" (neon) or "Searching..." (grey).
 *   2. Which registered site you are in (or the nearest one), and what the
 *      monitor is doing.
 *   3. The site map — every fence the phone watches, plus your live position.
 *   4. Any punches the phone could not deliver, with a "Sync Now" button.
 *   5. A manual Clock In / Out button, for when the geofence cannot help
 *      (GPS indoors, a dead battery day, a site with no fence configured).
 *
 *  The manual button is a genuine fallback, not a bypass: it sends the same
 *  payload to the same endpoint, so the bridge still works out which
 *  registered site you are standing in and still rejects anything outside its
 *  radius.
 */

import * as Location from "expo-location";
import React, { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Panel } from "@/components/Panel";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SiteMap } from "@/components/SiteMap";
import { StatusChip } from "@/components/StatusChip";
import { useGeofenceStatus } from "@/hooks/useGeofenceStatus";
import { usePendingQueue } from "@/hooks/usePendingQueue";
import { sendOrQueue } from "@/lib/api";
import { formatDistance, sessionSites } from "@/lib/geo";
import { useAuth } from "@/lib/session";
import type { GeoPunchPayload } from "@/lib/types";
import { COLORS, FONT, RADIUS, SPACING, TEXT } from "@/theme";

/** "14:07" — avoids depending on Intl being compiled into the Hermes build. */
function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

async function currentFix(message: string): Promise<Location.LocationObject> {
  if (!(await Location.hasServicesEnabledAsync())) {
    throw new Error("Location Services are switched off.");
  }
  const permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== Location.PermissionStatus.GRANTED) {
    const asked = await Location.requestForegroundPermissionsAsync();
    if (asked.status !== Location.PermissionStatus.GRANTED) {
      throw new Error(message);
    }
  }
  return Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
}

export function Dashboard(): React.ReactElement {
  const { session, signOut, tracking, retryTracking } = useAuth();
  const geofence = useGeofenceStatus(session);
  const queue = usePendingQueue(session);

  const [manualBusy, setManualBusy] = useState(false);
  const [manualMessage, setManualMessage] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);

  if (!session) return <View style={styles.flex} />;

  const { employee } = session;
  const homeSite = employee.branch || "No home site";
  const sites = sessionSites(session);

  const manualPunch = async (): Promise<void> => {
    if (manualBusy) return;
    setManualBusy(true);
    setManualMessage(null);
    setManualError(null);
    try {
      const position = await currentFix(
        "Location permission is required to record a punch."
      );
      const payload: GeoPunchPayload = {
        employeeRef: employee.erpUserId,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters:
          position.coords.accuracy === null ? null : Math.round(position.coords.accuracy),
        // NO branchRef (Phase 17): the bridge matches the coordinates against
        // every registered site and decides where this punch happened. Sending
        // a branch would let the phone pick its own answer.
        timestamp: Date.now(),
      };

      const dispatch = await sendOrQueue(session, payload);
      if (dispatch.queued) {
        setManualMessage(dispatch.message);
      } else if (dispatch.response?.ok) {
        setManualMessage(dispatch.response.message);
      } else {
        // A real verdict — most often OUTSIDE_GEOFENCE, which the bridge has
        // already recorded as a denied exception.
        setManualError(dispatch.response?.message ?? "Punch rejected.");
      }
    } catch (err) {
      setManualError(err instanceof Error ? err.message : "Punch failed.");
    } finally {
      setManualBusy(false);
      await queue.refresh();
    }
  };

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Identity ─────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.hello}>{employee.fullName}</Text>
          <Text style={styles.subHello}>
            {employee.erpUserId} · {homeSite}
            {session.offline ? " · offline session" : ""}
          </Text>
        </View>
      </View>

      {/* ── 1 + 2. Live geofence status ──────────────────────────────── */}
      <Panel style={styles.card}>
        <StatusChip active={geofence.active} />

        <View style={styles.rows}>
          <Row label="Home site" value={homeSite} />
          <Row
            label="You are at"
            value={
              geofence.siteBranch ?? (geofence.hasFix ? "Outside every site" : "Locating…")
            }
          />
          <Row
            label="Distance"
            value={
              geofence.distanceMeters === null
                ? geofence.hasFix
                  ? "—"
                  : "Locating…"
                : `${formatDistance(geofence.distanceMeters)}${
                    geofence.inside ? " · inside" : " · outside"
                  }`
            }
          />
          <Row
            label="Radius"
            value={geofence.radiusMeters === null ? "—" : `${geofence.radiusMeters} m`}
          />
          <Row
            label="Watching"
            value={`${geofence.siteCount} site${geofence.siteCount === 1 ? "" : "s"}`}
          />
          <Row
            label="Accuracy"
            value={
              geofence.accuracyMeters === null
                ? "—"
                : `± ${Math.round(geofence.accuracyMeters)} m`
            }
          />
        </View>

        {geofence.dwell && !geofence.dwell.firedAt ? (
          <View style={styles.infoBox}>
            <Text style={styles.infoText}>
              Dwell in progress at {geofence.dwell.branch ?? "this site"} — clocking
              automatically in {geofence.dwellRemaining ?? "0:00"} if you stay on site.
            </Text>
          </View>
        ) : null}

        {geofence.dwell?.firedAt && geofence.dwell.outcomeMessage ? (
          <View
            style={[
              styles.infoBox,
              geofence.dwell.outcome === "Rejected" ? styles.infoWarn : styles.infoOk,
            ]}
          >
            <Text style={styles.infoText}>
              {timeLabel(geofence.dwell.firedAt)} · {geofence.dwell.outcomeMessage}
            </Text>
          </View>
        ) : null}

        {geofence.message ? (
          <View style={styles.infoBox}>
            <Text style={styles.infoText}>{geofence.message}</Text>
          </View>
        ) : null}

        {tracking && !tracking.ok && tracking.reason !== "no-fence" ? (
          <PrimaryButton
            label="RETRY MONITORING"
            variant="ghost"
            onPress={() => void retryTracking()}
            style={styles.retry}
          />
        ) : null}
      </Panel>

      {/* ── 3. Site map (courtesy display) ───────────────────────────── */}
      <Panel
        title="Site map"
        subtitle={
          sites.length === 0
            ? "No site has hands-free mobile clocking set up yet."
            : `${sites.length} site${sites.length === 1 ? "" : "s"} you can clock in at · the neon dot is you.`
        }
        style={styles.card}
      >
        <SiteMap
          sites={sites}
          home={session.geofence}
          me={
            geofence.hasFix && geofence.latitude !== null && geofence.longitude !== null
              ? { latitude: geofence.latitude, longitude: geofence.longitude }
              : null
          }
          height={260}
        />
        <Text style={styles.note}>
          The bridge validates every punch on the server — the map is a guide,
          not the decision.
        </Text>
      </Panel>

      {/* ── 4. Manual fallback ───────────────────────────────────────── */}
      <Panel
        title="Manual punch"
        subtitle="Sends your current GPS position — the bridge works out which registered branch you are in."
        style={styles.card}
      >
        <PrimaryButton
          label="CLOCK IN / OUT"
          onPress={() => void manualPunch()}
          loading={manualBusy}
        />
        <Text style={styles.note}>
          The bridge works out whether this is a clock-in or a clock-out from
          your punch sequence today.
        </Text>

        {manualMessage ? (
          <View style={[styles.infoBox, styles.infoOk]}>
            <Text style={styles.infoText}>{manualMessage}</Text>
          </View>
        ) : null}
        {manualError ? (
          <View style={[styles.infoBox, styles.infoWarn]}>
            <Text style={styles.infoText}>{manualError}</Text>
          </View>
        ) : null}
      </Panel>

      {/* ── 5. Offline queue ─────────────────────────────────────────── */}
      <Panel
        title="Pending offline punches"
        subtitle={
          queue.pending.length === 0
            ? "Everything on this device has been delivered."
            : `${queue.pending.length} waiting to reach the bridge.`
        }
        style={styles.card}
      >
        {queue.pending.length > 0 ? (
          <View style={styles.queue}>
            {queue.pending.map((entry) => (
              <View key={entry.id} style={styles.queueRow}>
                <View style={styles.queueText}>
                  <Text style={styles.queueTime}>{timeLabel(entry.payload.timestamp)}</Text>
                  <Text style={styles.queueMeta} numberOfLines={1}>
                    {entry.payload.latitude.toFixed(4)}, {entry.payload.longitude.toFixed(4)}
                  </Text>
                </View>
                <Text style={styles.queueBadge}>QUEUED</Text>
              </View>
            ))}

            <PrimaryButton
              label="SYNC NOW"
              variant="ghost"
              onPress={() => void queue.syncNow()}
              loading={queue.syncing}
              style={styles.sync}
            />
          </View>
        ) : null}

        {queue.message ? (
          <View style={[styles.infoBox, styles.infoOk]}>
            <Text style={styles.infoText}>{queue.message}</Text>
          </View>
        ) : null}
        {queue.error ? (
          <View style={[styles.infoBox, styles.infoWarn]}>
            <Text style={styles.infoText}>{queue.error}</Text>
          </View>
        ) : null}
      </Panel>

      <PrimaryButton
        label="SIGN OUT"
        variant="danger"
        onPress={() => void signOut()}
        style={styles.signOut}
      />
    </ScrollView>
  );
}

/** One label/value line inside the status card. */
function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scroll: {
    padding: SPACING.lg,
    paddingBottom: SPACING.xxl,
    gap: SPACING.lg,
  },
  header: {
    marginTop: SPACING.sm,
  },
  headerText: {
    gap: 2,
  },
  hello: {
    ...TEXT.display,
    fontSize: 26,
  },
  subHello: {
    ...TEXT.caption,
    letterSpacing: 0.3,
  },
  card: {
    marginBottom: 0,
  },
  rows: {
    marginTop: SPACING.lg,
    gap: SPACING.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.md,
  },
  rowLabel: {
    ...TEXT.label,
  },
  rowValue: {
    flexShrink: 1,
    fontSize: FONT.small,
    fontWeight: "600",
    color: COLORS.white,
    textAlign: "right",
  },
  infoBox: {
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelDeep,
  },
  infoOk: {
    borderColor: COLORS.neon,
  },
  infoWarn: {
    borderColor: COLORS.warning,
    backgroundColor: COLORS.warningSoft,
  },
  infoText: {
    fontSize: FONT.small,
    color: COLORS.textMuted,
    lineHeight: 19,
  },
  note: {
    ...TEXT.caption,
    marginTop: SPACING.md,
    lineHeight: 17,
  },
  retry: {
    marginTop: SPACING.md,
  },
  queue: {
    marginTop: SPACING.sm,
  },
  queueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: SPACING.md,
  },
  queueText: {
    flexShrink: 1,
  },
  queueTime: {
    fontSize: FONT.body,
    fontWeight: "700",
    color: COLORS.white,
  },
  queueMeta: {
    ...TEXT.caption,
    marginTop: 2,
  },
  queueBadge: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    color: COLORS.warning,
  },
  sync: {
    marginTop: SPACING.lg,
  },
  signOut: {
    marginTop: SPACING.sm,
  },
});
