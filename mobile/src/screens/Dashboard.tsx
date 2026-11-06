/**
 * ============================================================================
 *  Dashboard.tsx — BioBridge Mobile Attendance
 * ============================================================================
 *
 *  The employee screen:
 *   1. Primary action: Clock In / Clock Out. The worker clocks in/out
 *      themselves by pressing the button. There is no auto-clock.
 *   2. Live geofence & profile monitoring: polls every 4s and on app resume so
 *      geofence edits (radius, coordinates, clocking methods) and employee or
 *      branch edits made on the web app reflect on the phone in real time.
 *   3. Site map: authorised site fences with live radii and the worker's fix.
 *   4. Offline queue & automatic sync: punches recorded offline are stored
 *      locally and uploaded automatically when internet returns.
 */

import * as Location from "expo-location";
import React, { useEffect, useState } from "react";
import {
  AppState,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Panel } from "@/components/Panel";
import { PrimaryButton } from "@/components/PrimaryButton";
import { SiteMap } from "@/components/SiteMap";
import { StatusChip } from "@/components/StatusChip";
import { useGeofenceStatus } from "@/hooks/useGeofenceStatus";
import { usePendingQueue } from "@/hooks/usePendingQueue";
import { sendOrQueue } from "@/lib/api";
import { activeSite, formatDistance, nearestSite, sessionSites } from "@/lib/geo";
import { useAuth } from "@/lib/session";
import type { GeoPunchPayload } from "@/lib/types";
import { COLORS, FONT, RADIUS, SPACING, TEXT } from "@/theme";

import LOGO from "../../assets/icon.png";

/** "14:07" format */
function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

async function currentFix(message: string): Promise<Location.LocationObject> {
  const servicesEnabled = await Location.hasServicesEnabledAsync().catch(() => true);
  if (!servicesEnabled) {
    throw new Error("Location Services are switched off on your device. Please enable Location in Settings.");
  }
  const permission = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!permission || permission.status !== Location.PermissionStatus.GRANTED) {
    const asked = await Location.requestForegroundPermissionsAsync().catch(() => null);
    if (!asked || asked.status !== Location.PermissionStatus.GRANTED) {
      throw new Error(message);
    }
  }

  // 1. Primary: High Accuracy (standard on GMS devices)
  try {
    return await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
      timeInterval: 4000,
    });
  } catch (errHigh) {
    console.warn("High accuracy fix failed, attempting Balanced fallback:", errHigh);
  }

  // 2. Secondary fallback: Balanced Accuracy (cell/wifi/standard GPS)
  try {
    return await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 4000,
    });
  } catch (errBalanced) {
    console.warn("Balanced accuracy fix failed, attempting LastKnown fallback:", errBalanced);
  }

  // 3. Tertiary fallback: Most recent known fix
  try {
    const lastKnown = await Location.getLastKnownPositionAsync();
    if (lastKnown) {
      return lastKnown;
    }
  } catch (errLast) {
    console.warn("Last known position failed:", errLast);
  }

  // 4. Final attempt: Lowest accuracy
  try {
    return await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Lowest,
    });
  } catch (errFinal) {
    console.warn("Lowest accuracy fix failed:", errFinal);
  }

  throw new Error("Could not acquire GPS position. Please make sure Location/GPS is turned on in your phone's Settings and try again.");
}

