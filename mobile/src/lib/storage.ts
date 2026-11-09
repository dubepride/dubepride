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

import type {
  DwellState,
  MobileSession,
  PresencePayload,
  QueuedPunch,
} from "./types";

/** Versioned so a future shape change can't be misread as the old one. */
export const STORAGE_KEYS = {
  session: "biobridge.session.v1",
  lastVerifiedSession: "biobridge.last_verified_session.v1",
  pin: "biobridge.pin.v1",
  apiUrl: "biobridge.apiUrl.v1",
  queue: "biobridge.queue.v1",
  dwell: "biobridge.dwell.v1",
  presence: "biobridge.presence.v1",
  lastPresence: "biobridge.last_presence.v1",
} as const;

/**
 * expo-secure-store has no web implementation, and some custom Android OEM ROMs
 * have hardware keystore quirks. Mirroring to AsyncStorage guarantees sessions
 * and offline credentials survive restarts on every handset.
 */
const SECURE_AVAILABLE = Platform.OS !== "web";

async function secureGet(key: string): Promise<string | null> {
  if (SECURE_AVAILABLE) {
    try {
      const val = await SecureStore.getItemAsync(key);
      if (val !== null && val !== undefined) return val;
    } catch {
      /* fallback to AsyncStorage below */
    }
  }
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  if (SECURE_AVAILABLE) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      /* keychain unavailable — fallback below */
    }
  }
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

async function secureDelete(key: string): Promise<void> {
  if (SECURE_AVAILABLE) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* nothing to delete */
    }
  }
  try {
    await AsyncStorage.removeItem(key);
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
  const serialized = JSON.stringify(session);
  await secureSet(STORAGE_KEYS.session, serialized);
  await secureSet(STORAGE_KEYS.lastVerifiedSession, serialized);
}

export async function readLastVerifiedSession(): Promise<MobileSession | null> {
  const raw = await secureGet(STORAGE_KEYS.lastVerifiedSession);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MobileSession;
    return parsed && parsed.employee ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearLastVerifiedSession(): Promise<void> {
  await secureDelete(STORAGE_KEYS.lastVerifiedSession);
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

/* ------------------------------------------------------------------ */
/* Field Tracker presence (AsyncStorage)                               */
/* ------------------------------------------------------------------ */

/**
 * The latest fix whose heartbeat could not reach the bridge. Latest-position
 * only: a newer fix replaces the old one, so reconnecting never replays a
 * stale trail of movement.
 */
export async function readPendingPresence(): Promise<PresencePayload | null> {
  return readJson<PresencePayload | null>(STORAGE_KEYS.presence, null);
}

export async function writePendingPresence(payload: PresencePayload): Promise<void> {
  await writeJson(STORAGE_KEYS.presence, payload);
}

export async function clearPendingPresence(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEYS.presence).catch(() => undefined);
}

export interface LastPresenceRecord {
  status: string;
  at: number;
  accuracyMeters: number | null;
  branch: string | null;
}

/** Last heartbeat outcome, for the Location health panel. */
export async function readLastPresence(): Promise<LastPresenceRecord | null> {
  return readJson<LastPresenceRecord | null>(STORAGE_KEYS.lastPresence, null);
}

export async function writeLastPresence(record: LastPresenceRecord): Promise<void> {
  await writeJson(STORAGE_KEYS.lastPresence, record);
}
