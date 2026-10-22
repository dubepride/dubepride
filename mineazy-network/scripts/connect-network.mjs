#!/usr/bin/env node
/**
 * ============================================================================
 *  connect-network.mjs — point a fresh install at your real hardware
 * ============================================================================
 *
 *  The console's UI can register scan ranges, run a sweep and save settings,
 *  but two steps that a real deployment always needs are API-only today:
 *
 *    1. storing the SNMP credential the collector will use, and
 *    2. switching the discovered infrastructure from ICMP to SNMP.
 *
 *  Without step 2 the console pings switches but never reads their ports,
 *  LLDP neighbours or forwarding tables — so the Live Map stays empty. This
 *  script does both, idempotently, and tells you exactly what it changed.
 *
 *  USAGE
 *
 *    # SNMPv2c
 *    MINEAZY_ADMIN_PASSWORD='...' SNMP_COMMUNITY='public' \
 *      node scripts/connect-network.mjs
 *
 *    # SNMPv3 (preferred)
 *    MINEAZY_ADMIN_PASSWORD='...' SNMP_VERSION=3 SNMP_USER='mineazy' \
 *      SNMP_AUTH_KEY='32+ chars' SNMP_PRIV_KEY='32+ chars' \
 *      node scripts/connect-network.mjs
 *
 *    # See what it would do, change nothing
 *    MINEAZY_ADMIN_PASSWORD='...' SNMP_COMMUNITY='public' \
 *      node scripts/connect-network.mjs --dry-run
 *
 *    # Also tell it what "the internet" means for your site
 *    MINEAZY_ADMIN_PASSWORD='...' SNMP_COMMUNITY='public' \
 *      node scripts/connect-network.mjs \
 *      --gateway=192.168.1.1 --internet=1.1.1.1,https://example.com/health
 *
 *  OPTIONS
 *
 *    --url=<url>          console base URL           (default http://localhost:3100)
 *    --user=<name>        login name                 (default admin)
 *    --credential=<name>  SNMP credential label      (default "default")
 *    --categories=a,b     device categories to switch (default infrastructure)
 *    --gateway=<ip>       the site's default gateway (monitor.gatewayTargets)
 *    --internet=a,b       reachability targets       (monitor.internetTargets);
 *                         an http(s):// value becomes an HTTP probe
 *    --dry-run            print the plan, write nothing
 *
 *  Every write goes through the public HTTP API, so RBAC, validation and the
 *  audit trail behave exactly as they do for a click in the console.
 * ============================================================================
 */

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, "").split("=");
  args.set(key, value ?? "true");
}

const BASE = (args.get("url") ?? process.env.MINEAZY_URL ?? "http://localhost:3100").replace(/\/$/, "");
const USER = args.get("user") ?? process.env.MINEAZY_ADMIN_USER ?? "admin";
const PASSWORD = process.env.MINEAZY_ADMIN_PASSWORD ?? "";
const CREDENTIAL_NAME = args.get("credential") ?? process.env.SNMP_CREDENTIAL_NAME ?? "default";
const DRY_RUN = args.get("dry-run") === "true";

const INFRASTRUCTURE = ["internet", "router", "gateway", "switch", "access_point"];
const CATEGORIES = (args.get("categories") ?? INFRASTRUCTURE.join(","))
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

const snmp = {
  version: (process.env.SNMP_VERSION ?? "2c").trim(),
  community: process.env.SNMP_COMMUNITY ?? "",
  username: process.env.SNMP_USER ?? "",
  authProtocol: process.env.SNMP_AUTH_PROTOCOL ?? "SHA",
  authKey: process.env.SNMP_AUTH_KEY ?? "",
  privProtocol: process.env.SNMP_PRIV_PROTOCOL ?? "AES",
  privKey: process.env.SNMP_PRIV_KEY ?? "",
};

/* -------------------------------------------------------------------------- */

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function requireSnmpInput() {
  if (snmp.version === "3") {
    if (!snmp.username) die("SNMP_VERSION=3 needs SNMP_USER.");
    if (!snmp.authKey) die("SNMP_VERSION=3 needs SNMP_AUTH_KEY.");
    if (snmp.authKey.length < 8) die("SNMP_AUTH_KEY must be at least 8 characters (most devices refuse less).");
    if (snmp.privKey && snmp.privKey.length < 8) die("SNMP_PRIV_KEY must be at least 8 characters.");
    return;
  }
  if (!["1", "2c"].includes(snmp.version)) die(`SNMP_VERSION must be 1, 2c or 3 (got "${snmp.version}").`);
  if (!snmp.community) die(`SNMP_VERSION=${snmp.version} needs SNMP_COMMUNITY.`);
}