export function Dashboard(): React.ReactElement {
  const { session, signOut, refreshFences, tracking, retryTracking, recordLocalPunch } = useAuth();
  const geofence = useGeofenceStatus(session);
  const queue = usePendingQueue(session);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // Keep the map usable on small phones and proportionate on tablets.
  const mapHeight = Math.max(220, Math.min(340, Math.round(width * 0.62)));

  const [clockBusy, setClockBusy] = useState(false);
  const [clockMessage, setClockMessage] = useState<string | null>(null);
  const [clockError, setClockError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);

  // Live 4s sync with the server so web-console geofence and employee edits
  // reflect immediately.
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
    session.geofence?.radiusMeters ?? sitesRadiusForBranch(session.fences, homeSite);
  const sites = sessionSites(session);
  const displayedRadius =
    geofence.radiusMeters ?? homeRadius ?? sites[0]?.radiusMeters ?? null;
  const onSite = geofence.inside;
  const hasFix = geofence.hasFix;
  const noFence = sites.length === 0;
  const trackingOn = tracking?.ok === true;
  const trackingMessage =
    tracking?.message ?? "Location sharing is not running yet. Enable it to appear on the Field Tracker.";

  const handleClock = async (): Promise<void> => {
    if (clockBusy) return;
    setClockBusy(true);
    setClockMessage(null);
    setClockError(null);

    try {
      // Non-blocking background geofence refresh attempt
      void refreshFences().catch(() => {});

      let lat = geofence.latitude;
      let lng = geofence.longitude;
      let acc = geofence.accuracyMeters;

      if (lat === null || lng === null) {
        const position = await currentFix(
          "Location permission is required to record your attendance punch."
        );
        lat = position.coords.latitude;
        lng = position.coords.longitude;
        acc = position.coords.accuracy === null ? null : Math.round(position.coords.accuracy);
      }

      // Check geofence boundary locally (vital for instant offline accuracy)
      const matched = activeSite(sites, lat, lng, acc);
      if (sites.length > 0 && !matched) {
        const nearest = nearestSite(sites, lat, lng, acc);
        if (nearest) {
          const diff = nearest.distanceMeters - nearest.site.radiusMeters;
          setClockError(
            `Outside geofence: You are ${formatDistance(diff)} outside ${nearest.site.branch} (distance: ${formatDistance(nearest.distanceMeters)}, allowed radius: ${nearest.site.radiusMeters}m).`
          );
        } else {
          setClockError("Outside authorised geofence. Please move inside your branch perimeter to clock.");
        }
        return;
      }

      const nextDirection: "IN" | "OUT" = dayStatus?.clockedIn ? "OUT" : "IN";

      const payload: GeoPunchPayload = {
        employeeRef: employee.erpUserId,
        latitude: lat,
        longitude: lng,
        accuracyMeters: acc,
        deviceId: session.deviceId ?? null,
        deviceName: session.deviceName ?? null,
        timestamp: Date.now(),
        branchRef: matched?.site.branch ?? undefined,
      };

      const dispatch = await sendOrQueue(session, payload);
      if (dispatch.queued) {
        await recordLocalPunch(nextDirection, payload.timestamp);
        const branchName = matched?.site.branch ?? homeSite;
        setClockMessage(
          `Clocked ${nextDirection === "IN" ? "IN" : "OUT"} offline at ${branchName}. Stored safely and will sync when online.`
        );
        void queue.triggerAutoSync();
      } else if (dispatch.response?.ok) {
        await recordLocalPunch(nextDirection, payload.timestamp);
        setClockMessage(dispatch.response.message ?? `Clocked ${nextDirection === "IN" ? "IN" : "OUT"} successfully.`);
        void refreshFences();
      } else {
        setClockError(
          dispatch.response?.message ?? "Punch rejected outside the authorised geofence."
        );
      }
    } catch (err) {
      setClockError(err instanceof Error ? err.message : "Could not complete punch.");
    } finally {
      setClockBusy(false);
      await queue.refresh();
    }
  };

  const handleRetryTracking = async (): Promise<void> => {
    if (retryBusy) return;
    setRetryBusy(true);
    try {
      await retryTracking();
    } finally {
      setRetryBusy(false);
    }
  };

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.scroll,
        {
          paddingTop: insets.top + SPACING.md,
          paddingBottom: insets.bottom + SPACING.xxl,
          paddingLeft: insets.left + SPACING.lg,
          paddingRight: insets.right + SPACING.lg,
        },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.shell}>
      {/* ── Brand bar ───────────────────────────────────────────────── */}
      <View style={styles.topBar}>
        <Image source={LOGO} style={styles.topLogo} resizeMode="cover" />
        <View style={styles.topBrandBlock}>
          <Text style={styles.topBrand}>BIOBRIDGE</Text>
          <Text style={styles.topTagline}>TIME &amp; ATTENDANCE</Text>
        </View>
        <View style={[styles.livePill, onSite ? styles.livePillOn : styles.livePillOff]}>
          <View
            style={[
              styles.liveDot,
              onSite
                ? styles.liveDotOn
                : hasFix && !noFence
                  ? styles.liveDotWarn
                  : styles.liveDotIdle,
            ]}
          />
          <Text
            style={[
              styles.liveLabel,
              onSite
                ? styles.liveLabelOn
                : hasFix && !noFence
                  ? styles.liveLabelWarn
                  : styles.liveLabelIdle,
            ]}
          >
            {onSite ? "ON SITE" : noFence ? "NO FENCE" : hasFix ? "OUTSIDE" : "LOCATING"}
          </Text>
        </View>
      </View>

      {/* ── Identity ────────────────────────────────────────────────── */}
      <View style={styles.identity}>
        <Text style={styles.hello}>{employee.fullName}</Text>
        <Text style={styles.meta}>
          {employee.erpUserId}
          {employee.department ? ` · ${employee.department}` : ""} · {homeSite}
          {session.offline ? " · offline session" : ""}
        </Text>

        <View style={styles.dayRow}>
          <Text style={styles.dayLabel}>TODAY</Text>
          {dayStatus?.lastPunchAt ? (
            <Text style={styles.dayValue}>
              <Text style={dayStatus.clockedIn ? styles.statusIn : styles.statusOut}>
                {dayStatus.clockedIn ? "CLOCKED IN" : "CLOCKED OUT"}
              </Text>
              <Text style={styles.dayMeta}>
                {" "}
                · last punch {timeLabel(dayStatus.lastPunchAt)}
              </Text>
            </Text>
          ) : (
            <Text style={styles.dayValueMuted}>No punch yet</Text>
          )}
        </View>
      </View>

      {/* ── 1. Primary action: Clock In / Clock Out ─────────────────── */}
      <Panel
        title="Attendance"
        subtitle="Clock in or out yourself. Every punch is checked against your site geofence."
      >
        <View
          style={[styles.statusBox, onSite ? styles.statusInside : styles.statusOutside]}
        >
          <View
            style={[styles.statusDot, onSite ? styles.statusDotInside : styles.statusDotOutside]}
          />
          <View style={styles.statusText}>
            <Text style={[styles.statusTitle, onSite ? styles.textInside : styles.textOutside]}>
              {onSite
                ? "Inside geofence · ready to clock"
                : hasFix
                  ? "Outside site geofence"
                  : "Acquiring GPS fix…"}
            </Text>
            {onSite ? (
              <Text style={styles.statusSub}>
                {geofence.siteBranch} · {geofence.distanceMeters ?? 0}m from centre · radius{" "}
                {geofence.radiusMeters ?? 150}m
              </Text>
            ) : geofence.siteBranch ? (
              <Text style={styles.statusSub}>
                Nearest: {geofence.siteBranch} · {geofence.distanceMeters ?? 0}m away · radius{" "}
                {geofence.radiusMeters ?? 150}m
              </Text>
            ) : displayedRadius !== null ? (
              <Text style={styles.statusSub}>
                Configured radius: {displayedRadius}m · waiting for device GPS
              </Text>
            ) : null}
          </View>
        </View>

        <PrimaryButton
          label={
            dayStatus ? (dayStatus.clockedIn ? "CLOCK OUT" : "CLOCK IN") : "CLOCK IN / OUT"
          }
          onPress={() => void handleClock()}
          loading={clockBusy}
        />

        <Text style={styles.note}>
          Tap the button to clock in or out yourself. The main system records your
          attendance and direction.
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

      {/* ── 2. Live geofence monitoring ─────────────────────────────── */}
      <Panel title="Geofence" subtitle="Live boundary and GPS status from the main system.">
        <StatusChip
          active={geofence.active}
          activeLabel={geofence.inside ? "Inside geofence" : "Geofence active"}
          idleLabel={sites.length > 0 ? "Locating GPS" : "No mobile fence"}
        />

        <View style={styles.rows}>
          <Row label="Home site" value={homeSite} />
          <Row
            label="Home radius"
            value={
              homeRadius !== null
                ? `${homeRadius} m${session.geofence?.method ? ` (${session.geofence.method})` : ""}`
                : session.geofence?.method === "Biometric"
                  ? "Biometric terminal only"
                  : "—"
            }
          />
          <Row
            label="Active site"
            value={
              geofence.siteBranch ??
              (geofence.hasFix ? "Outside all sites" : sites[0]?.branch ?? "Locating…")
            }
          />
          <Row
            label="Distance to centre"
            value={
              geofence.distanceMeters === null
                ? geofence.hasFix
                  ? "—"
                  : "Locating…"
                : `${formatDistance(geofence.distanceMeters)}${
                    geofence.inside ? " (inside)" : " (outside)"
                  }`
            }
          />
          <Row
            label="Active radius"
            value={displayedRadius === null ? "—" : `${displayedRadius} m`}
          />
          <Row
            label="Mobile sites"
            value={`${sites.length} registered site${sites.length === 1 ? "" : "s"}`}
          />
          <Row
            label="Field Tracker"
            value={
              tracking?.ok
                ? "Sharing location"
                : tracking
                  ? "Not sharing"
                  : "Starting…"
            }
          />
          <Row
            label="GPS accuracy"
            value={
              geofence.accuracyMeters === null
                ? "—"
                : `± ${Math.round(geofence.accuracyMeters)} m`
            }
          />
        </View>

        {sites.length > 0 ? (
          <View style={styles.siteListBox}>
            <Text style={styles.siteListHeading}>Configured site radii</Text>
            <View style={styles.siteListGrid}>
              {sites.map((s) => {
                const isHome = s.branch.toLowerCase() === homeSite.toLowerCase();
                const isCurrent =
                  geofence.siteBranch &&
                  s.branch.toLowerCase() === geofence.siteBranch.toLowerCase();
                return (
                  <View
                    key={`${s.id}-${s.branch}`}
                    style={[styles.sitePill, (isHome || isCurrent) && styles.sitePillHighlight]}
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

        <View style={[styles.locationNotice, trackingOn ? null : styles.locationNoticeWarn]}>
          <View style={styles.locationNoticeHeader}>
            <View
              style={[styles.locationDot, trackingOn ? null : styles.locationDotWarn]}
            />
            <Text
              style={[
                styles.locationNoticeTitle,
                trackingOn ? null : styles.locationNoticeTitleWarn,
              ]}
            >
              {trackingOn ? "Field Tracker sharing on" : "Location sharing needs attention"}
            </Text>
          </View>
          <Text style={styles.locationNoticeText}>
            {trackingOn
              ? noFence
                ? "No geofenced site is configured yet, but this phone still shares its latest location with the office Field Tracker while you are signed in. Sharing stops when you sign out."
                : "This phone shares its latest location with the office Field Tracker while you are signed in — online or offline. Cached fixes upload automatically when internet returns. Sharing stops when you sign out."
              : trackingMessage}
          </Text>
          {trackingOn ? null : (
            <PrimaryButton
              label="RETRY LOCATION SHARING"
              variant="soft"
              onPress={() => void handleRetryTracking()}
              loading={retryBusy}
              style={styles.retryButton}
            />
          )}
        </View>
      </Panel>

      {/* ── 3. Site map ─────────────────────────────────────────────── */}
      <Panel
        title="Site map"
        subtitle={
          sites.length === 0
            ? "No geofenced sites configured yet."
            : `${sites.length} site${sites.length === 1 ? "" : "s"} with geofence · the neon dot is you.`
        }
      >
        <SiteMap
          sites={sites}
          home={session.geofence}
          me={
            geofence.hasFix && geofence.latitude !== null && geofence.longitude !== null
              ? {
                  latitude: geofence.latitude,
                  longitude: geofence.longitude,
                  accuracy: geofence.accuracyMeters,
                }
              : null
          }
          height={mapHeight}
        />
        <Text style={styles.note}>
          Fence circles reflect the live radii and coordinates configured on the
          main system.
        </Text>
      </Panel>

      {/* ── 4. Offline punches & automatic sync ─────────────────────── */}
      <Panel
        title="Offline attendance"
        subtitle={
          queue.pending.length === 0
            ? "All attendance records are synchronized."
            : `${queue.pending.length} punch${queue.pending.length === 1 ? "" : "es"} stored offline · auto-sync active`
        }
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
                The app automatically detects internet connectivity and uploads all
                offline punches. No manual action is needed.
              </Text>
            </View>
          </View>
        ) : null}

        {queue.autoSyncing ? (
          <View style={[styles.infoBox, styles.infoOk]}>
            <Text style={styles.infoText}>
              Internet detected — automatically syncing punches with the main system…
            </Text>
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

      {/* ── Sign out ────────────────────────────────────────────────── */}
      <View style={styles.footer}>
        <PrimaryButton
          label="SIGN OUT"
          variant="danger"
          onPress={() => void signOut()}
          style={styles.signOut}
        />
        <Text style={styles.footerMeta}>
          Device locked{session.deviceName ? ` · ${session.deviceName}` : ""}
        </Text>
      </View>
      </View>
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
    flexGrow: 1,
    width: "100%",
  },
  shell: {
    width: "100%",
    maxWidth: 760,
    alignSelf: "center",
    gap: SPACING.lg,
  },

  /* Brand bar ---------------------------------------------------------- */
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.md,
    marginTop: SPACING.xs,
  },
  topLogo: {
    width: 40,
    height: 40,
    borderRadius: 11,
  },
  topBrandBlock: {
    flex: 1,
  },
  topBrand: {
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 3.4,
    color: COLORS.white,
  },
  topTagline: {
    marginTop: 2,
    fontSize: 8,
    fontWeight: "600",
    letterSpacing: 1.8,
    color: COLORS.textFaint,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  livePillOn: {
    backgroundColor: COLORS.neonSoft,
    borderColor: COLORS.neonBorder,
  },
  livePillOff: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderColor: COLORS.border,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  liveDotOn: {
    backgroundColor: COLORS.neon,
  },
  liveDotWarn: {
    backgroundColor: COLORS.warning,
  },
  liveDotIdle: {
    backgroundColor: COLORS.idle,
  },
  liveLabel: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  liveLabelOn: {
    color: COLORS.neon,
  },
  liveLabelWarn: {
    color: COLORS.warning,
  },
  liveLabelIdle: {
    color: COLORS.idle,
  },

  /* Identity ----------------------------------------------------------- */
  identity: {
    gap: 4,
    marginTop: SPACING.xs,
  },
  hello: {
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: -0.5,
    color: COLORS.white,
  },
  meta: {
    fontSize: FONT.small,
    color: COLORS.textMuted,
    letterSpacing: 0.2,
  },
  dayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  dayLabel: {
    ...TEXT.label,
    fontSize: 9,
    letterSpacing: 1.2,
  },
  dayValue: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
  },
  dayMeta: {
    color: COLORS.textFaint,
  },
  dayValueMuted: {
    fontSize: FONT.caption,
    color: COLORS.textFaint,
  },
  statusIn: {
    color: COLORS.neon,
    fontWeight: "800",
  },
  statusOut: {
    color: COLORS.warning,
    fontWeight: "800",
  },

  /* Clock card --------------------------------------------------------- */
  statusBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: SPACING.md + 2,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    marginBottom: SPACING.lg,
  },
  statusInside: {
    backgroundColor: "rgba(0, 230, 118, 0.07)",
    borderColor: COLORS.neonBorder,
  },
  statusOutside: {
    backgroundColor: "rgba(255, 179, 0, 0.06)",
    borderColor: "rgba(255, 179, 0, 0.45)",
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 4,
  },
  statusDotInside: {
    backgroundColor: COLORS.neon,
  },
  statusDotOutside: {
    backgroundColor: COLORS.warning,
  },
  statusText: {
    flex: 1,
  },
  statusTitle: {
    fontSize: FONT.caption,
    fontWeight: "800",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  textInside: {
    color: COLORS.neon,
  },
  textOutside: {
    color: COLORS.warning,
  },
  statusSub: {
    marginTop: 3,
    fontSize: FONT.caption,
    color: COLORS.textMuted,
  },
  note: {
    fontSize: FONT.caption,
    lineHeight: 18,
    color: COLORS.textFaint,
    marginTop: SPACING.md,
  },

  /* Geofence rows ------------------------------------------------------ */
  rows: {
    marginTop: SPACING.lg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.md,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderSoft,
  },
  rowLabel: {
    ...TEXT.label,
    fontSize: 9,
    letterSpacing: 1.1,
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
    borderTopColor: COLORS.borderSoft,
  },
  siteListHeading: {
    ...TEXT.label,
    fontSize: 9,
    letterSpacing: 1.1,
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
    borderColor: COLORS.neonBorder,
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

  /* Info / notices ----------------------------------------------------- */
  infoBox: {
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelDeep,
  },
  infoOk: {
    borderColor: COLORS.neonBorder,
  },
  infoWarn: {
    borderColor: "rgba(255, 179, 0, 0.45)",
    backgroundColor: COLORS.warningSoft,
  },
  infoText: {
    fontSize: FONT.small,
    color: COLORS.textMuted,
    lineHeight: 19,
  },
  locationNotice: {
    marginTop: SPACING.lg,
    padding: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
    backgroundColor: COLORS.panelDeep,
  },
  locationNoticeWarn: {
    borderColor: "rgba(255, 179, 0, 0.45)",
    backgroundColor: COLORS.warningSoft,
  },
  retryButton: {
    marginTop: SPACING.md,
  },
  locationNoticeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginBottom: 5,
  },
  locationDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: COLORS.neon,
  },
  locationDotWarn: {
    backgroundColor: COLORS.warning,
  },
  locationNoticeTitle: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: COLORS.neon,
  },
  locationNoticeTitleWarn: {
    color: COLORS.warning,
  },
  locationNoticeText: {
    fontSize: FONT.small,
    color: COLORS.textMuted,
    lineHeight: 19,
  },

  /* Offline queue ------------------------------------------------------ */
  queue: {
    marginTop: SPACING.xs,
  },
  queueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderSoft,
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
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1,
    color: COLORS.warning,
  },
  autoSyncNotice: {
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: RADIUS.sm,
    backgroundColor: "rgba(255, 255, 255, 0.035)",
  },
  autoSyncNoticeText: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    lineHeight: 17,
  },

  /* Footer ------------------------------------------------------------- */
  footer: {
    marginTop: SPACING.sm,
    alignItems: "center",
    gap: SPACING.sm,
  },
  signOut: {
    alignSelf: "stretch",
  },
  footerMeta: {
    fontSize: FONT.tiny,
    color: COLORS.textFaint,
    textAlign: "center",
  },
});
