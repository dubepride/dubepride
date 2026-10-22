# Discovery

Discovery is how Mineazy Network learns that a device exists and how it is
wired to everything else.

There are three mechanisms, and they all feed the same inventory:

1. **Passive** — what the switches already know: LLDP/CDP neighbours, the MAC
   forwarding table and the ARP cache.
2. **Active** — a rate-limited sweep of the ranges an administrator has
   explicitly authorised.
3. **SNMP** — reading a managed device tells you what it is, which interfaces
   it has, and which ports carry which traffic.

Every device records **how it was found** (`Discovery_Source`) and **how sure
the classifier is** (`Classification_Confidence`), so an operator can always
tell a confirmed switch from a guess.

---

## 1. The authorisation rule

> **Discovery only ever touches ranges that an administrator has registered.**

This is not a guideline in the documentation — it is a check in the code
(`src/lib/net/discovery.ts`, `isAddressAuthorised`). The check runs **per
address**, immediately before the packet is sent, not per range before the
sweep starts. Even a bug in the range expansion cannot leak a probe outside
the authorised space.

There is no "scan the internet" option, and there is no way to enter an
address that is not covered by a registered range.

### Registering a range

**Discovery → Authorised ranges → Add range**

| Field | Meaning |
| --- | --- |
| CIDR | The range, e.g. `192.168.10.0/24`. A bare address is treated as a `/32`. |
| Description | What the range is, e.g. "Server VLAN". |
| Enabled | Switch a range off without deleting it. |

The Discovery screen also suggests the `/24` networks the monitoring host is
itself attached to. Those are suggestions only — you still have to add them
explicitly.

### The safety limits

| Limit | Value | Where |
| --- | --- | --- |
| Maximum addresses per sweep | 65,536 | `MAX_SCAN_HOSTS` in `lib/net/discovery.ts` |
| Maximum sweep duration | 120 s | `maxDurationMs` |
| Default rate limit | 50 probes/second | `discovery.rateLimitPerSecond` |
| Per-probe timeout | 1,000 ms | `timeoutMs` |

A sweep that hits the address ceiling is reported as **truncated** in the job
summary — it is never silently presented as a complete scan.

The rate limit is a *ceiling*, not a target: the sweeper waits so that the
probe rate never exceeds the configured value, and it counts the probe time
towards the interval so a slow network does not cause a burst.

---

## 2. The active sweep

**Discovery → Run sweep**

For every authorised address, in order:

1. **ICMP probe** — a `ping` with the configured timeout.
2. **TCP probe** (only if TCP ports are configured and the ping failed) —
   a connection attempt against the management ports.

A host that answers either way is recorded with the method that worked and
the round-trip latency.

Each hit becomes a device record with `Discovery_Source = 'active_scan'`. The
device is created with `Monitoring_Enabled` off until somebody decides it
should be monitored, and its `Health_State` is `UNMONITORED` — not `ONLINE`.
A host that has been *seen* is not a host that has been *verified*.

### Tuning the rate limit

```bash
# via the API (an administrator or operator session is required)
curl -X POST http://localhost:3100/api/settings \
  -H 'content-type: application/json' \
  -d '{"key":"discovery.rateLimitPerSecond","value":"20"}'
```

Lower it on a network that must not be disturbed. Raise it only if you know
the target can take it — 50/second is already a modest load.

---

## 3. Passive discovery

### LLDP and CDP

The collector reads the neighbour tables of every managed switch:

* **LLDP** (`LLDP-MIB`) — the open standard, supported by most enterprise
  switches, access points and servers with a management agent.
* **CDP** (`CISCO-CDP-MIB`) — Cisco's proprietary equivalent, used when LLDP
  is not available.

A neighbour sighting gives the console three things: the **remote system
name**, the **remote port**, and the **local port** the neighbour was seen
on. That is enough to build a topology edge with a known port at each end.

### The MAC forwarding table (FDB)

`dot1dTpFdbAddress` / `dot1qTpFdbAddress` list which MAC address was last
seen on which bridge port. This tells the console **which switch port a
device is plugged into**, even for a device that does not answer SNMP and
does not send LLDP.

### The ARP cache

Two sources, both read:

* **From the switch** (`ipNetToMediaPhysAddress` + `ipAdEntAddr`) — the
  switch's own ARP table, which is the more useful one because it tells you
  which *port* the address was seen on.
* **From the monitoring host** (`ip neigh show` / `arp -a`) — the operating
  system's neighbour table. This one tells you what the *host* has seen, not
  what the network looks like.