/** One HTTP call that carries the session cookie and surfaces the server's message. */
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: call.cookie ?? "",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const message = json?.error ?? json?.detail ?? text.slice(0, 300) ?? res.statusText;
    throw new Error(`${method} ${path} -> ${res.status}: ${message}`);
  }
  return json;
}

function pad(value, width) {
  return String(value).padEnd(width).slice(0, width);
}

/* -------------------------------------------------------------------------- */

if (!PASSWORD) {
  die("Set MINEAZY_ADMIN_PASSWORD to the administrator password of this install.");
}
requireSnmpInput();

console.log(`\n  Mineazy Network — connect to real hardware`);
console.log(`  console: ${BASE}`);
console.log(`  mode:    ${DRY_RUN ? "DRY RUN (nothing will be written)" : "apply"}`);
console.log(`  SNMP:    v${snmp.version}${snmp.version === "3" ? ` user "${snmp.username}"` : " (community)"}`);
console.log(`  categories: ${CATEGORIES.join(", ")}\n`);

// 1. Sign in. The login response sets the HttpOnly session cookie.
let login;
try {
  login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
} catch (error) {
  die(`The console is not reachable at ${BASE}: ${error.message}`);
}
if (!login.ok) {
  die(`Sign-in failed (${login.status}). Check MINEAZY_ADMIN_USER / MINEAZY_ADMIN_PASSWORD.`);
}
const cookie = login.headers.getSetCookie?.()[0]?.split(";")[0] ?? "";
if (!cookie) die("Sign-in succeeded but no session cookie was returned.");
call.cookie = cookie;

const me = await call("GET", "/api/auth/me");
if (me?.user?.role !== "administrator") {
  die(`This script needs an administrator (signed in as "${me?.user?.role ?? "unknown"}").`);
}

// 2. The health check tells us whether the collector will poll real devices.
const health = await call("GET", "/api/health");
if (health.demoMode) {
  console.log(
    "  ! MINEAZY_DEMO=1 is set. The simulator will overwrite what this script configures.\n" +
      "    Unset it and restart before using a real network.\n"
  );
}
if (health.collectorMode !== "real") {
  console.log(
    `  ! collector.mode is "${health.collectorMode}". Nothing will be polled.\n` +
      '    Set Settings -> Collector mode to "real".\n'
  );
}

// 3. Store the credential, unless one with this name already exists.
const { credentials } = await call("GET", "/api/credentials");
const existing = credentials.find((c) => c.name.toLowerCase() === CREDENTIAL_NAME.toLowerCase());

if (existing) {
  console.log(`  = credential "${CREDENTIAL_NAME}" already exists (v${existing.version}) — reusing it.`);
  console.log(`    To change the secret, delete it in the console/API and run this again.\n`);
} else if (DRY_RUN) {
  console.log(`  + would create SNMPv${snmp.version} credential "${CREDENTIAL_NAME}"\n`);
} else {
  await call("POST", "/api/credentials", {
    name: CREDENTIAL_NAME,
    version: snmp.version,
    community: snmp.community,
    username: snmp.username,
    authProtocol: snmp.authProtocol,
    authKey: snmp.authKey,
    privProtocol: snmp.privProtocol,
    privKey: snmp.privKey,
  });
  console.log(`  + created SNMPv${snmp.version} credential "${CREDENTIAL_NAME}"\n`);
}

// 4. What "the internet" means for this site. The defaults are 1.1.1.1 and
//    9.9.9.9, which a locked-down site often drops — and then every router
//    honestly reports NO_INTERNET while the internet works fine.
const gateway = args.get("gateway");
const internet = args.get("internet");
const settingsPatch = {};

if (gateway) {
  settingsPatch["monitor.gatewayTargets"] = [
    { name: "Default gateway", host: gateway, type: "icmp" },
  ];
}
if (internet) {
  const hosts = internet.split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) die("--internet needs at least one host.");
  settingsPatch["monitor.internetTargets"] = hosts.map((host) => {
    const isHttp = /^https?:\/\//i.test(host);
    return { name: isHttp ? "Internet HTTPS" : host, host, type: isHttp ? "http" : "icmp" };
  });
}
if (Object.keys(settingsPatch).length > 0) {
  const names = Object.keys(settingsPatch).join(", ");
  if (DRY_RUN) {
    console.log(`  + would set ${names}\n`);
  } else {
    await call("PATCH", "/api/settings", { settings: settingsPatch });
    console.log(`  + set ${names}\n`);
  }
}

