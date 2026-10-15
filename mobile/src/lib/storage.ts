/**
 * ============================================================================
 *  storage.ts — where the app's state lives, and why in two places
 * ============================================================================
 *
 *  Two stores, chosen per the sensitivity of what they hold:
 *
 *   SecureStore (encrypted keychain / Android keystore)
 *     · the verified session — employee identity, branch geofence, base URL
 *     · the PIN, so a phone that is offline can still be unlocked
 *
 *   AsyncStorage (plain, bulk, no secrets)
 *     · the offline punch queue — must survive process death
 *     · the dwell state machine — written from the headless background context
 *
 *  Reads are total: a corrupt or half-written value degrades to `null`/`[]`
 *  rather than throwing inside a background task where nothing could catch it.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { DwellState, MobileSession, QueuedPunch } from "./types";

/** Versioned so a future shape change can't be misread as the old one. */
export const STORAGE_KEYS = {
  session: "biobridge.session.v1",
  pin: "biobridge.pin.v1",
  apiUrl: "biobridge.apiUrl.v1",
  queue: "biobridge.queue.v1",
  dwell: "biobridge.dwell.v1",
} as const;

/**
 * expo-secure-store has no web implementation. Falls back to AsyncStorage so
 * `npm run web` still boots for UI work — a desktop browser is not a device
 * we would ever clock from, so the weaker store is acceptable there.
 */
const SECURE_AVAILABLE = Platform.OS !== "web";

async function secureGet(key: string): Promise<string | null> {
  if (!SECURE_AVAILABLE) return AsyncStorage.getItem(key);
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  if (!SECURE_AVAILABLE) {
    await AsyncStorage.setItem(key, value);
    return;
  }
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    /* keychain unavailable (rare) — treat as a no-op, the UI stays usable */
  }
}

async function secureDelete(key: string): Promise<void> {
  if (!SECURE_AVAILABLE) {
    await AsyncStorage.removeItem(key);
    return;
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    /* nothing to delete */
  }
}

/* ------------------------------------------------------------------ */
/* AsyncStorage JSON helpers                                           */
/* ------------------------------------------------------------------ */

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / unavailable — the punch is retried on the next fix */
  }
}

/* ------------------------------------------------------------------ */
/* Session + PIN (SecureStore)                                         */
/* ------------------------------------------------------------------ */

export async function readSession(): Promise<MobileSession | null> {
  const raw = await secureGet(STORAGE_KEYS.session);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MobileSession;
    return parsed && parsed.employee ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSession(session: MobileSession | null): Promise<void> {
  if (session === null) {
    await secureDelete(STORAGE_KEYS.session);
    return;
  }
  await secureSet(STORAGE_KEYS.session, JSON.stringify(session));
}

export async function readPin(): Promise<string | null> {
  return secureGet(STORAGE_KEYS.pin);
}

export async function writePin(pin: string | null): Promise<void> {
  if (pin === null) {
    await secureDelete(STORAGE_KEYS.pin);
    return;
  }
  await secureSet(STORAGE_KEYS.pin, pin);
}

/** Last base URL that worked — pre-fills the login screen on the next launch. */
export async function readSavedApiUrl(): Promise<string | null> {
  return secureGet(STORAGE_KEYS.apiUrl);
}

export async function writeSavedApiUrl(url: string): Promise<void> {
  await secureSet(STORAGE_KEYS.apiUrl, url);
}

/* ------------------------------------------------------------------ */
/* Offline queue (AsyncStorage)                                        */
/* ------------------------------------------------------------------ */

export async function readQueue(): Promise<QueuedPunch[]> {
  return readJson<QueuedPunch[]>(STORAGE_KEYS.queue, []);
}

export async function writeQueue(queue: QueuedPunch[]): Promise<void> {
  await writeJson(STORAGE_KEYS.queue, queue);
}

/* ------------------------------------------------------------------ */
/* Dwell state machine (AsyncStorage)                                  */
/* ------------------------------------------------------------------ */

export async function readDwell(): Promise<DwellState | null> {
  return readJson<DwellState | null>(STORAGE_KEYS.dwell, null);
}

export async function writeDwell(state: DwellState | null): Promise<void> {
  if (state === null) {
    await AsyncStorage.removeItem(STORAGE_KEYS.dwell).catch(() => undefined);
    return;
  }
  await writeJson(STORAGE_KEYS.dwell, state);
}

/** Forget the current visit entirely — called on EXIT and on sign-out. */
export async function clearDwell(): Promise<void> {
  await writeDwell(null);
}
