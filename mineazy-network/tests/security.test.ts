/**
 * ============================================================================
 *  tests/security.test.ts — secrets, sessions and the audit trail
 * ============================================================================
 *
 *  Three guarantees:
 *    1. A stored SNMP secret is encrypted at rest and never serialised into
 *       an API-shaped object.
 *    2. Password hashes never leave the server.
 *    3. The session cookie is signed, time limited and tamper-evident.
 * ============================================================================
 */

import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";

import { tempDatabase, removeTempDatabase } from "./helpers";

const dbPath = tempDatabase("security");

let credentials: typeof import("../src/lib/repo/credentials");
let users: typeof import("../src/lib/repo/users");
let audit: typeof import("../src/lib/repo/audit");
let session: typeof import("../src/lib/session");
let db: typeof import("../src/lib/db");

before(async () => {
  credentials = await import("../src/lib/repo/credentials");
  users = await import("../src/lib/repo/users");
  audit = await import("../src/lib/repo/audit");
  session = await import("../src/lib/session");
  db = await import("../src/lib/db");
});

after(() => {
  removeTempDatabase(dbPath);
});

describe("SNMP credentials", () => {
  test("the community string is encrypted at rest", async () => {
    const community = "super-secret-community";
    const id = await credentials.createCredential({
      name: "core-switch",
      version: "2c",
      community,
    });

    // Read the raw row straight out of the database.
    const client = await db.getDb();
    const rows = await db.queryAll<{ Community: string }>(
      client,
      "SELECT Community FROM SNMP_Credentials WHERE Credential_ID = ?",
      id
    );
    assert.ok(rows[0]);
    assert.notEqual(rows[0].Community, community, "the community must not be stored in clear text");
    assert.ok(!rows[0].Community.includes(community));
  });

  test("the collector can still read the secret back", async () => {
    const list = await credentials.listCredentials(true);
    const credential = list.find((entry) => entry.name === "core-switch");
    assert.equal(credential?.community, "super-secret-community");
  });

  test("the API-shaped summary never contains the secret", async () => {
    const summaries = await credentials.credentialSummaries();
    const summary = summaries.find((entry) => entry.name === "core-switch");
    assert.ok(summary);
    assert.equal(summary.hasCommunity, true);
    assert.ok(!("community" in summary), "the summary must not carry the raw community string");
    assert.ok(!JSON.stringify(summary).includes("super-secret-community"));
    assert.match(summary!.communityPreview, /^su.*y$/);
  });

  test("SNMPv3 requires a username and v1/v2c require a community string", async () => {
    await assert.rejects(
      () => credentials.createCredential({ name: "bad-v3", version: "3" }),
      /username/i
    );
    await assert.rejects(
      () => credentials.createCredential({ name: "bad-v2c", version: "2c" }),
      /community/i
    );
  });

  test("the v3 auth and privacy keys are encrypted too", async () => {
    const id = await credentials.createCredential({
      name: "core-switch-v3",
      version: "3",
      username: "monitor",
      authProtocol: "SHA",
      authKey: "authenticationkey123",
      privProtocol: "AES",
      privKey: "privacykey123456",
    });

    const client = await db.getDb();
    const rows = await db.queryAll<{ Auth_Key: string; Priv_Key: string }>(
      client,
      "SELECT Auth_Key, Priv_Key FROM SNMP_Credentials WHERE Credential_ID = ?",
      id
    );
    assert.ok(!rows[0].Auth_Key.includes("authenticationkey123"));
    assert.ok(!rows[0].Priv_Key.includes("privacykey123456"));

    const credential = await credentials.getCredential(id, true);
    assert.equal(credential?.authKey, "authenticationkey123");
    assert.equal(credential?.privKey, "privacykey123456");
  });
});

