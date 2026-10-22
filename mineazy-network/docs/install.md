# Installing Mineazy Network

Mineazy Network is a single Node.js application. It runs on the machine that
sits inside your network — the one that can reach your switches, your
gateways and your endpoints. Nothing is sent off-site.

There are three supported ways to install it:

| Method | Best for |
| --- | --- |
| [Bare Node.js](#1-bare-nodejs) | A workstation or a small always-on server you administer by hand. |
| [Docker Compose](#2-docker-compose) | A small server or a NAS. Two containers, one volume. |
| [systemd](#3-systemd-linux) | A Linux server that should survive reboots and start before the network is up. |

---

## Before you start

### Requirements

| | Minimum | Notes |
| --- | --- | --- |
| Node.js | 20.11 | Tested on Node 22 LTS. Node 20 is the floor because the build uses the modern `node --test` runner with glob support. |
| npm | 10 | Ships with Node 20+. |
| Disk | ~400 MB | `node_modules` plus the SQLite file. The database grows slowly; a large estate is a few tens of MB. |
| Network | Reach to the devices you want to monitor | SNMP (UDP 161), ICMP and the management ports you configure. |

### Ports the console uses

| Port | Protocol | Who connects |
| --- | --- | --- |
| 3100 | TCP | Your browser, to the console. |
| — | UDP 161 (outbound) | The collector, to your switches. |
| — | ICMP (outbound) | The collector, to the devices it probes. |

The console is the only thing that needs an inbound firewall rule, and only if
you want to reach it from another machine. The collector only makes *outbound*
requests.

### Privileges

Two operations need elevated rights on the monitoring host:

* **ICMP probes** — `ping` needs raw sockets. On Linux that means either
  running as root or granting the binary the `cap_net_raw` capability. On
  Windows, run the terminal as Administrator, or let the ICMP probe fail and
  rely on TCP probes instead (the collector falls back automatically).
* **The neighbour table** — reading `ip neigh` / `arp -a` needs no special
  rights.

Neither is required for SNMP-only monitoring of switches.

---

## 1. Bare Node.js

### 1.1 Get the code and install the dependencies

```bash
cd mineazy-network
npm ci          # or: npm install
```

### 1.2 Configure it

Every environment variable is optional. Copy the template and edit it:

```bash
cp .env.example .env
```

At minimum, on a real install, set these two:

```dotenv
# A long random string. Encrypts the SNMP credentials at rest.
MINEAZY_SECRET_KEY=<32+ random characters>

# A long random string. Signs the session cookie.
MINEAZY_SESSION_SECRET=<32+ random characters>
```

Generate them with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Do not skip `MINEAZY_SESSION_SECRET` in production.** Without it the
> session cookie is signed with a key that is visible in the source. Anyone
> who can read the source can forge a session. The console warns about this
> on the Settings screen.

If you leave `MINEAZY_SECRET_KEY` empty, a random key is generated once and
stored in `data/secret.key` (mode `0600` on POSIX). That keeps a local install
working without shipping a secret, but **back up that file together with the
database** — see [backup-and-restore.md](backup-and-restore.md). If it is lost,
the stored SNMP credentials can no longer be decrypted.

### 1.3 First start

```bash
npm run build
npm start
```

The console listens on <http://localhost:3100>.

On the very first start the application creates the `admin` account:

* If `MINEAZY_ADMIN_PASSWORD` is set, that is the password.
* If it is empty, a **one-time random password** is printed to the server
  console:

  ```
  [setup] The administrator account was created with a ONE-TIME RANDOM password:
  [setup]     username: admin
  [setup]     password: xxxxxxxxxxxx
  ```

That password is printed **once**. If you lose it, see
[troubleshooting.md](troubleshooting.md#i-locked-out-of-the-console).

### 1.4 The collector

Monitoring has to keep running when nobody has a browser open, so the
collector is a separate process. Run it as its own service:

```bash
npm run collector
```

Two ways to run it:

| Mode | How | When to use |
| --- | --- | --- |
| **Standalone** (recommended) | `npm run collector` in its own service/process | Production. The collector survives a console restart and can be given its own resource limits. |
| **In-process** | Set `MINEAZY_INLINE_COLLECTOR=1` (the default in demo mode) | Development, or a single-container install. `src/instrumentation.ts` starts it when the Next.js server boots. |

**Never run both at the same time.** A pid-based lock file
(`data/collector.lock`) guarantees only one writer — the second process exits
with an explanatory message rather than double-writing the database. The lock
is pid-based and therefore only works **on one machine**; see the Docker note
below.

### 1.5 Check that it works

```bash
curl http://localhost:3100/api/health
```

```json
{"ok":true,"databaseReady":true,"adminAccountExists":true,"demoMode":false,"collectorMode":"real"}
```

* `databaseReady` — the schema was applied.
* `collectorMode` — `real`, `simulated` or `off`. This is a *setting* in the
  database, editable in **Settings**.
* The collector heartbeat appears in the navigation rail as soon as the
  collector completes its first cycle.

---

## 2. Docker Compose

### 2.1 Prepare

```bash
cp .env.example .env
# Fill in MINEAZY_SECRET_KEY and MINEAZY_SESSION_SECRET as described above.
```

### 2.2 Build and start

```bash
docker compose up -d --build
docker compose logs -f collector
```

The console is published on <http://localhost:3100>.

### 2.3 What the compose file does

Both services run the **same image**:

| Service | Command | Role |
| --- | --- | --- |
| `console` | `npm run start` | The web console and the JSON API. Published on port 3100. |
| `collector` | `npm run collector` | The monitoring engine. Not published. |

They share one volume, `mineazy-data`, mounted at `/app/data`. It holds:

* `mineazy.db` — the SQLite database (plus its `-wal` and `-shm` files).
* `secret.key` — the generated encryption key, if you did not set
  `MINEAZY_SECRET_KEY`.
* `collector.lock` — the single-writer lock.

The collector container gets `cap_add: NET_RAW` so the ICMP probe can open a
raw socket.

> ### ⚠️ Run exactly one collector
>
> The single-writer lock compares process ids. Two containers have **separate
> pid namespaces**, so the lock cannot see the other container and will not
> stop a second collector. Two collectors would double-count traffic and
> raise duplicate incidents.
>
> The compose file therefore sets `MINEAZY_INLINE_COLLECTOR=0` on the console
> and starts one dedicated collector service. If you scale the collector to
> two replicas you must scale it back to one.

### 2.4 Uninstall

```bash
docker compose down          # keeps the volume
docker compose down -v       # deletes the database too
```

---

## 3. systemd (Linux)

For a server that should come back after a reboot.

### 3.1 The console

`/etc/systemd/system/mineazy-console.service`:

```ini
[Unit]
Description=Mineazy Network console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mineazy
WorkingDirectory=/opt/mineazy-network
EnvironmentFile=/opt/mineazy-network/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 3.2 The collector

`/etc/systemd/system/mineazy-collector.service`:

```ini
[Unit]
Description=Mineazy Network collector
After=network-online.target mineazy-console.service
Wants=network-online.target

[Service]
Type=simple
User=mineazy
WorkingDirectory=/opt/mineazy-network
EnvironmentFile=/opt/mineazy-network/.env
ExecStart=/usr/bin/npm run collector
Restart=always
RestartSec=10
# The ICMP probe needs raw sockets.
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW

[Install]
WantedBy=multi-user.target
```

### 3.3 Enable

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mineazy-console mineazy-collector
sudo systemctl status mineazy-console mineazy-collector
```

`After=network-online.target` matters: the collector should start once the
network is up, otherwise its first cycle marks every device as offline and
raises a wave of incidents that then resolve.

---

## 4. Windows

```powershell
cd mineazy-network
npm ci
Copy-Item .env.example .env
npm run build
npm start
```

For the collector, open a **second** terminal in the same directory and run:

```powershell
npm run collector
```

Notes for Windows:

* The ICMP probe shells out to `ping`, which Windows requires Administrator
  rights for. Without them the ICMP probe fails and the collector falls back
  to TCP probes where they are configured.
* The neighbour table is read with `arp -a`.
* The single-writer lock uses `data/collector.lock` exactly as on POSIX.
* To run both services at boot, use Task Scheduler ("Run whether user is
  logged on or not") or NSSM, pointing at `npm.cmd run start` and
  `npm.cmd run collector` in the project directory.

---

## 5. Upgrading

```bash
git pull
npm ci
npm run build
sudo systemctl restart mineazy-console mineazy-collector
```

**Take a backup first** — see [backup-and-restore.md](backup-and-restore.md).
The schema is applied with `CREATE TABLE IF NOT EXISTS` and additive columns
are added with `ALTER TABLE … ADD COLUMN` guarded by a presence check, so an
upgrade never drops stored inventory. A downgrade is not supported: take a
backup before you upgrade, not after.

---

## 6. Where things live

| Path | What it is |
| --- | --- |
| `data/mineazy.db` | The database. |
| `data/mineazy.db-wal`, `data/mineazy.db-shm` | SQLite's write-ahead log. **Back these up too** (or checkpoint first). |
| `data/secret.key` | The generated encryption key. **Back this up too.** |
| `data/collector.lock` | The single-writer lock. Not worth backing up. |
| `.env` | Your configuration. **Never commit it.** |

Everything the application knows lives in those three files. There is no
server-side session store, no cache directory and no log file — the collector
writes its history into the database.

---

## 7. Trying it without any hardware

```bash
npm run demo:seed
MINEAZY_DB_PATH=data/mineazy-demo.db MINEAZY_DEMO=1 npm run dev
```

The demo estate is a simulated 11-device network. Every device it creates is
flagged `Simulated = 1`, every link it creates is flagged
`Source = 'simulated'`, and a purple **DEMO MODE · SIMULATED** badge stays
visible in the navigation rail. It never contacts real hardware.

The demo database is a **separate file** (`data/mineazy-demo.db`), so seeding a
demo can never contaminate a real installation.

---

## 8. Pointing it at your own network

Two steps a real deployment always needs — storing the SNMP credential and
switching discovered infrastructure from ICMP to SNMP — are API-only in this
build. `scripts/connect-network.mjs` does both through the public API, so
RBAC, validation and the audit trail behave exactly as they do for a click.

Start from a database that has never been seeded with demo data (the demo
estate would otherwise sit alongside your real devices), with `MINEAZY_DEMO`
unset:

```bash
# 1. See what it would change. Writes nothing.
MINEAZY_ADMIN_PASSWORD='...' SNMP_COMMUNITY='...' \
  npm run connect -- --dry-run

# 2. Apply it. Re-running is safe: it only fills in what is missing.
MINEAZY_ADMIN_PASSWORD='...' SNMP_COMMUNITY='...' npm run connect

# Also declare what "the internet" means for this site (important: the
# defaults are 1.1.1.1 / 9.9.9.9, which many sites filter, and then every
# router reports NO_INTERNET while the internet is fine).
MINEAZY_ADMIN_PASSWORD='...' SNMP_COMMUNITY='...' npm run connect \
  --gateway=192.168.1.1 --internet=1.1.1.1,https://example.com/health

# SNMPv3 instead of v2c:
MINEAZY_ADMIN_PASSWORD='...' SNMP_VERSION=3 SNMP_USER='mineazy' \
  SNMP_AUTH_KEY='...' SNMP_PRIV_KEY='...' npm run connect
```

On Windows, set the same names with `$env:MINEAZY_ADMIN_PASSWORD = "..."`.

What it does:

1. Signs in and refuses to continue unless the account is an administrator.
2. Warns if `MINEAZY_DEMO=1` or `collector.mode` is not `real`, because the
   simulator would overwrite the configuration.
3. Stores the credential. If one with that name already exists it is reused;
   the secret is never re-sent.
4. Switches every `switch`, `router`, `gateway`, `access_point` and `internet`
   device that has a management address to `snmp`, enables monitoring and
   binds the credential in the device's Notes as `snmp=<name>`, preserving any
   notes already there.
5. With `--gateway` / `--internet`, rewrites `monitor.gatewayTargets` and
   `monitor.internetTargets` — the two settings the console has no form for.

The tagging in step 4 is not cosmetic: the collector uses the credential named
in a device's Notes and otherwise falls back to the **first** credential in the
table. Tagging keeps a multi-credential estate correct.

Then, in the console:

1. **Discovery → Authorised scan ranges** — add the subnets your equipment
   lives on, then **Run discovery**. Nothing outside those ranges is probed.
2. **Settings → Collector mode** — set it to `real`.
3. Wait one poll interval (60 s by default). Switches that answer SNMP grow
   ports; links appear as LLDP/CDP/FDB evidence arrives.

Cables discovery cannot infer — an unmanaged switch in the middle, a WAN
hand-off — are recorded by hand:

```bash
curl -X POST http://localhost:3100/api/connections \
  -H 'content-type: application/json' -b cookie.txt \
  -d '{"localDeviceId":3,"localPortId":12,"remoteDeviceId":4,
       "remotePortId":7,"type":"uplink","cableId":"A-114"}'
```

> **A wrong credential looks like an outage.** With `monitorMethod = snmp`
> there is no ICMP fallback: a failed SNMP poll counts as unreachable, so a
> healthy switch goes OFFLINE after the failure threshold. The device page
> names the reason — read it before believing the map.

---

## Next

* [snmp.md](snmp.md) — enable SNMP on your switches.
* [discovery.md](discovery.md) — authorise the ranges that may be scanned.
* [users-and-roles.md](users-and-roles.md) — create the operator and viewer
  accounts.
* [troubleshooting.md](troubleshooting.md) — if something does not come up.
