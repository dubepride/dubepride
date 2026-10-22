/**
 * ============================================================================
 *  secrets.ts — encryption for stored network credentials
 * ============================================================================
 *
 *  SNMP community strings / v3 keys must never reach the browser or the
 *  repository. They are stored in the database encrypted with AES-256-GCM
 *  under a key derived from MINEAZY_SECRET_KEY.
 *
 *  Ciphertext format:  v1$<iv-hex>$<tag-hex>$<ciphertext-hex>
 *
 *  If MINEAZY_SECRET_KEY is not set, a per-install key is generated once and
 *  cached next to the database file (mode 0600 on POSIX). That keeps local
 *  installs working without shipping a secret, while still keeping the
 *  plaintext out of the database and out of every API response.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";

/** The cached key file used when no environment secret is provided. */
function keyFilePath(): string {
  const configured = process.env.MINEAZY_SECRET_KEY_FILE?.trim();
  if (configured) return configured;
  const dbPath = process.env.MINEAZY_DB_PATH?.trim() || path.join(process.cwd(), "data", "mineazy.db");
  return path.join(path.dirname(dbPath), "secret.key");
}

let cachedKey: Buffer | null = null;

/** The 32-byte encryption key (env secret preferred, generated fallback). */
export function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const envSecret = (process.env.MINEAZY_SECRET_KEY ?? "").trim();
  if (envSecret) {
    cachedKey = crypto.createHash("sha256").update(envSecret).digest();
    return cachedKey;
  }

  const file = keyFilePath();
  try {
    // The key path is env-overridable, so it cannot be statically scoped.
    // Both calls are guarded and fall back to an in-memory key, so telling
    // Turbopack not to trace them is safe.
    if (fs.existsSync(/*turbopackIgnore: true*/ file)) {
      const hex = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim();
      const buf = Buffer.from(hex, "hex");
      if (buf.length === 32) {
        cachedKey = buf;
        return cachedKey;
      }
    }
  } catch {
    // fall through — regenerate
  }

  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  } catch {
    // Read-only filesystem: the key still works for this process.
  }
  cachedKey = key;
  return cachedKey;
}

/** Encrypt a plaintext secret. */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1$${iv.toString("hex")}$${tag.toString("hex")}$${enc.toString("hex")}`;
}

/** Decrypt a stored secret. Returns "" when the value cannot be read. */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  try {
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const data = Buffer.from(parts[3], "hex");
    const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/** Redact a secret for display (never show more than the first/last 2 chars). */
export function redactSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}${"•".repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}
