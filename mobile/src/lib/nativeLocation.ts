/**
 * ============================================================================
 *  nativeLocation.ts — bridge to the patched ExpoLocation Android module
 * ============================================================================
 *
 *  The Huawei / non-GMS fix lives in `android-patches/` and is copied into
 *  expo-location at install time. Everything here is optional: an older APK or
 *  a non-Android platform simply returns `null` / `false`, and the UI falls
 *  back to the standard Android settings screens and plain guidance.
 *
 *  Keeping the native calls in one place means the dashboard never has to know
 *  whether it is running on the patched build.
 */

import { Linking, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

/** Must match BIOBRIDGE_NATIVE_LOCATION_ENGINE in android-patches/LocationHelpers.kt */
export const EXPECTED_NATIVE_MARKER = "biobridge-native-v2";

export interface NativeLocationInfo {
  marker: string;
  nativeFallback: boolean;
  manufacturer: string;
  model: string;
  sdk: number;
  googlePlayServices: boolean;
}

interface NativeLocationModule {
  biobridgeGetNativeInfo?: () => Promise<NativeLocationInfo>;
  biobridgeIsIgnoringBatteryOptimizations?: () => Promise<boolean>;
  biobridgeOpenBatteryOptimizationSettings?: () => Promise<boolean>;
  biobridgeOpenLocationSettings?: () => Promise<boolean>;
  biobridgeOpenAppSettings?: () => Promise<boolean>;
  biobridgeOpenHuaweiStartupSettings?: () => Promise<boolean>;
}

let nativeModule: NativeLocationModule | null | undefined;

function getNativeModule(): NativeLocationModule | null {
  if (Platform.OS !== "android") return null;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = requireOptionalNativeModule<NativeLocationModule>("ExpoLocation");
  } catch {
    nativeModule = null;
  }
  return nativeModule;
}

/** Native engine information, or null when the installed APK predates the patch. */
export async function getNativeLocationInfo(): Promise<NativeLocationInfo | null> {
  try {
    const mod = getNativeModule();
    if (!mod?.biobridgeGetNativeInfo) return null;
    return await mod.biobridgeGetNativeInfo();
  } catch {
    return null;
  }
}

/** True when the app is exempt from Android battery optimisation. */
export async function isIgnoringBatteryOptimizations(): Promise<boolean | null> {
  try {
    const mod = getNativeModule();
    if (!mod?.biobridgeIsIgnoringBatteryOptimizations) return null;
    return await mod.biobridgeIsIgnoringBatteryOptimizations();
  } catch {
    return null;
  }
}

export async function openAppSettings(): Promise<boolean> {
  try {
    const mod = getNativeModule();
    if (mod?.biobridgeOpenAppSettings) {
      const opened = await mod.biobridgeOpenAppSettings();
      if (opened) return true;
    }
  } catch {
    /* fall through to Linking */
  }
  try {
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}

export async function openLocationSettings(): Promise<boolean> {
  try {
    const mod = getNativeModule();
    if (mod?.biobridgeOpenLocationSettings) {
      const opened = await mod.biobridgeOpenLocationSettings();
      if (opened) return true;
    }
  } catch {
    /* fall through */
  }
  if (Platform.OS === "android") {
    try {
      await Linking.sendIntent("android.settings.LOCATION_SOURCE_SETTINGS");
      return true;
    } catch {
      /* fall through */
    }
  }
  return openAppSettings();
}

export async function openBatteryOptimizationSettings(): Promise<boolean> {
  try {
    const mod = getNativeModule();
    if (mod?.biobridgeOpenBatteryOptimizationSettings) {
      const opened = await mod.biobridgeOpenBatteryOptimizationSettings();
      if (opened) return true;
    }
  } catch {
    /* fall through */
  }
  if (Platform.OS === "android") {
    try {
      await Linking.sendIntent("android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS");
      return true;
    } catch {
      /* fall through */
    }
  }
  return openAppSettings();
}

/**
 * Opens Huawei/Honor System Manager → App launch (auto-launch, secondary
 * launch, run in background). Falls back to app details when the OEM screens
 * are not present.
 */
export async function openHuaweiStartupSettings(): Promise<boolean> {
  try {
    const mod = getNativeModule();
    if (mod?.biobridgeOpenHuaweiStartupSettings) {
      const opened = await mod.biobridgeOpenHuaweiStartupSettings();
      if (opened) return true;
    }
  } catch {
    /* fall through */
  }
  return openAppSettings();
}

export function isHuaweiDevice(info: NativeLocationInfo | null): boolean {
  const manufacturer = (info?.manufacturer ?? "").toLowerCase();
  return manufacturer.includes("huawei") || manufacturer.includes("honor");
}
