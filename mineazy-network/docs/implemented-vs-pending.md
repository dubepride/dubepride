# Implemented vs pending

This document is the honest inventory of Mineazy Network. It lists what is
**built and working**, what is **deliberately not built**, what depends on
**hardware you may not have**, and the **exact commands** that prove each
claim.

Nothing in this file is aspirational. If it says "built", there is code and a
test behind it; if it says "pending", it is not in the product and no
screenshot will show it.

---

## 1. How to verify this document

Every command below was run from the `mineazy-network/` directory on
Windows 11 with Node.js 22 and npm 10. The results quoted are the observed
output, not an expectation.

```bash
npm install
npm test                 # 153 tests, 42 suites, 0 failures
npm run typecheck        # tsc --noEmit, exit code 0
npm run build            # 39/39 pages generated, 0 warnings
npm run demo:scenario    # 31 checks passed, 0 failed
```

| Command | Observed result |
| --- | --- |
| `npm test` | `tests 153`, `suites 42`, `pass 153`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0` |
| `npm run typecheck` | No output, exit code `0` |
| `npm run build` | `✓ Compiled successfully`, `✓ Generating static pages using 7 workers (39/39)`, no warnings, no errors |
| `npm run demo:scenario` | `passed 31`, `failed 0`, `ACCEPTANCE SCENARIO PASSED — every check succeeded.` |
| `npm run lint` | No output, exit code `0` — 0 errors, 0 warnings |

### The test suite (11 files, 153 tests)

| File | Tests | What it guards |
| --- | --- | --- |
| `tests/health.test.ts` | 23 | The nine states, the evidence rules, internet failure ≠ local failure, stale ≠ dead. |
| `tests/incidents.test.ts` | 19 | Dedupe keys, correlation, blast radius, acknowledgement, recovery. |
| `tests/security.test.ts` | 17 | Credential encryption, password hashing, session forgery, the audit trail, the WAL checkpoint. |
| `tests/discovery.test.ts` | 15 | Authorised ranges only, rate limiting, MAC/FDB + ARP correlation, provenance. |
| `tests/topology.test.ts` | 17 | Graph construction, upstream path tracing, the broken segment, and the per-cable ports + physical link state that the connection inspector reads. |
| `tests/traffic.test.ts` | 14 | Counter deltas, 32-bit rollover, "unavailable" instead of a fake zero. |
| `tests/classify.test.ts` | 14 | Device classification and the confidence score. |
| `tests/rbac.test.ts` | 11 | The three roles and the ten capabilities. |
| `tests/collector.test.ts` | 10 | The collector's own traffic accounting, the heartbeat and the poll schedule. |
| `tests/secrets.test.ts` | 8 | AES-256-GCM round-trip, wrong key, tamper detection. |
| `tests/schema.test.ts` | 5 | The migrations: fresh tables, fresh columns, idempotent re-migrate, an old database upgraded in place with its inventory intact, and the indexes. |

### The end-to-end acceptance scenario

`npm run demo:scenario` drives the **real** health engine, the **real**
incident engine and the **real** traffic maths against a throwaway database
(so it can never touch a live installation). It asserts 31 things across
seven phases:

1. **Baseline** — 11 devices, 10 links, every device `ONLINE`, every link up,
   no open incidents, and port rates that are proven *not* to be the
   cumulative counter and *not* to exceed the negotiated link speed.
2. **Uplink fault** — exactly one link down, exactly **one** critical
   incident (not one per victim), the blast radius listed on it, the devices
   below the cut `OFFLINE`, the devices above it still `ONLINE`, and the
   upstream path of an affected device naming the broken segment.
3. **Dedupe** — further cycles do not create further incidents.
4. **Recovery** — every incident closes, every device returns to `ONLINE`.
5. **Internet loss** — only the boundary devices report `NO_INTERNET`, the
   rest of the network stays `ONLINE`, and there is **one** global internet
   incident rather than one per device.
6. **Recovery from the internet fault** — the incident closes, every device
   returns to `ONLINE`.
7. **History** — the event log records the state changes, the link failures
   and the recoveries.

### The HTTP surface

Checked against the production build (`npm run build && npm start`) with a
signed-in session:

| Check | Observed result |
| --- | --- |
| Console pages | **14/14** returned `200` (`/`, `/map`, `/devices`, `/devices/1`, `/switches`, `/incidents`, `/traffic`, `/discovery`, `/locations`, `/events`, `/reports`, `/settings`, `/setup`, `/login`) |
| API routes, signed in | **26/29** returned `200`; the 3 that returned `404` are the correct answer for records that do not exist in that database (`/api/credentials/1`, `/api/discovery/targets/1`, `/api/incidents/1`) |
| API routes, no session | **28** returned `401`; `/api/health` returned `200` because it is deliberately public |
| Unauthenticated console pages | `307` to `/login` — the redirect is the proxy's job |
| Browser console | **0 errors** on all 12 signed-in pages (checked at error level in a real browser) |

The API surface is 31 routes in total: 30 dynamic handlers plus the public
`/api/health`. There is no route that mutates state without a permission
check on the server.

---

## 2. What is built

### 2.1 The data model — 18 tables

`Users`, `Sites`, `Locations`, `Devices`, `Ports`, `Connections`,
`Device_Addresses`, `Health_Observations`, `Traffic_Samples`, `Incidents`,
`Events`, `Audit_Log`, `Settings`, `Scan_Targets`, `SNMP_Credentials`,
`Discovery_Jobs`, `Notification_Prefs`, `Collector_State` — created and
indexed by `src/lib/schema.ts`, applied automatically on first start.

### 2.1a Schema migrations

`src/lib/schema.ts` applies the schema in three ordered steps, on every
start:

1. `TABLES_SQL` — the base tables, created only when missing.
2. `ADDITIVE_COLUMNS` — each newer column is added with `ALTER TABLE ... ADD
   COLUMN` **only when it is absent**, so an older database is upgraded in
   place and its inventory, history and incidents survive the upgrade.
3. `INDEX_SQL` — created last, because several of the indexes cover the
   columns added in step 2 and cannot be created before them.

The migration is idempotent: a fresh file, an existing file and a file from
an older release all converge on the same schema, and no row is ever dropped.
`tests/schema.test.ts` proves all four properties — fresh tables, fresh
columns, a second migrate that changes nothing, and an old database that
gains the new columns while keeping its inventory.

> This ordering matters. The earlier single-blob implementation applied the
> indexes inside the same `CREATE TABLE` statements as the base tables, so an
> index over a column that only exists after the `ALTER TABLE` step could not
> be created at all on an upgraded database.

### 2.2 The health engine — nine states, never collapsed

`src/lib/health.ts` turns evidence into exactly one of nine states:

| State | Meaning |
| --- | --- |
| `ONLINE` | Answering and within thresholds. |
| `OFFLINE` | Consecutive failures have crossed the threshold. |
| `DEGRADED` | Answering, but something measurable is wrong (errors, discards, slow). |
| `LINK_DOWN` | The device is up but its link to the estate is down. |
| `NO_INTERNET` | The local network works; the path to the internet does not. |
| `NO_TRAFFIC` | Up and connected, but silent on the wire. |
| `UNKNOWN` | Evidence exists but is contradictory. |
| `UNMONITORED` | Deliberately not polled. |
| `STALE` | The collector has not reported recently — **the device is not declared dead**. |

A switch with a dead uplink and a dead workstation therefore produce
different states, and neither is reported as "the internet is down" unless
the external checks actually failed.

### 2.3 The incident engine

Built: dedupe keys (`connection:<id>:down`, `device:<id>:<state>`,
`network:internet:down`), severity mapping, correlation (a downstream device
is *correlated* to the broken link instead of raising its own incident),
blast-radius computation, acknowledge / note / assign / re-rate / resolve,
automatic closure on observed recovery, and an append-only event log.

Built: an audit log that records who changed what, with before/after values,
and never contains a password hash.

### 2.4 Traffic

Built: rates derived from the **delta** between two readings of the same
counter, with 32-bit rollover detection (a counter that goes backwards is
treated as a reset, not a 40 Gbps spike), per-port in/out rates, link
utilisation against the negotiated speed, device and port history, and
top-talkers. Where a device does not expose counters, the console says
**"Traffic unavailable"** rather than inventing a number.

### 2.5 Discovery

Built: SNMPv3 and SNMPv2c/v1 sessions, LLDP and CDP neighbour collection,
MAC/FDB and ARP table collection, device classification with a confidence
score, provenance recording on every discovered device, an explicit
**authorised-range** model (`Scan_Targets`), and rate limiting.

Built: the rule that discovery **never overwrites an administrator's
name or label**. A discovered device that matches an existing record fills in
the blanks; it does not rename what a human typed.

Built: the rule that discovery **never touches an address outside an
authorised range**. There is no "scan everything" button anywhere in the
product.

### 2.6 Topology and fault-path analysis

Built: the graph (one node per device, one edge per cable, no aggregates),
the live map, upstream path tracing from any device to the edge, the
identification of the broken segment on that path, and the blast radius
below it.

Built: the live feed. `/api/stream` is a Server-Sent Events endpoint that
pushes a fresh topology snapshot when something changes and pushes
immediately when the collector reports a state change, so the map reacts
within a second of a fault instead of waiting for the next poll.

Built: a map that survives its own polling. The Live Map polls every ten
seconds, and the merge into the React Flow graph preserves node identity and
the measured node box — see §6 for why that matters and what happens if it
is got wrong.

### 2.6a The health endpoint is not prerendered

`/api/health` is public — it is the endpoint a load balancer, a container
orchestrator or an operator uses to check the service. It reads no
request-time state, so Next 16 would happily **prerender it at build time**
and freeze its answer: the console would report the build machine's database
state and collector mode forever.

`src/app/api/health/route.ts` therefore calls `await connection()` from
`next/server`, which marks the route as request-time work. The build output
confirms it:

```
├ ƒ /api/health
```

(`ƒ (Dynamic)` — server-rendered on demand.) The observed response against
the running server is:

```json
{"ok":true,"databaseReady":true,"adminAccountExists":true,"demoMode":true,"collectorMode":"simulated"}
```

### 2.7 The console

All fourteen pages are built and render real data:

`Overview` · `Live Map` · `Devices` (+ device detail with identity, upstream
path and ports) · `Switches & Ports` · `Incidents` · `Traffic` ·
`Discovery` · `Locations` · `Event History` · `Reports` · `Settings` ·
`Login` · `Setup wizard`.

Built: the nine-state chips, the incident timeline, the acknowledge/note/
assign/resolve controls, the CSV exports, the settings editor, the SNMP
credential API (write-only, redacted previews — there is no form for it in the
console yet, see §6), the user manager, the
audit log viewer, the maintenance panel with the **"Checkpoint the
database"** action (a `PRAGMA wal_checkpoint(TRUNCATE)`, permission-gated
and audited), and — in demo mode only — the **demo controls** panel with
*Cut the uplink*, *Take the internet away* and *Clear all faults*.

### 2.7a The map's visual language

**Fifteen equipment illustrations, one family.** `src/components/DeviceGlyph.tsx`
draws a distinct SVG for each `DeviceCategory` — internet source, router,
gateway, managed switch (front panel with two rows of port LEDs), desktop,
laptop, printer, server, NVR, IP camera, access point, NAS, VoIP phone,
industrial unit and unknown — all on the same 64×48 grid with the same 2px
stroke, dark body fill and a single status LED. The outline colour is
deliberately neutral; the LED carries the state, so an operator recognises
the *equipment* first and its health second. The same glyph appears in the
device inventory, so a row and a node describe the same thing.

**Five cable colours, and a separate physical-link marker.**

| Wire | Meaning |
| --- | --- |
| Green | Link up, configured checks pass. Animated dashes appear only when measured counters show traffic. |
| Purple | Link up, external internet unavailable **along that path**. The cable still carries local traffic. |
| Red | Confirmed failure: a managed port reports the link down, or the endpoint failed its checks. |
| Amber (long dash) | Degraded: errors, discards, utilisation or latency beyond the threshold. |
| Grey (dotted) | Not verified. Never drawn as healthy. |

On top of the colour, an `×` is drawn at the midpoint when a managed port
reports the physical link down, and a small grey ring when no port has
confirmed it. That keeps "the cable is dead" and "the path beyond the cable
is dead" from collapsing into one signal. Port labels are **not** drawn on
the wire; hovering or selecting a cable opens an HTML pill with both ports,
the physical state and the measured rates, and the *Port labels* control can
pin them all on for a screenshot.

**The map is a tool, not a picture.** Search (name, IP, category, port or
location), health and equipment filters, minimap on/off, fit-to-screen, and
drag-to-position with `POST /api/topology` persisting the coordinates
(`Layout_X`/`Layout_Y`) and a *Reset layout* action returning to the computed
tree. Viewers cannot drag, and the write needs `can_edit_inventory`.

### 2.8 Security

Built: `scrypt` password hashing with a per-user salt; stateless
HMAC-SHA256-signed session cookies in an `HttpOnly` cookie; AES-256-GCM
encryption of SNMP community strings and v3 auth/privacy keys at rest; a
role model of Administrator / Network Operator / Viewer over ten
capabilities; a server-side permission check on **every** mutating route
(hiding a button is never the only barrier); discovery bounded to authorised
ranges; and the guarantee that no secret is ever sent to the browser.

### 2.9 The collector

Built: a standalone process (`npm run collector`) **and** an in-process
collector (`src/instrumentation.ts`) that both share the same worker code; a
pid-based single-writer lock; a heartbeat so the console can distinguish
"the collector has not reported" (`STALE`) from "the device is dead";
defensive error handling so one unreachable device never stops the cycle;
per-device poll intervals (a device configured for 300 seconds is only
polled every tenth collector cycle, and its freshness threshold is raised
to match so it is never reported `STALE` between its own polls); and three
collector modes — `real`, `simulated`, `off`.

### 2.10 Operations

Built: SQLite in WAL mode; the checkpoint action; the backup and restore
procedure; the Docker image and Compose file; `.env.example` with no
secrets in it; a systemd unit example; and seven documentation guides.

---

## 3. What is **not** built

These are real gaps. None of them is hidden behind a disabled button.

| # | Not built | Why it matters | What it would take |
| --- | --- | --- | --- |
| 1 | **Outbound notifications.** No email, webhook, Slack or PagerDuty delivery. | An incident is only noticed if somebody is looking at the console. | A delivery worker, per-user `Notification_Prefs` (the table exists but is unused), a template engine and a retry queue. |
| 2 | **SNMP traps and syslog ingestion.** Monitoring is poll-only. | A device that dies between two polls is noticed late. | A UDP trap receiver, a syslog socket, and a parser that maps trap OIDs onto devices. |
| 3 | **IPv6.** The address model is IPv4-only. | Modern dual-stack estates are not fully covered. | An address type on `Device_Addresses`, IPv6 parsing in the probe and discovery code, and ICMPv6 handling. |
| 4 | **sFlow / NetFlow / IPFIX.** Traffic comes from interface counters only. | Per-flow and per-host visibility is missing. | A flow collector, a flow-to-device mapping, and a new storage table. |
| 5 | **Inventory CSV import.** Export is built; import is not. | Migrating an existing spreadsheet is manual. | An import endpoint with column mapping, a preview/diff step and an undo. |
| 6 | **External authentication** — LDAP, Active Directory, OAuth/OIDC, SAML. | Accounts are local only. | An auth provider per directory, group-to-role mapping, and a link/claim model. |
| 7 | **Multi-factor authentication.** | A password is the only factor. | TOTP enrolment with recovery codes, or WebAuthn passkeys. |
| 8 | **High availability / clustering.** One SQLite file, one writer. | A single point of failure by design — this is a local-first product. | A different storage engine and a leader election or partitioned-ownership scheme. |
| 9 | **Alerting rules and escalation policies** beyond the built-in thresholds. | Thresholds are global settings, not per-device rules with schedules. | A rules table, a schedule model, and an escalation state machine. |
| 10 | **A mobile or offline client.** | The console is a desktop web app. | A service worker and an offline write queue, or a native client. |
| 11 | **Internationalisation.** The UI is English only. | — | A message catalogue and locale-aware formatting. |
| 12 | **Firmware and configuration management.** The console observes; it does not configure devices. | Out of scope for a monitoring product. | A write-side SNMP/CLI layer with change control. |

---

## 4. Limits that depend on your hardware

These are not bugs in the product; they are facts about what a switch will
and will not tell you.

* **SNMP must be enabled on the device.** If a switch does not answer, the
  console records it as unreachable. It never fabricates a port table, a
  neighbour list or a speed.
* **Vendor OID coverage varies.** The collector reads standard
  `IF-MIB`/`BRIDGE-MIB`/`LLDP-MIB`/`HOST-RESOURCES` objects. A vendor with
  heavy customisation may expose less than expected — the console then shows
  the fields it genuinely has and marks the rest unknown.
* **A rate needs two readings.** The first poll establishes a baseline. If
  the collector is restarted mid-window, the first rate after the restart
  waits for one more reading. That is deliberate: a counter is not a speed.
* **A device polled slowly is not stale.** The freshness threshold is never
  shorter than twice the device's own poll interval, so a device on a
  600-second schedule is not reported `STALE` just because 300 seconds have
  passed since its last reading.
* **A counter that rolls over is detected, not smoothed.** A 32-bit counter
  that wraps is treated as a reset, so that poll's rate is discarded instead
  of being shown as an absurd spike.
* **The demo estate is simulated.** Devices carry `Simulated = 1`, links
  carry `Source = 'simulated'`, and the console shows a **DEMO MODE ·
  SIMULATED** badge. The demo controls are refused entirely when
  `MINEAZY_DEMO` is not `1`, so nobody can inject a fake fault into a live
  monitoring run.
* **The single-writer lock is pid-based and works on one machine.** Two
  containers have separate pid namespaces and cannot see each other's lock.
  Run exactly one collector — the Compose file disables the in-process
  collector on the console for exactly this reason.
* **Backup the database *and* the key together.** Without `data/secret.key`
  (or `MINEAZY_SECRET_KEY`) the stored SNMP credentials are unrecoverable.
  The inventory, incidents and history survive regardless.

---

## 5. Manual validation checklist

The automated suite proves the logic. These are the checks that prove the
**console** behaves; they were performed in a real browser against the
production build.

- [x] All 14 pages return HTTP 200 and render real content.
- [x] Zero console errors on all 12 signed-in pages (checked at error level
      in a real browser).
- [x] The Live Map renders the graph at full height (measured 662 × 636 px),
      with 11 nodes and 10 edges, and no React Flow warnings.
- [x] **The map survives its own polling.** Observed over 30 seconds
      (three poll cycles) on the production build: 11 nodes, 10 edges, **0**
      nodes hidden, and the viewport transform unchanged at
      `translate(224.59px, 25.4732px) scale(0.659754)` — that is, `fitView`
      ran and the graph was not reset by the poll.
- [x] **The map renders in a hidden tab.** Opening `/map` in a background tab
      (and reloading an already-hidden one) now yields 11 nodes, 10 edges,
      **0 hidden**, with the viewport fitted at
      `translate(368.97px, 51px) scale(0.536774)` while
      `document.visibilityState === "hidden"`. Before
      `MapNodeMeasurer.tsx`, the same tab produced 0 measured nodes, 0 edges
      and viewport `translate(0px, 0px) scale(1)`.
- [x] **The map survives a fault.** With the uplink cut, the nine affected
      nodes changed state and were restyled `map-node--offline`, the broken
      link was redrawn at `stroke: rgb(255, 82, 82); stroke-width: 2.6`, and
      the canvas stayed fully visible. After *Clear all faults* the same
      eleven nodes returned to `ONLINE` and the canvas stayed visible.
- [x] **Internet failure is purple, not red.** With *Take the internet away*
      the Starlink terminal and the edge router became `NO_INTERNET` and were
      drawn with border `rgba(155, 109, 255, 0.9)` (purple), while all nine
      LAN devices stayed `ONLINE` and all ten edges stayed green. Selecting
      the router showed the exact message *"Physical link active. External
      internet connectivity checks are failing."*
- [x] **Every device carries a recognisable illustration.** Eleven demo
      devices produced **nine distinct glyphs** (`internet`, `router`,
      `switch` ×3, `desktop`, `printer`, `nas`, `nvr`, `laptop`, `camera`) on
      one shared 64×48 grid. Each glyph has a status LED in the device's
      state colour; the outline stays neutral so the equipment is recognised
      before its health is read.
- [x] **Cables are objects, not labels.** No edge renders permanent text
      (measured: `0` labels with nothing selected). Selecting the
      Starlink↔router cable showed `eth0 → wan0`, *physical link up*, 1.0 Gbps,
      216 Mbps in / 144 Mbps out, error and discard counters, discovery
      source, confidence, last observation and the evidence sentence.
- [x] **The physical link is shown separately from path health.** With the
      uplink cut, exactly **one** cable went red and carried an `×` marker
      (the cut uplink). The other nine cables stayed **green** while their
      devices showed `OFFLINE` — the screenshot-accurate version of "a device
      can be unreachable without its cable being faulty". Before this fix the
      simulator marked every port of every unreachable device as down, which
      turned the whole map red and blamed nine cables for one fault.
- [x] **Path colour is evidence-based.** With the internet removed: one
      purple cable (the internet-facing segment, both ends `NO_INTERNET`),
      nine green LAN cables, zero red cables.
- [x] **Manual positions survive.** `POST /api/topology` with a position moved
      `dev-11` from the automatic `(-210, 1168)` to `(1234, -321)`; the next
      `GET /api/topology` returned the saved coordinates. `{reset: true}`
      returned the device to the computed layout. An invalid payload was
      refused with `400 No position in the request was valid.` and the write
      is audited as `layout.update` / `layout.reset`.
- [x] **The map is filterable.** Searching `camera` left 1 of 11 devices and
      0 of 10 links on the canvas, with the counts shown; clearing the search
      restored 11 and 10. Health and equipment-type filters behave the same
      way and only hide, never mutate, the data.
- [x] **An alert deep-links to its device.** Every incident row offers
      *Show on map* → `/map?focus=<deviceId>`, which selects the device,
      traces its upstream path and fits the camera to it. Verified with the
      open incident *Link down: Edge Router ↔ Admin Switch*: its link was
      `/map?focus=2`, and opening it selected the **Edge Router** node, drew
      its trace (`Starlink Terminal → Edge Router (wan0)`) and moved the
      camera. The canvas still held all 11 nodes and 10 cables with the
      other nine devices red, so the fault context was not lost by jumping
      from the alert.
- [x] **The upstream trace works from the canvas.** Clicking *CCTV Recorder*
      produced the path
      `Starlink Terminal → Edge Router (wan0) → Admin Switch (GigabitEthernet1/0/1) → White House Switch (GigabitEthernet1/0/1) → CCTV Recorder (eth0)`
      with *The first broken segment is at device #3 (link state: down)*.
- [x] The device detail page shows identity, upstream path and ports.
- [x] **Fault → incident:** cutting the uplink produced 1 link down, 1 open
      incident, 1 critical, 2 of 11 devices `ONLINE`, and an incident titled
      `LINK DOWN: EDGE ROUTER ↔ ADMIN SWITCH` with a 9-device blast radius.
- [x] **Acknowledge:** the incident moved from `open` to `acknowledged` and
      stayed open, as designed.
- [x] **Recovery:** after clearing the fault, 0 links down, 0 open
      incidents, 11 of 11 `ONLINE`, and the incident recorded as `resolved`
      with a recovery timestamp.
- [x] **Event and audit history:** the event log recorded the state changes,
      the link failure and the recovery; the audit log recorded the sign-in
      and the acknowledgement, each with the account that made it.
- [x] **Checkpoint:** *Settings → Maintenance → Checkpoint the database*
      returned `The write-ahead log was flushed into the database file.` and
      wrote a `database_checkpoint` event.

---

## 6. Rough edges worth knowing about

* **Two setup steps are API-only: storing an SNMP credential, and changing a
  device's monitor method.** The credential API is write-only with redacted
  previews, but the console has no form for it, and the device page is
  read-only, so a discovered switch cannot be moved from ICMP to SNMP by
  clicking. `scripts/connect-network.mjs` (`npm run connect`) performs both
  through the public API, with the same RBAC and audit trail a click would
  get. This matters more than it sounds: an ICMP-only switch is monitored but
  contributes **no ports, no LLDP/FDB evidence and no cables**, so the map
  stays empty until it is switched over. A first-class settings panel is the
  obvious next UI task.
* **A device on `monitorMethod = snmp` has no ICMP fallback.** A failed SNMP
  poll is treated as unreachable, so a wrong credential, a read-only view that
  hides the interface table, or a filtered UDP/161 makes a perfectly healthy
  switch go OFFLINE after the failure threshold. The device page carries the
  reason; it is worth reading before believing the map.
* The React Flow attribution is **visible**, as the licence requires. It is
  styled subtly rather than removed; hiding it is a paid feature.
* **The Live Map keeps React Flow's node measurements alive across polls — and
  in hidden tabs.** This sounds like a detail; it is not. React Flow measures
  each node's box with a `ResizeObserver` and stores the result on its
  *internal* node. That measurement is copied back onto the object the page
  handed in **only when that object keeps its identity**. A naive
  implementation that rebuilds the whole node array on every poll therefore
  wipes every measurement, the nodes fall back to `visibility: hidden`, the
  `ResizeObserver` never fires again (the element is already observed and its
  size never changed), `fitView` never runs and the canvas stays
  **permanently blank** — with the nodes present in the DOM but invisible.
  `src/app/(console)/map/page.tsx` therefore merges each snapshot into the
  previous graph: a node whose position and payload are unchanged keeps its
  previous object, and a node that really changed carries the last known
  `measured` box onto the new object. A second, independent failure mode is a
  **hidden tab**: Chrome stops delivering `ResizeObserver` notifications to
  pages that are not visible, so a `/map` tab opened or reloaded in the
  background never measured its nodes at all.
  `src/components/MapNodeMeasurer.tsx` repairs that by calling
  `updateNodeInternals` directly from a store subscriber (not via
  `requestAnimationFrame`, which hidden tabs pause). Both bugs were found by
  watching the canvas in a real browser, not by reading the docs.
* **Purple means "link up, internet not reachable", not "failed".**
  `NO_INTERNET` is a distinct health state and it is rendered purple
  everywhere — the node border, the `StateBadge` chip and dot, the minimap and
  the Overview bar. Red is reserved for confirmed failures of the device or
  its link (`OFFLINE`, `LINK_DOWN`). Selecting a purple device shows the
  spec's explanation: *"Physical link active. External internet connectivity
  checks are failing."* This matters because the two cases demand completely
  different fixes, and colouring an ISP outage red would send an operator to
  the wrong cabinet.
* **The demo simulator no longer marks every port of an unreachable device as
  down.** It used to, which turned the whole map red on a single uplink fault
  and implied nine broken cables. A device behind a cut uplink is *unreachable
  with live ports*; only the port on the actually-cut cable goes down. Real
  SNMP hardware draws that distinction for us (a powered-off PC reports its
  switch port down; an unreachable PC does not), so the simulator now models
  it too — which is what makes the "green cable, red device" case visible in
  the demo.
* **The map's deep link reads `window.location`, not `useSearchParams`.**
  `useSearchParams()` in a client component forces the route out of the
  prerendered set (and needs a Suspense boundary in this Next.js version),
  and `/map` has no other reason to be dynamic. `useState(() => …)` reads
  `?focus=<deviceId>` once on the client; the value never affects the markup,
  so it cannot cause a hydration mismatch.
* The demo controls and the simulated estate exist only when
  `MINEAZY_DEMO=1`. In a normal install the demo API returns `403` and the
  panel is not rendered.
* The collector writes to the same SQLite file as the console. This is safe
  (WAL mode) but means a very large estate will eventually want a
  different storage engine — see gap #8.
* The build emits 39 static/partial-prerendered pages and 31 API routes.
  There is no test coverage of the rendered React components themselves;
  the coverage is of the domain logic, the API and the end-to-end scenario.
  A component-test layer (React Testing Library) is not in place — which is
  exactly why the map bug above had to be found by hand in a browser.
* `/api/health` is deliberately **dynamic** rather than prerendered, so it
  always reports the live state. It is the only route in the product that
  opts out of the static build.

---

## 7. The one-paragraph summary

Mineazy Network is a **complete, working local-first network monitoring
console**: the data model, the nine-state health engine, the incident engine
with dedupe and correlation, traffic rates derived from counter deltas,
SNMP/LLDP/CDP/FDB/ARP discovery bounded to authorised ranges, fault-path
analysis with blast radius, the full console, three-role RBAC, encrypted
credentials, an audit trail, a standalone collector that runs whether or not
a browser is open, a Docker deployment and seven documentation guides — all
proven by **153 automated tests**, a **clean typecheck**, a **clean lint**,
a **warning-free production build**, a **31-check end-to-end acceptance
scenario** and a browser walkthrough of a real fault → acknowledge → recovery
cycle.

What it does **not** have is outbound alerting, SNMP trap ingestion, IPv6,
flow telemetry, CSV import, external authentication, MFA, clustering,
per-device alert rules, a mobile client, internationalisation or device
configuration management. Those are listed above with what each would take,
and none of them is disguised as a feature.
