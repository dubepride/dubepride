/**
 * ============================================================================
 *  tests/secrets.test.ts — encryption of stored SNMP credentials
 * ============================================================================
 *
 *  A community string or an SNMPv3 key must never be readable at rest, never
 *  appear in a redacted preview, and never survive a tamper.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import { before, describe, test } from "node:test";

import { tempDatabase } from "./helpers";

tempDatabase("secrets");

let encryptSecret: (value: string) => string;
let decryptSecret: (value: string) => string;
let redactSecret: (value: string) => string;

before(async () => {
  const secrets = await import("../src/lib/secrets");
  encryptSecret = secrets.encryptSecret;
  decryptSecret = secrets.decryptSecret;
  redactSecret = secrets.redactSecret;
});

describe("encryption", () => {
  test("a secret round-trips", () => {
    const plaintext = "public-community-string";
    const stored = encryptSecret(plaintext);
    assert.equal(decryptSecret(stored), plaintext);
  });

  test("the ciphertext does not contain the plaintext", () => {
    const plaintext = "s3cr3t-community";
    const stored = encryptSecret(plaintext);
    assert.ok(!stored.includes(plaintext));
    assert.match(stored, /^v1\$[0-9a-f]+\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  test("the same plaintext encrypts differently every time", () => {
    const a = encryptSecret("repeated");
    const b = encryptSecret("repeated");
    assert.notEqual(a, b, "a random IV must be used");
    assert.equal(decryptSecret(a), "repeated");
    assert.equal(decryptSecret(b), "repeated");
  });

  test("a tampered ciphertext fails to decrypt instead of returning garbage", () => {
    const stored = encryptSecret("tamper-me");
    const parts = stored.split("$");
    // Flip the last character of the ciphertext.
    const last = parts[3];
    parts[3] = `${last.slice(0, -1)}${last.endsWith("a") ? "b" : "a"}`;
    assert.equal(decryptSecret(parts.join("$")), "");
  });

  test("malformed ciphertext returns an empty string, never an exception", () => {
    assert.equal(decryptSecret(""), "");
    assert.equal(decryptSecret("garbage"), "");
    assert.equal(decryptSecret("v2$a$b$c"), "");
    assert.equal(decryptSecret("v1$zz$yy$xx"), "");
  });

  test("an empty secret stays empty", () => {
    assert.equal(encryptSecret(""), "");
    assert.equal(decryptSecret(""), "");
  });
});

describe("redaction", () => {
  test("a long secret shows only its first and last two characters", () => {
    const preview = redactSecret("abcdefghijklmnop");
    assert.ok(preview.startsWith("ab"));
    assert.ok(preview.endsWith("op"));
    assert.ok(!preview.includes("cdefghijklm"));
  });

  test("a short secret is fully masked", () => {
    assert.equal(redactSecret("abc"), "••••");
    assert.equal(redactSecret(""), "");
  });
});