The ARP job on the Discovery screen reads the host table and creates devices
with `Discovery_Source = 'arp'`. It is a read-only operation — nothing is
sent.

### How a link becomes an edge

An edge is created when the console can name **both ends**. In order of
confidence:

| Source | Confidence | How |
| --- | --- | --- |
| `lldp` | 0.95 | The switch reports the neighbour's system name and port. |
| `cdp` | 0.90 | The same, via CDP. |
| `fdb` | 0.75 | A MAC seen on a port, correlated with an ARP entry. |
| `manual` | 1.00 | An administrator drew the connection by hand. |
| `simulated` | — | The demo estate. Always labelled. |

A connection also stores its **evidence** — the sentence that explains why the
console believes the two devices are connected — and a `Verified` flag for
the cases where both ends agree.

### Correlating the two directions

When the console sees *switch A → device B* on port 5, and separately
*switch B → device A* on port 3, those are the same cable. The collector
merges them into one connection with both ends filled in, rather than
creating two half-edges.

---

## 4. Classification

Discovery rarely produces a device type directly. It produces a hostname, a
MAC address, an `sysDescr`, an object ID, a neighbour platform string and a
list of interface names. `src/lib/net/classify.ts` turns that evidence into a
category and says how sure it is.

The categories are:

`gateway` · `router` · `switch` · `access_point` · `firewall` · `server` ·
`workstation` · `printer` · `camera` · `iot` · `internet` · `unknown`

Rules of thumb:

* **LLDP/CDP platform strings** are the strongest signal — "cisco WS-C2960" is
  a switch.
* **The interface table** is the next strongest — a device with 24 physical
  Ethernet interfaces is a switch; a device with one is a host.
* **The OUI** of the MAC address is a weak hint. The table is deliberately
  small; an unknown OUI contributes *no* evidence rather than a wrong guess.
* **The hostname** is the weakest — "router1" is a hint, "printer" is a
  hint, but neither is proof.

The confidence levels are `high`, `medium`, `low` and `unknown`. The device
detail screen shows the exact evidence sentence, so a guess is always
inspectable.

### Your labels are never overwritten

Two flags protect manual work:

* `Name_Locked` — you renamed the device, so discovery will not replace your
  name with the SNMP `sysName`.
* `Category_Locked` — you set the category by hand, so classification will
  not override it.

Both are set when you edit a device in the console. The collector updates
everything *else* — addresses, ports, counters, state — but leaves your
naming decisions alone.

---

## 5. Discovery jobs

Every job is recorded in `Discovery_Jobs`:

| Column | Meaning |
| --- | --- |
| `Kind` | `sweep` or `arp`. |
| `Scope` | The ranges the job was allowed to touch. |
| `Started_At` / `Finished_At` | The job's duration. |
| `Status` | `running`, `completed` or `failed`. |
| `Summary` | The one-line result, e.g. "254 address(es) scanned, 11 responded, 11 new device(s) added." |
| `Error` | The failure message, if it failed. |

Jobs also appear in **Event History** and the run itself is written to the
**audit log** with the operator's username.

---

## 6. Discovery and the collector

Discovery and monitoring are separate jobs, and it is worth knowing which is
which:

| | Discovery | The collector |
| --- | --- | --- |
| Triggered by | You, on the Discovery screen | The clock, every poll interval |
| Sends packets | Yes — a rate-limited sweep | Yes — SNMP and ICMP/TCP probes |
| Writes | Devices, connections | Observations, samples, states, incidents |
| Bounded by | The authorised ranges | The device list and the configured methods |

The collector polls the devices that already exist in the inventory. It does
not sweep. So a device that is never discovered is never monitored — but a
device that is discovered is monitored automatically from then on, according
to its own `Monitoring_Enabled` flag and poll interval.

---

## 7. Permissions

| Action | Required capability | Roles |
| --- | --- | --- |
| View the authorised ranges | `can_view_topology` | all three |
| Add / edit / delete a range | `can_run_discovery` | administrator, operator |
| Run a sweep or an ARP job | `can_run_discovery` | administrator, operator |
| View the event and audit history | `can_view_reports` | all three |

A **Viewer** cannot run discovery. This is enforced server-side on every
route — the buttons are hidden *and* the API refuses the request.

---

## Next

* [snmp.md](snmp.md) — the passive data that makes the topology accurate.
* [users-and-roles.md](users-and-roles.md) — who may scan what.
* [troubleshooting.md](troubleshooting.md#discovery-problems) — when a sweep
  finds nothing.
