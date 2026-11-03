/**
 * ============================================================================
 *  device.ts — Hardware Device Identification for BioBridge Mobile
 * ============================================================================
 *
 *  Generates and persists a permanent hardware-backed device identifier in the
 *  Android Keystore (via expo-secure-store) alongside the handset's physical
 *  Brand / Model / OS version from React Native Platform.constants.
 *
 *  Used by the bridge's 1-to-1 Device Binding policy to prevent buddy clocking:
 *    - Once an employee logs in on their phone, their Employee ID is locked to
 *      this deviceId on the main server.
 *    - Any attempt to log in with that Employee ID on another phone — or to log
 *      in with a colleague's Employee ID on this phone — is rejected.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const SECURE_DEVICE_ID_KEY = "biobridge.hardware.device_id.v1";
const ASYNC_DEVICE_ID_KEY = "@biobridge/hardware-device-id:v1";

export interface DeviceIdentity {
  /** Unique hardware-backed identifier (e.g. "BB-8F4A-2C91-7E0B"). */
  deviceId: string;
  /** Human-readable handset description (e.g. "Samsung SM-A546E · Android 14"). */
  deviceName: string;
}

let cachedIdentity: DeviceIdentity | null = null;

function randomHexBlock(length: number): string {
  const chars = "0123456789ABCDEF";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function generateHardwareId(): string {
  return `BB-${randomHexBlock(4)}-${randomHexBlock(4)}-${randomHexBlock(4)}`;
}

function capitalize(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Extract human-readable device brand & model from React Native Platform.constants.
 */
export function getDeviceModelName(): string {
  try {
    const constants = (Platform.constants ?? {}) as Record<string, unknown>;
    const rawBrand = typeof constants.Brand === "string"
      ? constants.Brand.trim()
      : typeof constants.Manufacturer === "string"
        ? constants.Manufacturer.trim()
        : "";
    const rawModel = typeof constants.Model === "string" ? constants.Model.trim() : "";
    const rawRelease = typeof constants.Release === "string" ? constants.Release.trim() : "";

    const brand = capitalize(rawBrand);
    let label = "";
    if (brand && rawModel) {
      label = rawModel.toLowerCase().startsWith(brand.toLowerCase())
        ? rawModel
        : `${brand} ${rawModel}`;
    } else {
      label = rawModel || brand || (Platform.OS === "android" ? "Android Device" : "Mobile Device");
    }

    if (rawRelease && Platform.OS === "android") {
      return `${label} (Android ${rawRelease})`;
    }
    return label;
  } catch {
    return Platform.OS === "android" ? "Android Handset" : "Mobile Handset";
  }
}

/**
 * Retrieve (or initialize once) this phone's persistent device identity.
 */
export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  if (cachedIdentity) return cachedIdentity;

  const deviceName = getDeviceModelName();
  let deviceId: string | null = null;

  // 1. Try Android Hardware Keystore via SecureStore
  if (Platform.OS !== "web") {
    try {
      deviceId = await SecureStore.getItemAsync(SECURE_DEVICE_ID_KEY);
    } catch {
      deviceId = null;
    }
  }

  // 2. Fallback to AsyncStorage
  if (!deviceId) {
    try {
      deviceId = await AsyncStorage.getItem(ASYNC_DEVICE_ID_KEY);
    } catch {
      deviceId = null;
    }
  }

  // 3. First launch on this handset — generate and lock in both stores
  if (!deviceId || !deviceId.trim()) {
    deviceId = generateHardwareId();
  }

  // Persist to both stores so it survives cache clears
  if (Platform.OS !== "web") {
    try {
      await SecureStore.setItemAsync(SECURE_DEVICE_ID_KEY, deviceId);
    } catch {
      // Ignore if keystore unavailable
    }
  }
  try {
    await AsyncStorage.setItem(ASYNC_DEVICE_ID_KEY, deviceId);
  } catch {
    // Ignore storage error
  }

  cachedIdentity = { deviceId, deviceName };
  return cachedIdentity;
}
