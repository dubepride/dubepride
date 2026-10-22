# Troubleshooting

Every symptom below is written the way it actually shows up, followed by the
cause and the fix.

---

## Contents

- [The console will not start](#the-console-will-not-start)
- [The collector will not start](#the-collector-will-not-start)
- [Everything is OFFLINE](#everything-is-offline)
- [Everything is STALE](#everything-is-stale)
- [SNMP problems](#snmp-problems)
- [Discovery problems](#discovery-problems)
- [Traffic problems](#traffic-problems)
- [The map is empty](#the-map-is-empty)
- [Incident problems](#incident-problems)
- [Authentication problems](#authentication-problems)
- [Database problems](#database-problems)
- [Docker problems](#docker-problems)

---

## The console will not start

### `EADDRINUSE: address already in use :::3100`

Something else is on port 3100 — usually a previous copy of the console.

```bash
# Linux / macOS
lsof -i :3100
# Windows
Get-NetTCPConnection -State Listen -LocalPort 3100 | Select-Object OwningProcess
```

Stop the listener (not the npm wrapper — the listener is the child process)
or start on a different port:

```bash
npx next dev -p 3200
```

### `Failed to load next.config.ts` / a module-not-found error on start

`node_modules` is incomplete or out of step with `package-lock.json`.

```bash
rm -rf node_modules
npm ci
```

### The page loads but every screen is empty and the console shows a 500

The database could not be opened or migrated. Look for the real error in the
**server** output (not the browser console):

```bash
curl http://localhost:3100/api/health
```

If `databaseReady` is `false`, check that `data/` exists and is writable:

```bash
ls -la data/
touch data/test-write && rm data/test-write
```

On Windows, a database that was copied from another machine (or restored from
a backup) may be marked read-only. Clear the flag:

```powershell
attrib -R data\mineazy.db
```

### `The collector has never reported a heartbeat`

See [The collector will not start](#the-collector-will-not-start).

---

## The collector will not start

### `Another collector is already running (lock held by pid 12345)`

The single-writer lock is doing its job. Only one collector may write.

```bash
cat data/collector.lock
ps -p 12345
```

If that process is gone, the lock is stale and can be removed:

```bash
rm -f data/collector.lock
```

> **Only remove the lock when you are certain no collector is running.**
> Two collectors double-count traffic and raise duplicate incidents.

### `The collector mode is "off"`

The collector mode is a **setting**, not an environment variable. Set it to
`real` in **Settings → General → Collector mode**, or:

```bash
curl -X PATCH http://localhost:3100/api/settings \
  -H 'content-type: application/json' \
  -d '{"settings":{"collector.mode":"real"}}'
```

The value must be one of `real`, `simulated` or `off`.

### The collector runs but nothing is monitored

Three separate switches have to be on:

| Switch | Where |
| --- | --- |
| `collector.mode` = `real` | **Settings → General** |
| `MINEAZY_INLINE_COLLECTOR` | The environment — only matters for the in-process collector. `0` disables it. |
| `Monitoring_Enabled` per device | **Devices → the device → Monitoring enabled** |

### `EACCES: permission denied` running `ping`

The ICMP probe needs raw sockets.

* **Linux** — run as root, or grant the capability:
  `sudo setcap cap_net_raw+ep "$(which ping)"`.
* **Docker** — the compose file already adds `NET_RAW`.
* **Windows** — run the terminal as Administrator.

If you cannot grant the right, configure **TCP probes** instead. The
collector falls back to TCP automatically when ICMP is unavailable.

### `net-snmp` cannot open a socket

`net-snmp` opens a UDP socket per session and closes it afterwards. On an
extremely locked-down host, check that outbound UDP is permitted.

---

## Everything is OFFLINE

The collector is running and is failing every probe. Work down this list:

### 1. Is the monitoring host actually on the right network?

```bash
ip addr        # Linux
ipconfig       # Windows
```

A monitoring host in the wrong VLAN cannot reach anything, no matter how the
configuration looks.

### 2. Does a single device answer?

```bash
ping 192.168.1.10
```

If the ping fails from the shell, it fails from the collector too. The
problem is the network, not the console.

### 3. Is the device's address right?

**Devices → the device** shows `Mgmt_IP`. If the device was discovered with
the wrong address, the collector is polling an address that does not exist.

### 4. Is the failure threshold being reached too quickly?

`OFFLINE` needs `monitor.failureThreshold` **consecutive** failures (default
3). A single dropped probe does not take a device offline — unless the poll
interval is very short and the threshold is 1.

**Settings → General → Failures before OFFLINE.**

### 5. Did the network come up after the collector?

If the collector started before the network was ready, it recorded a burst of
failures. It recovers on the next cycle. If the devices are still offline
after a few cycles, the failure is real.

---

## Everything is STALE

`STALE` means the *newest observation* is older than
`monitor.staleAfterSeconds` (default 300 s).

> **STALE is not OFFLINE.** It says "we have not heard anything recently",
> which is usually a *collector* problem rather than a *network* problem.
> This distinction is deliberate and is one of the core design decisions of
> the product.

Causes:

| Cause | Check |
| --- | --- |
| The collector stopped | The navigation rail shows "Collector: last cycle 12 minutes ago" or "never run". Start it. |
| The collector is wedged | The collector process is alive but its cycle takes too long. Restart it. |
| The poll interval is longer than the stale threshold | The freshness threshold is never shorter than **twice** the device's own poll interval, so a device on a 600-second schedule is not reported stale between its polls. If it still looks stale, the collector really has stopped for that device. |
| The database was restored to an old snapshot | The observations are old by definition. |

If the stale threshold needs to be tighter or looser for the estate as a
whole, change it here:

```bash
curl -X PATCH http://localhost:3100/api/settings \
  -H 'content-type: application/json' \
  -d '{"settings":{"monitor.staleAfterSeconds":900}}'
```

Note that this is a **floor**: raising it cannot make a device go stale
sooner than twice its own poll interval.

---

## SNMP problems

### A device does not answer SNMP at all

Test it directly, outside the console:

```bash
# v2c
snmpwalk -v2c -c <community> 192.168.1.10 1.3.6.1.2.1.1.1.0

# v3
snmpwalk -v3 -u <user> -l authPriv -a SHA -A <authpass> -x AES -X <privpass> \
  192.168.1.10 1.3.6.1.2.1.1.1.0
```

If `snmpwalk` works and the console does not:

1. The console uses the credential **attached to that device**, not the one
   you just tested. Check the device record.
2. The device's `Mgmt_IP` does not match the address you tested.
3. The device has `Monitoring_Enabled` switched off.

### `Request timeout`

The device is not answering on UDP 161 within the timeout
(`monitor.snmpTimeoutMs`, default 2000 ms).

* Increase the timeout for slow devices.
* Check the ACL on the device — it must permit the monitoring host.
* Check that a firewall is not dropping the UDP packets (a *stateless* drop
  looks exactly like a timeout).

### `Authentication failure (v3)`

* The auth protocol name does not match the device. The console accepts
  `md5`, `sha`, `sha1`, `sha224`, `sha256`, `sha384`, `sha512`.
* The priv protocol does not match. The console accepts `none`, `des`, `aes`,
  `aes128`, `aes256`, `aes256b`.
* The passphrase is shorter than the device requires (most want 8+ characters
  for auth and 8+ for privacy; AES-256 wants 32).
* The device is in `noAuthNoPriv` mode but the credential is `authPriv`.

### The port table is empty but the device answers

The device answered `sysDescr` but not `ifDescr`. The interface MIB is either
not implemented or is behind a view that excludes it. Check:

```bash
snmpwalk -v2c -c <community> 192.168.1.10 1.3.6.1.2.1.2.2.1.2
```

### The device's name keeps changing

The collector uses the SNMP `sysName` **unless** the device's name is locked.
Rename the device in the console and the name sticks — discovery will not
overwrite it.

### The traffic numbers look wrong

See [Traffic problems](#traffic-problems).

---

## Discovery problems

### A sweep finds nothing

1. **Is the range authorised?** An address outside every registered range is
   refused before the packet is sent. The job summary says how many were
   refused.
2. **Does the host reach that network?** The monitoring host must have a route
   and an interface on the target VLAN.
3. **Does the host answer ICMP?** Many firewalls drop ICMP. Configure a TCP
   probe port (the switch's management port, usually 22/161/443/80) in the
   sweep options.
4. **Is the rate limit too low?** At 1 probe/second a /24 takes over four
   minutes and may hit the 120-second duration limit.

### The sweep was truncated

The job summary says so explicitly. Either the address ceiling
(65,536) or the duration ceiling (120 s) was reached. Split the range into
smaller CIDRs and run them separately.

### A device appears with the wrong category

The classifier is a guess with a stated confidence. Open the device and look
at the evidence sentence. Set the category by hand — that locks it
(`Category_Locked`) and discovery will never override it.

### A device appears twice

Two records for one device: the console de-duplicates by address, so this
usually means the device was seen at two different addresses (a DHCP change,
or a second interface). Merge them by editing the records: keep one `Mgmt_IP`
and delete the other, or set the duplicate's `Monitoring_Enabled` off.

### Discovery found a device the operator did not expect

Check the discovery audit log (**Event History → Audit log**) for who ran the
job and when. A range that is too broad is the usual cause — narrow it.

---

## Traffic problems

### "Traffic unavailable"

This is the **correct** behaviour when the device does not expose counters.
It means the console has no counter to compute a rate from. It is not a bug.

The device must expose either the 64-bit high-capacity counters
(`ifHCInOctets` / `ifHCOutOctets`) or the 32-bit ones.

### The first sample shows no rate

A rate needs **two** readings. The first poll establishes the baseline; a
rate appears from the second poll onwards. This is why the port list is empty
of rates immediately after a device is added.

### The rate reads 0 bps but the link is busy

* The poll interval is too long and the traffic finished between samples.
* The counters are frozen (some virtualisation platforms report constant
  counters).
* The device is counting only a subset of the traffic.

### The rate spikes absurdly (tens of Gbps on a 1 Gbps port)

A counter **reset**. The collector detects a counter that went backwards and
treats it as a reset rather than a spike — the sample is stored with
`Counter_Valid = 0` and no rate is published for it. If you see the spike
persisting, the counter is genuinely wrapping, which means the device only
exposes the 32-bit counters on a fast link.

### The utilisation is wrong

Utilisation is the rate divided by the negotiated speed. If the speed is
unknown, utilisation is reported as unknown rather than as a percentage of
nothing.

---

## The map is empty

### No nodes at all

* The map shows the inventory, not the collector. If no device has been
  discovered, there is nothing to draw. Run a discovery sweep.
* Check that the API returns data:

  ```bash
  curl -b 'mineazy_session=<cookie>' http://localhost:3100/api/topology
  ```

### Nodes but no edges

The console can only draw a link when it can name **both** ends. A device
seen on its own (only an IP, no LLDP, no FDB match) has no edge.

* Enable LLDP or CDP on the switch.
* Make sure the monitoring host can reach the switch over SNMP.
* Add the connection by hand on the device page if the physical wiring is
  known.

### The graph area is blank or has no height

The React Flow canvas needs a definite height from its parent. If the panel
collapses, the browser console shows *"The parent container needs a width and
a height to render the graph"*. The console's `Panel` component supports a
`bodyClassName` for exactly this — the canvas wrapper must be
`h-full w-full` inside a panel with a fixed height.

### The nodes are in the DOM but invisible, and the map never fits itself

Check the node elements in the browser's inspector. If they carry
`visibility: hidden` and the viewport transform is stuck at
`translate(0px, 0px) scale(1)`, React Flow has lost its **node
measurements**.

React Flow measures each node's box with a `ResizeObserver` and keeps the
result on its internal node. That measurement only survives if the page
hands React Flow the **same node objects** on the next render. Rebuilding the
whole node array from scratch on every poll throws the measurements away;
the nodes fall back to `visibility: hidden`, the `ResizeObserver` does not
fire again (the element is already observed and its size never changed),
`fitView` never runs and the canvas stays blank — permanently.

The Live Map merges each polled snapshot into the previous graph instead of
replacing it (`src/app/(console)/map/page.tsx`). If you extend the map,
keep that property: reuse the previous node object when nothing changed, and
carry the last known `measured` box onto a node that really did change.

### The React Flow attribution is visible

That is intentional. Hiding React Flow's attribution is only licensed for
Pro subscribers; the MIT build has to keep the credit on screen. It is
styled to sit quietly in the corner.

---

## Incident problems

### One broken cable raised thirty incidents

It should not. The engine correlates a link failure to the upstream fault and
lists the downstream devices as the *blast radius* on the single link
incident.

If you see a flood, the correlation did not run — check that the connection
records exist for the failed link. A link that was never recorded as a
connection cannot be correlated, and each affected device raises its own
incident.

### An incident never resolves

An incident resolves when the condition that raised it clears. If the device
is still `OFFLINE` — or still `STALE` — the incident stays open. That is
correct behaviour: an unresolved condition is an open incident.

### An incident was raised for a device that is fine

The collector may have recorded a transient failure. Look at the incident's
**Evidence** — it quotes the probe results and the timestamps.

### The severity looks wrong

Severity follows the state:

| State | Severity |
| --- | --- |
| `OFFLINE`, `LINK_DOWN` | critical |
| `NO_INTERNET` | major |
| `DEGRADED`, `STALE` | minor |
| `NO_TRAFFIC`, `UNKNOWN`, `UNMONITORED`, `ONLINE` | info |

A severity can be adjusted by acknowledging and annotating the incident, but
the automatic severity always follows the table above.

---

## Authentication problems

### "Your role does not include ..."

You are signed in with a role that does not grant the capability. See
[users-and-roles.md](users-and-roles.md) for the matrix. Sign in as an
Administrator, or ask one to change your role.

Note that **a demotion takes effect immediately** — every request resolves
the account from the database, so the old session stops working at once.

### "Too many failed sign-in attempts"

Eight failed sign-ins within ten minutes trigger a lockout. Wait ten
minutes, or restart the console (the counter is in memory).

### Signed out unexpectedly

* The session lasts **12 hours**.
* `MINEAZY_SESSION_SECRET` was changed — that invalidates every session.
* The account was deactivated.
* The account was deleted.

### I forgot the administrator password

There is no password reset by email — this is a local-first product with no
mail infrastructure. Either:

1. Sign in as another Administrator and set a new password from
   **Settings → Users**.
2. If no other administrator exists, reset it directly against the database
   (stop the console first):

   ```bash
   sqlite3 data/mineazy.db "SELECT User_ID, Username, Role, Active FROM Users;"
   ```

   Then use the application's own hashing helper rather than inventing a
   hash — the format is `scrypt`, stored with a per-user salt. The simplest
   route is to create a second administrator through the setup wizard after
   clearing the `Users` table, or to restore a backup taken before the
   password was lost.

### The console warns that the session secret is the development default

Set `MINEAZY_SESSION_SECRET` in the environment and restart. Anyone who can
read the source can otherwise forge a session.

---

## Database problems

### `SQLITE_BUSY: database is locked`

Two writers are fighting. The single-writer lock prevents this on one
machine — check that `data/collector.lock` exists and that only one collector
is running.

A remote libSQL database can also be busy if another instance is writing.

### The database file is huge

Traffic samples accumulate. Check the retention settings and prune:

```bash
sqlite3 data/mineazy.db "SELECT COUNT(*) FROM Traffic_Samples;"
sqlite3 data/mineazy.db "SELECT COUNT(*) FROM Health_Observations;"
```

Then lower `retention.trafficDays` / `retention.observationDays` in
**Settings**. The collector prunes on its next cycle.

### `PRAGMA integrity_check` fails after a restore

The backup was taken while the collector was writing. Restore from a
checkpointed copy, or from a backup taken with the collector stopped. See
[backup-and-restore.md](backup-and-restore.md).

### The stored SNMP credentials cannot be decrypted

The `secret.key` does not match the database. Either the key was lost, or a
database was restored without its matching key. The credentials have to be
re-entered in **Settings → SNMP credentials**.

---

## Docker problems

### The console container starts but the port is not reachable

```bash
docker compose ps
docker compose logs console
```

Check that `ports: - "3100:3100"` is still present and that nothing else on
the host is holding port 3100.

### The collector container logs "EACCES: permission denied"

The ICMP probe cannot open a raw socket. Confirm that `cap_add: NET_RAW` is
present on the `collector` service. If your host forbids `NET_RAW`, rely on
TCP probes.

### The collector says the lock is held but no other collector is running

The lock file lives in the shared volume and its pid refers to a process
inside a *different* container. Delete it:

```bash
docker compose stop collector
docker compose run --rm --entrypoint sh console -c "rm -f /app/data/collector.lock"
docker compose start collector
```

### Two collectors are running

You scaled the `collector` service, or started the standalone collector by
hand as well. **Stop one of them.** Two collectors double-count traffic and
raise duplicate incidents. The pid-based lock cannot protect you across pid
namespaces.

### The container cannot resolve the database

The console and the collector must agree on `MINEAZY_DB_PATH`. Both are set
to `/app/data/mineazy.db` in the compose file and both mount the
`mineazy-data` volume.

---

## Getting more detail

| Where | What you get |
| --- | --- |
| The server console | Stack traces, collector cycle output, the first-run password. |
| **Event History** | Every operational event the system recorded, with timestamps. |
| **Event History → Audit log** | Every change a person made, with before/after values. |
| `/api/health` | Whether the database is ready and which collector mode is active. |
| `GET /api/overview` | The collector heartbeat and its detail string. |
| `GET /api/events` | The event log as JSON. |
| `GET /api/audit` | The audit log as JSON. |

If you are reporting a problem, the collector's `detail` string from
`/api/overview` and the last twenty lines of the server console are the two
most useful pieces of information.