// 5. Point every infrastructure device at SNMP and bind it to that credential.
const { devices } = await call("GET", "/api/devices");
const candidates = devices.filter(
  (device) => CATEGORIES.includes(device.category) && (device.mgmtIp ?? "").trim().length > 0
);
const skipped = devices.filter(
  (device) => CATEGORIES.includes(device.category) && !(device.mgmtIp ?? "").trim().length
);

if (candidates.length === 0) {
  console.log("  No device with a management address in those categories.");
  console.log("  Run a discovery sweep first (Discovery -> Run discovery), or add devices by hand.\n");
}

/**
 * Bind the credential in the device's Notes as `snmp=<name>`.
 *
 * The collector picks the credential named there and otherwise falls back to
 * the FIRST credential in the table. Tagging is what keeps a multi-credential
 * estate honest, so it is written with the rest of the notes preserved.
 */
function notesFor(current) {
  const rest = (current ?? "")
    .replace(/(^|\s)snmp\s*=\s*[\w.-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest ? `snmp=${CREDENTIAL_NAME} ${rest}` : `snmp=${CREDENTIAL_NAME}`;
}

console.log(`  ${pad("DEVICE", 26)} ${pad("CATEGORY", 14)} ${pad("ADDRESS", 17)} CHANGE`);
console.log(`  ${"-".repeat(26)} ${"-".repeat(14)} ${"-".repeat(17)} ${"-".repeat(30)}`);

let changed = 0;
for (const device of candidates) {
  const alreadySnmp = device.monitorMethod === "snmp";
  const desiredNotes = notesFor(device.notes);
  const notesOk = (device.notes ?? "").includes(`snmp=${CREDENTIAL_NAME}`);
  const patch = {};
  if (!alreadySnmp) patch.monitorMethod = "snmp";
  if (!notesOk) patch.notes = desiredNotes;
  if (!device.monitoringEnabled) patch.monitoringEnabled = true;

  const what = Object.keys(patch).length === 0
    ? "already SNMP, already bound"
    : [
        alreadySnmp ? null : "icmp -> snmp",
        notesOk ? null : `notes += snmp=${CREDENTIAL_NAME}`,
        device.monitoringEnabled ? null : "monitoring on",
      ]
        .filter(Boolean)
        .join(", ");

  console.log(
    `  ${pad(device.name, 26)} ${pad(device.category, 14)} ${pad(device.mgmtIp, 17)} ${what}`
  );

  if (Object.keys(patch).length === 0) continue;
  changed += 1;
  if (DRY_RUN) continue;
  await call("PATCH", `/api/devices/${device.id}`, patch);
}

if (skipped.length > 0) {
  console.log(`\n  ${skipped.length} device(s) in those categories have no management address:`);
  for (const device of skipped) console.log(`    - ${device.name} (${device.category})`);
}

/* -------------------------------------------------------------------------- */

console.log(`
  ${DRY_RUN ? "Would update" : "Updated"} ${changed} device(s).

  Next, in the console:

    1. Discovery -> Authorised scan ranges -> add the subnets your switches
       and hosts live on (for example 192.168.1.0/24), then "Run discovery".
       Nothing outside those ranges is ever probed.
    2. Settings -> set "Collector mode" to real.
    3. Live Map -> wait one poll interval (60s by default). Switches that
       answer SNMP grow ports; links appear as LLDP/CDP/FDB evidence arrives.
    4. Cables that discovery cannot infer (an unmanaged switch in the middle,
       a WAN hand-off) are added with POST /api/connections:
         { "localDeviceId": 3, "localPortId": 12,
           "remoteDeviceId": 4, "remotePortId": 7,
           "type": "uplink", "cableId": "A-114" }

  If you did not pass --gateway / --internet, do it now. The defaults are
  1.1.1.1 and 9.9.9.9; a site that filters ICMP to them reports NO_INTERNET
  (purple) everywhere while the internet is actually fine.

  If a switch now shows OFFLINE, it is very likely the SNMP credential:
  with monitorMethod=snmp there is no ICMP fallback, so a failed SNMP poll
  counts as unreachable. Check its evidence sentence on the device page.
`);
