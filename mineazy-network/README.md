# Automap

A **local-first network monitoring console**: live topology, device discovery,
per-port switch monitoring, traffic rates, fault-path analysis, incident
management and inventory — in one self-contained application that keeps
running whether or not a browser is open.

Everything lives on your own machine. The database is a single SQLite file.
There is no cloud service, no telemetry and no account to create.

---

## What it does

| Area | What you get |
| --- | --- |
| **Live map** | The estate as a graph: every device is its own node with a recognisable illustration of the equipment, every cable is a clickable edge coloured by its measured state, and the physical link state of each cable is shown separately from the health of the path. Search, filter, minimap, and positions you drag are saved. |
| **Devices** | Individual devices only — never a rolled-up "site health" number. Every device carries its state, the evidence behind it, and its discovery provenance. |
| **Switches & ports** | Per-port admin/oper state, negotiated speed, duplex, VLAN, error and discard counters, and the measured in/out rate on each interface. |
| **Fault-path analysis** | From any device, trace the upstream path to the edge. The trace names the broken segment and the blast radius below it. |
| **Incidents** | Deduplicated, correlated, acknowledged, assigned, noted and resolved. One broken cable raises **one** incident, not one per victim. |
| **Traffic** | Rates derived from counter deltas with rollover handling. Cumulative counters are never presented as speeds. |
| **Discovery** | SNMP (v3 preferred), LLDP/CDP neighbours, MAC/FDB + ARP correlation and rate-limited active sweeps — **only** inside ranges an administrator has authorised. |
| **Event history & reports** | An append-only operational log and an audit log of who changed what. |
| **Setup wizard** | Guided first run: create the administrator, point the collector at your switch, watch the estate appear. |

### The states it will not collapse

The product distinguishes nine conditions instead of a single "up / down"
flag, because they mean different things to different people:

`ONLINE` · `OFFLINE` · `DEGRADED` · `LINK_DOWN` · `NO_INTERNET` ·
`NO_TRAFFIC` · `UNKNOWN` · `UNMONITORED` · `STALE`

A switch with a dead uplink is not a broken workstation. A working LAN with no
internet is not a dead LAN. And a stale collector is **not** a dead network —
it is reported as `STALE`, with the reason spelled out.

---

## Quick start

```bash
npm install
cp .env.example .env      # optional — the app runs without it
npm run dev
```

Open <http://localhost:3100>. The first start creates an `admin` account and
prints a one-time random password to the console:

```
[setup] The administrator account was created with a ONE-TIME RANDOM password:
[setup]     username: admin
[setup]     password: xxxxxxxxxxxx
```

Set `MINEAZY_ADMIN_PASSWORD` before the first start to choose your own, or
use the **Setup** wizard at `/setup`.

### Try it with the simulated estate (no hardware needed)

```bash
npm run demo:seed        # builds a labelled demo estate in data/mineazy-demo.db
MINEAZY_DB_PATH=data/mineazy-demo.db MINEAZY_DEMO=1 npm run dev
```

The demo estate is **Starlink → Edge Router → Admin Switch → White House /
Workshop Switch → six endpoints**. Everything it produces is flagged as
simulated: devices carry `Simulated = 1`, links carry `Source = 'simulated'`,
and a purple **DEMO MODE · SIMULATED** badge sits in the navigation rail.

The demo database is a **separate file** from a live install, so seeding a
demo can never contaminate real data.

To see the fault handling work, open the Overview page and use the demo panel
to cut the uplink, then watch one critical incident appear with its blast
radius, and the devices below the cut go `OFFLINE` while everything above it
stays `ONLINE`.

---

## Verify it yourself

```bash
npm test                 # 161 tests, 44 suites, 0 failures
npm run typecheck        # tsc --noEmit — clean
npm run build            # 39/39 pages, 0 warnings
npm run demo:scenario    # 31 end-to-end checks, 0 failures
```

`npm run demo:scenario` drives the real health engine, the real incident
engine and the real traffic maths through a complete failure-and-recovery
cycle against a throwaway database, and asserts 31 things — including that
one broken cable raises **one** incident rather than one per victim, and
that the rate on a port is a delta and never a cumulative counter.