describe("console accounts", () => {
  test("the account list never carries a password hash", async () => {
    const list = await users.listUsers();
    assert.ok(list.length > 0);
    for (const user of list) {
      assert.ok(!("passwordHash" in user));
      assert.ok(!("password_hash" in user));
      assert.ok(!JSON.stringify(user).includes("$scrypt$"));
      assert.ok(!JSON.stringify(user).includes("$argon2"));
    }
  });

  test("the password is hashed, never stored in clear text", async () => {
    const password = "correct horse battery staple";
    const id = await users.createUser({
      username: "test-operator",
      email: "operator@mineazy.local",
      role: "operator",
      password,
    });

    const client = await db.getDb();
    const rows = await db.queryAll<{ Password_Hash: string }>(
      client,
      "SELECT Password_Hash FROM Users WHERE User_ID = ?",
      id
    );
    assert.ok(rows[0]);
    assert.notEqual(rows[0].Password_Hash, password);
    assert.ok(rows[0].Password_Hash.length > 20);
  });

  test("the right password authenticates and the wrong one does not", async () => {
    await users.createUser({
      username: "test-viewer",
      email: "viewer@mineazy.local",
      role: "viewer",
      password: "viewer-password-123",
    });
    const good = await users.authenticate("test-viewer", "viewer-password-123");
    assert.ok(good);
    assert.equal(good!.role, "viewer");

    const bad = await users.authenticate("test-viewer", "wrong-password");
    assert.equal(bad, null);
  });

  test("an inactive account cannot authenticate", async () => {
    const id = await users.createUser({
      username: "test-disabled",
      email: "disabled@mineazy.local",
      role: "viewer",
      password: "disabled-password-123",
    });
    await users.updateUser(id, { active: false });
    assert.equal(await users.authenticate("test-disabled", "disabled-password-123"), null);
  });
});

describe("session tokens", () => {
  test("a signed token verifies and carries the claims", () => {
    const { token } = session.createSessionToken({
      accountId: 42,
      name: "Test User",
      email: "test@mineazy.local",
      role: "operator",
    });
    const claims = session.verifySessionToken(token);
    assert.ok(claims);
    assert.equal(claims!.sub, "42");
    assert.equal(claims!.role, "operator");
    assert.ok(claims!.exp > Date.now());
  });

  test("a tampered token is rejected", () => {
    const { token } = session.createSessionToken({
      accountId: 42,
      name: "Test User",
      email: "test@mineazy.local",
      role: "viewer",
    });
    const [claims, signature] = token.split(".");
    const forged = `${claims}.${signature.slice(0, -2)}aa`;
    assert.equal(session.verifySessionToken(forged), null);
  });

  test("a token with an escalated role claim is still rejected", () => {
    const { token } = session.createSessionToken({
      accountId: 42,
      name: "Test User",
      email: "test@mineazy.local",
      role: "viewer",
    });
    const [claims] = token.split(".");
    const decoded = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    decoded.role = "administrator";
    const resigned = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    assert.equal(session.verifySessionToken(`${resigned}.${token.split(".")[1]}`), null);
  });

  test("an expired token is rejected", () => {
    const claims = Buffer.from(
      JSON.stringify({
        sub: "1",
        name: "Test",
        email: "t@e.st",
        role: "administrator",
        exp: Date.now() - 1000,
      }),
      "utf8"
    ).toString("base64url");
    const signature = crypto
      .createHmac(
        "sha256",
        crypto.createHash("sha256").update(process.env.MINEAZY_SESSION_SECRET ?? "").digest()
      )
      .update(claims)
      .digest("base64url");
    assert.equal(session.verifySessionToken(`${claims}.${signature}`), null);
  });

  test("garbage tokens are rejected without throwing", () => {
    assert.equal(session.verifySessionToken(""), null);
    assert.equal(session.verifySessionToken("nonsense"), null);
    assert.equal(session.verifySessionToken("a.b.c"), null);
    assert.equal(session.verifySessionToken(null), null);
  });
});

describe("the backup checkpoint", () => {
  test("a checkpoint flushes the write-ahead log and leaves the data intact", async () => {
    const before = await db.queryAll<{ c: number }>(
      await db.getDb(),
      "SELECT COUNT(*) AS c FROM Users"
    );

    const result = await db.checkpoint();
    assert.equal(result.ok, true, result.detail);
    assert.match(result.detail, /write-ahead log/i);

    const after = await db.queryAll<{ c: number }>(
      await db.getDb(),
      "SELECT COUNT(*) AS c FROM Users"
    );
    assert.equal(after[0].c, before[0].c, "a checkpoint must not lose rows");
  });
});

describe("the audit trail", () => {
  test("an audit entry is written and can be read back", async () => {
    await audit.recordAudit({
      userId: 1,
      userName: "admin",
      action: "create",
      entity: "device",
      entityId: 12,
      after: { name: "Test device" },
      note: "Created by the security test.",
    });
    const entries = await audit.listAudit(50);
    assert.ok(entries.length > 0);
    assert.ok(entries.some((entry) => entry.entity === "device" && entry.entityId === "12"));
  });

  test("an audit entry never contains a password hash", async () => {
    await audit.recordAudit({
      userId: 1,
      userName: "admin",
      action: "update",
      entity: "user",
      entityId: 2,
      after: { role: "viewer" },
      note: "Role changed.",
    });
    const entries = await audit.listAudit(50);
    assert.ok(!JSON.stringify(entries).includes("$scrypt$"));
  });
});
