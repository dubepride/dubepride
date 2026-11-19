#!/usr/bin/env node
/**
 * ============================================================================
 *  bind-demo-devices.js — lend an existing handset to another employee
 * ============================================================================
 *
 *  Device binding normally happens once, when an employee first signs in on a
 *  phone. Ethan and Tatenda never completed that login, so they have no
 *  device and cannot be seeded or demoed. This script copies an ALREADY BOUND
 *  handset's identity onto them — no new hardware, nothing invented.
 *
 *    node scripts/bind-demo-devices.js                  show bindings + proposal
 *    node scripts/bind-demo-devices.js --apply          apply the proposal
 *    node scripts/bind-demo-devices.js --from Pride --to Ethan --apply
 *    node scripts/bind-demo-devices.js --unbind Ethan --apply
 *
 *  IMPORTANT
 *    The login route only checks that an EMPLOYEE keeps their own device; it
 *    does not stop two employees sharing one phone. Sharing therefore works,
 *    but it is a demo convenience, not a security model. The supervisor
 *    report discloses it, and `--unbind` reverses it.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const ROOT = path.resolve(__dirname, "..");

/** Employees who should borrow a handset, and whose handset they borrow. */
const DEFAULT_MAP = [
  { to: "ethan", from: "pride" },
  { to: "tatenda", from: "makonese" },
];