The full itemised list of what is built, what is **not**, and the exact
observations behind each claim is in
[docs/implemented-vs-pending.md](docs/implemented-vs-pending.md).

---

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server on <http://localhost:3100>. |
| `npm run build` | Production build. |
| `npm start` | Serve the production build on port 3100. |
| `npm run lint` | ESLint. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | The full test suite (`node --test` + `tsx`). |
| `npm run collector` | The monitoring engine as a standalone process. |
| `npm run connect` | Point a fresh install at real hardware: stores the SNMP credential and switches infrastructure to SNMP polling. |
| `npm run demo:seed` | Build/refresh the simulated demo estate. |
| `npm run demo:scenario` | The end-to-end acceptance scenario (31 checks). |

---

## How it runs

Mineazy Network has two processes, and they are deliberately separate:

```
┌──────────────┐        ┌───────────────┐        ┌──────────────┐
│  console     │        │   collector   │        │   devices    │
│  (Next.js)   │◀──────▶│ (SNMP/probes) │◀──────▶│  (SNMP/LLDP) │
│  port 3100   │  SQLite│  every 30 s   │        │              │
└──────────────┘        └───────────────┘        └──────────────┘
```

* **Monitoring keeps running when the browser is closed.** The collector is a
  separate OS process, not a browser session.
* **A long SNMP poll can never block a UI request.** The console answers from
  the database, not from the network.
* **Only one writer at a time.** A pid-based lock file (`data/collector.lock`)
  guarantees the in-process and standalone collectors never write together.
* **Each device has its own poll interval.** The collector wakes every 30
  seconds, but a device configured for a 300-second interval is only polled
  every tenth wake — and its freshness threshold is raised to match, so it
  is never reported `STALE` between its own polls.

For a single-process install, the collector can also run inside the web
server via `src/instrumentation.ts`. Set `MINEAZY_INLINE_COLLECTOR=0` to
disable it when you run the standalone collector.

### Backups

The database is a single SQLite file in WAL mode. **Settings → Maintenance →
Checkpoint the database** flushes the write-ahead log into the main file so
it can be copied on its own — the same thing, over the API, is:

```bash
curl -X POST http://localhost:3100/api/settings \
  -H 'content-type: application/json' \
  -d '{"action":"checkpoint"}'
```

Back up the database **and** `data/secret.key` together; without the key the
stored SNMP credentials cannot be decrypted. See
[docs/backup-and-restore.md](docs/backup-and-restore.md).

### Schema migrations

`src/lib/schema.ts` owns the schema and applies it on every start:

1. **Base tables** — the 18 tables are created if they are missing.
2. **Additive columns** — each newer column is added with `ALTER TABLE` only
   when it is absent, so an existing database is upgraded in place and its
   inventory is left untouched.
3. **Indexes** — created last, because several of them cover the added
   columns.

The whole thing is idempotent: running it against a fresh file, an existing
file or a file from an older release converges on the same schema and never
drops a row. `tests/schema.test.ts` proves all three cases.

### Stack

Next.js 16 (App Router, Cache Components) · React 19 · Tailwind CSS 4 ·
SQLite via libSQL · `@xyflow/react` for the map · `net-snmp` for SNMP ·
`node --test` for the test suite.

---

## Project layout

