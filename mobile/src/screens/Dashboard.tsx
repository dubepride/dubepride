/**
 * ============================================================================
 *  Dashboard.tsx — Mine Eazy Mobile Attendance
 * ============================================================================
 *
 *  The employee screen:
 *   1. Primary Action: Clock In / Clock Out. The worker clocks in/out themselves
 *      by pressing the button. There is no auto-clock.
 *   2. Live Geofence & Profile Monitoring: Polls every 4s and on app resume so
 *      all geofence edits (resizing geofence radius, moving coordinates,
 *      changing clocking methods) and employee/branch edits done on the web app
 *      accurately reflect on the mobile app in real time.
 *   3. Site Map: Visualizes authorized site fences with live radii and
 *      the worker's GPS fix.
 *   4. Offline Queue & Automatic Sync: When punches occur while offline, they
 *      are saved locally. The app auto-detects internet connectivity and
 *      automatically syncs with the main system — the user never manually syncs.
 */

import * as Location from "expo-location";
import React, { useEffect, useState } from "react";
import {
  AppState,
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

/** "14:07" format */
function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

async function currentFix(message: string): Promise<Location.LocationObject> {
  if (!(await Location.hasServicesEnabledAsync())) {
    throw new Error("Location Services are switched off on your device.");
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
  const { session, signOut, refreshFences } = useAuth();
  const geofence = useGeofenceStatus(session);
  const queue = usePendingQueue(session);

  const [clockBusy, setClockBusy] = useState(false);
  const [clockMessage, setClockMessage] = useState<string | null>(null);
  const [clockError, setClockError] = useState<string | null>(null);

  // Live 4s sync with server so web console geofence radius edits and employee/branch edits reflect immediately
  useEffect(() => {
    void refreshFences();

    const interval = setInterval(() => {
      void refreshFences();
    }, 4_000);

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshFences();
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [refreshFences]);

  if (!session) return <View style={styles.flex} />;

  const { employee, dayStatus } = session;
  const homeSite = employee.branch || "Unassigned";
  const homeRadius =
    session.geofence?.radiusMeters ??
    sitesRadiusForBranch(session.fences, homeSite);
  const sites = sessionSites(session);
  const displayedRadius =
    geofence.radiusMeters ?? homeRadius ?? sites[0]?.radiusMeters ?? null;

  const handleClock = async (): Promise<void> => {
    if (clockBusy) return;
    setClockBusy(true);
    setClockMessage(null);
    setClockError(null);

    try {
      await refreshFences();
      const position = await currentFix(
        "Location permission is required to record your attendance punch."
      );

      const payload: GeoPunchPayload = {
        employeeRef: employee.erpUserId,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters:
          position.coords.accuracy === null ? null : Math.round(position.coords.accuracy),
        deviceId: session.deviceId ?? null,
        deviceName: session.deviceName ?? null,
        timestamp: Date.now(),
      };

      const dispatch = await sendOrQueue(session, payload);
      if (dispatch.queued) {
        setClockMessage("Punch recorded offline — will automatically sync to main system when internet connects.");
        void queue.triggerAutoSync();
      } else if (dispatch.response?.ok) {
        setClockMessage(dispatch.response.message ?? "Punch recorded successfully.");
        void refreshFences();
      } else {
        setClockError(dispatch.response?.message ?? "Punch rejected outside authorized geofence.");
      }
    } catch (err) {
      setClockError(err instanceof Error ? err.message : "Could not complete punch.");
    } finally {
      setClockBusy(false);
      await queue.refresh();
    }
  };

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      {/* ── Employee Identity ─────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.hello}>{employee.fullName}</Text>
          <Text style={styles.subHello}>
            Emp ID: {employee.erpUserId}
            {employee.department ? ` · ${employee.department}` : ""} · Site: {homeSite}
            {session.offline ? " · offline session" : ""}
          </Text>
          <Text style={styles.subHello}>
            🔒 Bound Device: {session.deviceName ? `${session.deviceName} · ` : ""}
            {session.deviceId ?? employee.boundDeviceId ?? "Verified"}
          </Text>
          {dayStatus?.lastPunchAt ? (
            <Text style={styles.dayStatusLine}>
              Today:{" "}
              <Text style={dayStatus.clockedIn ? styles.statusIn : styles.statusOut}>
                {dayStatus.clockedIn ? "CLOCKED IN" : "CLOCKED OUT"}
              </Text>{" "}
              (last punch {timeLabel(dayStatus.lastPunchAt)})
            </Text>
          ) : null}
        </View>
      </View>

      {/* ── 1. Primary Action: Clock In / Clock Out ─────────────────────── */}
      <Panel
        title="Record Attendance"
        subtitle="Verify your position inside your authorized site geofence and clock in or out."
        style={styles.card}
      >
        <View style={styles.statusBox}>
          {geofence.inside ? (
            <View style={[styles.badgeContainer, styles.badgeInside]}>
              <Text style={styles.badgeTextInside}>
                ✓ INSIDE GEOFENCE · READY TO CLOCK
              </Text>
              <Text style={styles.badgeSubText}>
                {geofence.siteBranch} ({geofence.distanceMeters ?? 0}m from centre · radius: {geofence.radiusMeters ?? 150}m)
              </Text>
            </View>
          ) : (
            <View style={[styles.badgeContainer, styles.badgeOutside]}>
              <Text style={styles.badgeTextOutside}>
                {geofence.hasFix ? "OUTSIDE SITE GEOFENCE" : "ACQUIRING GPS FIX…"}
              </Text>
              {geofence.siteBranch ? (
                <Text style={styles.badgeSubText}>
                  Nearest: {geofence.siteBranch} ({geofence.distanceMeters ?? 0}m away · radius: {geofence.radiusMeters ?? 150}m)
                </Text>
              ) : displayedRadius !== null ? (
                <Text style={styles.badgeSubText}>
                  Configured radius: {displayedRadius}m · Waiting for device GPS…
                </Text>
              ) : null}
            </View>
          )}
        </View>

        <PrimaryButton
          label={dayStatus?.clockedIn ? "CLOCK OUT" : "CLOCK IN / OUT"}
          onPress={() => void handleClock()}
          loading={clockBusy}
          style={styles.clockButton}
        />

        <Text style={styles.note}>
          Tap the button to clock in or out yourself. The main system records your attendance and direction.
        </Text>

        {clockMessage ? (
          <View style={[styles.infoBox, styles.infoOk]}>
            <Text style={styles.infoText}>{clockMessage}</Text>
          </View>
        ) : null}
        {clockError ? (
          <View style={[styles.infoBox, styles.infoWarn]}>
            <Text style={styles.infoText}>{clockError}</Text>
          </View>
        ) : null}
      </Panel>

      {/* ── 2. Live Geofence Monitoring ───────────────────────────────── */}
      <Panel
        title="Geofence Monitoring"
        subtitle="Live boundary status reflecting current web admin configuration and radius."
        style={styles.card}
      >
        <StatusChip
          active={geofence.active}
          activeLabel={geofence.inside ? "Inside Geofence" : "Geofence Active"}
          idleLabel={sites.length > 0 ? "Geofence Ready · Locating GPS" : "No Mobile Fence"}
        />

        <View style={styles.rows}>
          <Row label="Home Site" value={homeSite} />
          <Row
            label="Home Site Radius"
            value={
              homeRadius !== null
                ? `${homeRadius} m${session.geofence?.method ? ` (${session.geofence.method})` : ""}`
                : session.geofence?.method === "Biometric"
                  ? "Biometric terminal only"
                  : "—"
            }
          />
          <Row
            label="Nearest / Active Site"
            value={
              geofence.siteBranch ?? (geofence.hasFix ? "Outside all sites" : sites[0]?.branch ?? "Locating…")
            }
          />
          <Row
            label="Distance to Centre"
            value={
              geofence.distanceMeters === null
                ? geofence.hasFix
                  ? "—"
                  : "Locating…"
                : `${formatDistance(geofence.distanceMeters)}${
                    geofence.inside ? " (Inside)" : " (Outside)"
                  }`
            }
          />
          <Row
            label="Active Geofence Radius"
            value={displayedRadius === null ? "—" : `${displayedRadius} m`}
          />
          <Row
            label="Active Mobile Sites"
            value={`${sites.length} registered site${sites.length === 1 ? "" : "s"}`}
          />
          <Row
            label="GPS Accuracy"
            value={
              geofence.accuracyMeters === null
                ? "—"
                : `± ${Math.round(geofence.accuracyMeters)} m`
            }
          />
        </View>

        {sites.length > 0 ? (
          <View style={styles.siteListBox}>
            <Text style={styles.siteListHeading}>LIVE CONFIGURED SITE RADII</Text>
            <View style={styles.siteListGrid}>
              {sites.map((s) => {
                const isHome = s.branch.toLowerCase() === homeSite.toLowerCase();
                const isCurrent =
                  geofence.siteBranch &&
                  s.branch.toLowerCase() === geofence.siteBranch.toLowerCase();
                return (
                  <View
                    key={`${s.id}-${s.branch}`}
                    style={[
                      styles.sitePill,
                      (isHome || isCurrent) && styles.sitePillHighlight,
                    ]}
                  >
                    <Text style={styles.sitePillName} numberOfLines={1}>
                      {s.branch}
                    </Text>
                    <Text style={styles.sitePillRadius}>{s.radiusMeters} m</Text>
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}

        {geofence.message ? (
          <View style={styles.infoBox}>
            <Text style={styles.infoText}>{geofence.message}</Text>
          </View>
        ) : null}

        <View style={styles.locationNotice}>
          <Text style={styles.locationNoticeTitle}>📍 LOCATION SHARING ON</Text>
          <Text style={styles.locationNoticeText}>
            While you are signed in, this phone sends its latest location to the
            office Field Tracker so the branch can see who is on site. Sharing
            stops when you sign out.
          </Text>
        </View>
      </Panel>

      {/* ── 3. Site Map ───────────────────────────────────────────────── */}
      <Panel
        title="Site Map"
        subtitle={
          sites.length === 0
            ? "No geofenced sites configured yet."
            : `${sites.length} site${sites.length === 1 ? "" : "s"} with geofence · neon dot is your position.`
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
          Geofence circles reflect real-time radii and coordinates configured on the main system.
        </Text>
      </Panel>

      {/* ── 4. Offline Punches & Auto-Sync (User does not sync) ────────── */}
      <Panel
        title="Offline Attendance"
        subtitle={
          queue.pending.length === 0
            ? "All attendance records synchronized with main system."
            : `${queue.pending.length} punch${queue.pending.length === 1 ? "" : "es"} stored offline · Auto-sync active`
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
                    GPS: {entry.payload.latitude.toFixed(4)}, {entry.payload.longitude.toFixed(4)}
                  </Text>
                </View>
                <Text style={styles.queueBadge}>SAVED OFFLINE</Text>
              </View>
            ))}

            <View style={styles.autoSyncNotice}>
              <Text style={styles.autoSyncNoticeText}>
                The app automatically detects internet connectivity and uploads all offline punches to the main system. No manual action is needed.
              </Text>
            </View>
          </View>
        ) : null}

        {queue.autoSyncing ? (
          <View style={[styles.infoBox, styles.infoOk]}>
            <Text style={styles.infoText}>Internet detected — automatically syncing punches with main system…</Text>
          </View>
        ) : null}
        {queue.message && queue.pending.length === 0 ? (
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

      {/* ── Sign Out ─────────────────────────────────────────────────── */}
      <PrimaryButton
        label="SIGN OUT"
        variant="danger"
        onPress={() => void signOut()}
        style={styles.signOut}
      />
    </ScrollView>
  );
}

function sitesRadiusForBranch(
  fences: readonly { branch: string; radiusMeters: number }[] | null | undefined,
  branch: string
): number | null {
  if (!fences || !branch) return null;
  const hit = fences.find((f) => f.branch.toLowerCase() === branch.toLowerCase());
  return hit ? hit.radiusMeters : null;
}

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
  dayStatusLine: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  statusIn: {
    color: COLORS.neon,
    fontWeight: "800",
  },
  statusOut: {
    color: COLORS.warning,
    fontWeight: "800",
  },
  card: {
    marginBottom: 0,
  },
  statusBox: {
    marginBottom: SPACING.md,
  },
  badgeContainer: {
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
  },
  badgeInside: {
    backgroundColor: "rgba(0, 230, 118, 0.08)",
    borderColor: COLORS.neon,
  },
  badgeOutside: {
    backgroundColor: "rgba(255, 171, 0, 0.08)",
    borderColor: COLORS.warning,
  },
  badgeTextInside: {
    fontSize: FONT.small,
    fontWeight: "800",
    color: COLORS.neon,
    letterSpacing: 0.5,
  },
  badgeTextOutside: {
    fontSize: FONT.small,
    fontWeight: "800",
    color: COLORS.warning,
    letterSpacing: 0.5,
  },
  badgeSubText: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 3,
  },
  clockButton: {
    marginTop: SPACING.xs,
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
  siteListBox: {
    marginTop: SPACING.lg,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  siteListHeading: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
    color: COLORS.textMuted,
    marginBottom: SPACING.sm,
  },
  siteListGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACING.xs,
  },
  sitePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 5,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelDeep,
  },
  sitePillHighlight: {
    borderColor: COLORS.neon,
    backgroundColor: "rgba(0, 230, 118, 0.08)",
  },
  sitePillName: {
    fontSize: FONT.caption,
    fontWeight: "600",
    color: COLORS.white,
    maxWidth: 130,
  },
  sitePillRadius: {
    fontSize: FONT.caption,
    fontWeight: "800",
    color: COLORS.neon,
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
  locationNotice: {
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.neon,
    backgroundColor: COLORS.panelDeep,
  },
  locationNoticeTitle: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: COLORS.neon,
    marginBottom: 4,
  },
  locationNoticeText: {
    fontSize: FONT.small,
    color: COLORS.textMuted,
    lineHeight: 19,
  },
  note: {
    ...TEXT.caption,
    marginTop: SPACING.sm,
    lineHeight: 17,
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
  autoSyncNotice: {
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.sm,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  autoSyncNoticeText: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    lineHeight: 16,
  },
  signOut: {
    marginTop: SPACING.sm,
  },
});