function parseArgs(argv) {
  const args = { apply: false, force: false, from: null, to: null, unbind: null, db: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--force") args.force = true;
    else if (a === "--from") args.from = String(argv[++i] || "");
    else if (a === "--to") args.to = String(argv[++i] || "");
    else if (a === "--unbind") args.unbind = String(argv[++i] || "");
    else if (a === "--db") args.db = path.resolve(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/bind-demo-devices.js [--apply] [--from <name>] [--to <name>] [--unbind <name>] [--force] [--db <file>] [--json]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function loadEnvLocal() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function resolveTarget(args) {
  if (args.db) return { url: `file:${args.db}`, authToken: undefined, label: args.db };
  const remoteUrl = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_DATABASE_URL;
  const remoteToken = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN;
  if (remoteUrl) {
    let label = remoteUrl;
    try {
      const u = new URL(remoteUrl);
      label = `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      /* keep raw */
    }
    return { url: remoteUrl, authToken: remoteToken, label };
  }
  const file = path.resolve(ROOT, process.env.TA_DB_PATH || "data/ta-bridge.db");
  return { url: `file:${file}`, authToken: undefined, label: file };
}

async function queryAll(client, sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows.map((row) => ({ ...row }));
}

function label(e) {
  const device = (e.Bound_Device_ID || "").trim();
  return `${e.Full_Name} (${e.ERP_User_ID})${device ? ` → ${e.Bound_Device_Name || device}` : " → UNBOUND"}`;
}

function matchOne(employees, needle) {
  const text = String(needle || "").toLowerCase().trim();
  if (!text) return null;
  const hits = employees.filter(
    (e) =>
      e.Full_Name.toLowerCase().includes(text) ||
      String(e.ERP_User_ID || "").toLowerCase().includes(text)
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const exact = hits.find((e) => e.Full_Name.toLowerCase().startsWith(text));
    if (exact) return exact;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvLocal();

  const target = resolveTarget(args);
  const client = createClient({ url: target.url, authToken: target.authToken });

  try {
    const employees = await queryAll(
      client,
      `SELECT Employee_ID, ERP_User_ID, Full_Name, Status, Branch_Name,
              Bound_Device_ID, Bound_Device_Name, Bound_Device_At
         FROM Employees
        ORDER BY Employee_ID`
    );

    // ── list mode ────────────────────────────────────────────────
    if (!args.from && !args.to && !args.unbind) {
      console.log(`Source: ${target.label}`);
      console.log("");
      console.log("Current bindings:");
      for (const e of employees) console.log(`  ${label(e)}`);
      console.log("");

      const proposal = [];
      for (const rule of DEFAULT_MAP) {
        const to = matchOne(employees, rule.to);
        const from = matchOne(employees, rule.from);
        if (!to || !from) {
          proposal.push({ rule, error: `could not match "${!to ? rule.to : rule.from}"` });
          continue;
        }
        if ((to.Bound_Device_ID || "").trim()) {
          proposal.push({ rule, to, from, error: "already has a device" });
          continue;
        }
        if (!(from.Bound_Device_ID || "").trim()) {
          proposal.push({ rule, to, from, error: "donor has no device" });
          continue;
        }
        proposal.push({ rule, to, from, error: null });
      }

      console.log("Proposed demo bindings (nothing written):");
      for (const p of proposal) {
        if (p.error) {
          console.log(`  ! ${p.rule.to} ← ${p.rule.from}: ${p.error}`);
        } else {
          console.log(
            `  - ${p.to.Full_Name} borrows ${p.from.Full_Name}'s ${p.from.Bound_Device_Name || p.from.Bound_Device_ID}`
          );
          console.log(`      device id: ${p.from.Bound_Device_ID}`);
        }
      }
      console.log("");
      console.log("Run with --apply to write, or --from/--to to choose different pairs.");
      return;
    }

    // ── unbind ───────────────────────────────────────────────────
    if (args.unbind) {
      const employee = matchOne(employees, args.unbind);
      if (!employee) {
        console.error(`No single employee matches "${args.unbind}".`);
        process.exit(1);
      }
      if (!(employee.Bound_Device_ID || "").trim()) {
        console.log(`${employee.Full_Name} is already unbound.`);
        return;
      }
      console.log(`Will unbind ${label(employee)}`);
      if (!args.apply) {
        console.log("Re-run with --unbind <name> --apply to write.");
        return;
      }
      await client.execute({
        sql: `UPDATE Employees
                 SET Bound_Device_ID = NULL, Bound_Device_Name = NULL, Bound_Device_At = NULL
               WHERE Employee_ID = ?`,
        args: [employee.Employee_ID],
      });
      console.log(`Unbound ${employee.Full_Name}.`);
      return;
    }

    // ── explicit or default pair ─────────────────────────────────
    const pairs = [];
    if (args.from && args.to) {
      pairs.push({ from: args.from, to: args.to });
    } else {
      for (const rule of DEFAULT_MAP) pairs.push({ from: rule.from, to: rule.to });
    }

    const plan = [];
    for (const pair of pairs) {
      const to = matchOne(employees, pair.to);
      const from = matchOne(employees, pair.from);
      if (!to) {
        plan.push({ ok: false, message: `no employee matches "${pair.to}"` });
        continue;
      }
      if (!from) {
        plan.push({ ok: false, message: `no employee matches "${pair.from}"` });
        continue;
      }
      if (to.Employee_ID === from.Employee_ID) {
        plan.push({ ok: false, message: `${to.Full_Name} cannot borrow from themselves` });
        continue;
      }
      if ((to.Bound_Device_ID || "").trim() && !args.force) {
        plan.push({
          ok: false,
          message: `${to.Full_Name} already has ${to.Bound_Device_Name || to.Bound_Device_ID} (use --force to replace)`,
        });
        continue;
      }
      if (!(from.Bound_Device_ID || "").trim()) {
        plan.push({ ok: false, message: `${from.Full_Name} has no bound device to lend` });
        continue;
      }
      plan.push({ ok: true, to, from });
    }

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            source: target.label,
            mode: args.apply ? "apply" : "dry-run",
            plan: plan.map((p) =>
              p.ok
                ? {
                    to: p.to.Full_Name,
                    toNumber: p.to.ERP_User_ID,
                    from: p.from.Full_Name,
                    deviceId: p.from.Bound_Device_ID,
                    deviceName: p.from.Bound_Device_Name,
                  }
                : { error: p.message }
            ),
          },
          null,
          2
        ) + "\n"
      );
      if (!args.apply) return;
    }

    console.log(`Source: ${target.label}`);
    console.log("");
    let applicable = 0;
    for (const p of plan) {
      if (!p.ok) {
        console.log(`  ! ${p.message}`);
        continue;
      }
      applicable += 1;
      console.log(
        `  - ${p.to.Full_Name} (${p.to.ERP_User_ID}) borrows ${p.from.Bound_Device_Name || p.from.Bound_Device_ID} from ${p.from.Full_Name}`
      );
      console.log(`      device id: ${p.from.Bound_Device_ID}`);
    }
    console.log("");

    if (!applicable) {
      console.log("Nothing to do.");
      return;
    }
    if (!args.apply) {
      console.log("Re-run with --apply to write these bindings.");
      return;
    }

    const now = Date.now();
    const tx = await client.transaction("write");
    try {
      for (const p of plan) {
        if (!p.ok) continue;
        await tx.execute({
          sql: `UPDATE Employees
                   SET Bound_Device_ID = ?, Bound_Device_Name = ?, Bound_Device_At = ?
                 WHERE Employee_ID = ?`,
          args: [p.from.Bound_Device_ID, p.from.Bound_Device_Name, now, p.to.Employee_ID],
        });
      }
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        /* already rolled back */
      }
      throw err;
    }

    console.log(`Bound ${applicable} employee(s).`);
    console.log("");
    console.log("Note: these employees now share a handset with its original owner.");
    console.log("Reverse with: node scripts/bind-demo-devices.js --unbind <name> --apply");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("Bind failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