```
mineazy-network/
├── src/
│   ├── app/                 # Next.js routes — every page is a client component
│   │   ├── (console)/       # The signed-in console: overview, map, devices,
│   │   │                    # switches, incidents, traffic, discovery,
│   │   │                    # locations, events, reports, settings
│   │   ├── api/             # The JSON API (every handler re-checks permissions)
│   │   ├── login/  setup/   # Sign-in and the first-run wizard
│   │   └── globals.css      # Tailwind v4 theme (green / purple / black / white / red)
│   ├── collector/           # The monitoring engine
│   │   ├── main.ts          #   standalone entry point
│   │   ├── inline.ts        #   in-process entry point (Edge-safe)
│   │   ├── worker.ts        #   the real collection cycle
│   │   ├── simulator.ts     #   the labelled demo estate
│   │   └── lock.ts          #   the single-writer lock
│   ├── components/          # ConsoleShell, api helpers, shared UI
│   ├── lib/                 # Domain logic (pure where it can be)
│   │   ├── health.ts        #   evidence → state
│   │   ├── incidents.ts     #   dedupe, correlation, recovery
│   │   ├── traffic.ts       #   counter deltas → rates
│   │   ├── topology.ts      #   graph, edges, upstream traces
│   │   ├── rbac.ts          #   roles and capabilities
│   │   ├── secrets.ts       #   AES-256-GCM for stored credentials
│   │   ├── net/             #   snmp.ts, discovery.ts, probes.ts, classify.ts
│   │   └── repo/            #   the data access layer
│   └── instrumentation.ts   # The in-process collector hook
├── scripts/
│   ├── seed-demo.ts         #   build the simulated estate
│   ├── connect-network.mjs  #   point a real install at your hardware
│   └── acceptance-scenario.ts #  the end-to-end proof
├── tests/                   # 161 tests across 11 suites
├── docs/                    # install, SNMP, discovery, roles, backup,
│                            # troubleshooting, implemented-vs-pending
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Configuration

Every environment variable is optional; see `.env.example` for the full list.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MINEAZY_DB_PATH` | `data/mineazy.db` | The SQLite file. |
| `MINEAZY_DATABASE_URL` / `_TOKEN` | — | Optional remote libSQL/Turso database. |
| `MINEAZY_SECRET_KEY` | generated | Encrypts stored SNMP credentials (AES-256-GCM). |
| `MINEAZY_SECRET_KEY_FILE` | `data/secret.key` | Where the generated key is cached. |
| `MINEAZY_SESSION_SECRET` | dev key | Signs the session cookie. **Set this in production.** |
| `MINEAZY_ADMIN_PASSWORD` | random | The first administrator's password. |
| `MINEAZY_DEMO` | `0` | `1` enables the simulator and the demo controls. |
| `MINEAZY_INLINE_COLLECTOR` | demo only | `0` disables the in-process collector. |

Runtime configuration (poll intervals, thresholds, external check targets,
retention, collector mode) lives in the database and is editable in
**Settings**.

**No secret is ever sent to the browser.** SNMP community strings and v3 keys
are encrypted at rest and only ever returned as a redacted preview; password
hashes never leave the database.

---

## Docker

```bash
cp .env.example .env       # fill in MINEAZY_SECRET_KEY and MINEAZY_SESSION_SECRET
docker compose up -d --build
docker compose logs -f collector
```

The console is published on <http://localhost:3100>. Both services share the
`mineazy-data` volume, which holds the database, the generated key and the
collector lock.

> **Run exactly one collector.** The single-writer lock is pid-based and works
> on one machine. Two containers have separate pid namespaces, so the lock
> cannot see the other container — the compose file disables the in-process
> collector on the console for exactly this reason.

---

## Documentation

| Guide | Covers |
| --- | --- |
| [docs/install.md](docs/install.md) | Install on Linux, macOS and Windows; first run; systemd. |
| [docs/snmp.md](docs/snmp.md) | SNMPv3/v2c setup on common vendors, what the collector reads. |
| [docs/discovery.md](docs/discovery.md) | Authorised ranges, sweep limits, LLDP/CDP/FDB/ARP correlation. |
| [docs/users-and-roles.md](docs/users-and-roles.md) | The three roles, what each may do, how to create accounts. |
| [docs/backup-and-restore.md](docs/backup-and-restore.md) | Backing up, restoring and migrating the database. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms, causes and fixes. |
| [docs/implemented-vs-pending.md](docs/implemented-vs-pending.md) | **What is built, what is not, and the exact commands that prove it.** |

---

## Honest limits

* **Discovery only touches ranges an administrator authorises.** There is no
  "scan the internet" button, by design.
* **Traffic rates need two readings.** The first poll establishes a baseline;
  a rate appears from the second reading onwards. Where counters are not
  exposed, the console says **"Traffic unavailable"** rather than inventing a
  number.
* **SNMP needs the device to allow it.** Vendor firmware differs; if a switch
  does not answer, the console reports it as unreachable — it does not
  fabricate a port table.
* **The demo estate is simulated.** It is labelled as such everywhere it
  appears and never contacts real hardware.
* **See [docs/implemented-vs-pending.md](docs/implemented-vs-pending.md)** for
  the full, itemised list — including what is *not* built yet.

## Licence

Private project. All rights reserved.
