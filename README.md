# BIOBRIDGE — Enterprise Biometric Time & Attendance Bridge

A real-time web bridge between **IP fingerprint terminals** and a central
**ERP system**: devices push punches over HTTP (ADMS), the bridge buffers them
in SQLite, an sync engine drains the buffer to the ERP REST API, and an
operator dashboard shows everything live.

## Features

| Area | What you get |
| --- | --- |
| **Admin authentication** | `/login` master-password wall (signed HttpOnly session cookie) protecting every route; "Welcome back, Admin" toast after sign-in |
| **Master Clock** | Glowing neon-green digital clock (HH:MM:SS, ticking) centred on the dashboard |
| **Employee search** | Type-ahead search bar on the dashboard → opens the employee's weekly timesheet |
| **Live Scan Feed** | Auto-refreshing punches with branch chip + day-sequence number (`#2 · OUT · Branch 3`) |
| **Multi-branch mapping** | 17 branches (`Branch 1` … `Branch 17`), one terminal each; every punch/log shows the branch it was scanned at |
| **Multi-punch timesheet** | `/employees/[id]` — formal timesheet grouped by **Week N**, Monday–Saturday, showing the full chronological punch sequence (Morning in → Lunch out → Return in → Knock off out) with worked hours |
| **Top metrics** | Clocked In Today, Scans Today, Terminals Online, Pending ERP Sync |
| **Terminal Manager** | Table of every device: status dot, **branch**, location, IP, MAC, last ping, daily scans |
| **ERP Sync Logs** | Batch history with inspectable JSON payloads (incl. branch), offline buffer view, **Force Sync Now** |
| **Offline buffering** | Records stay `Pending` while the ERP is unreachable, delivered on recovery — never lost |
| **Mock generator** | Simulated terminals punch every few seconds (direction auto-alternates per day) so the UI is alive on first render |
| **Geofenced mobile clocking** | Optional secondary channel: the companion app (or a browser, from My Portal) clocks a worker in/out when GPS says they are inside a registered site's radius. The **bridge** re-derives the governing site on every punch, so a phone can never name a branch it is not standing in. Biometric terminals stay primary. |
| **Site & punch maps** | Leaflet maps everywhere: a draggable fence editor in Settings, a clock-in map in My Portal, a GPS report on Attendance Records, and a floating **Map** button on every page showing all fences + recent punch locations. Tiles are a courtesy layer — every distance and verdict is computed server-side. |

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you land on **`/login`**
(the whole console is protected). Sign in with the seeded administrator
account (`admin@biobridge.com` / `admin` — set `BIOBRIDGE_ADMIN_PASSWORD` in
`.env.local` to change the password), then the dashboard, feed and clock start
working immediately
(demo data — including **8 weeks of multi-punch history** — is seeded into
`data/ta-bridge.db` on first run).

```bash
npm run build   # production build
npm start       # production server
npx eslint src  # lint
npm test        # node --test: geofence + map-config unit tests
```

## Architecture

```
┌────────────────────┐   ADMS / HTTP Push    ┌──────────────────────────────┐
│  Fingerprint       │ ────────────────────▶ │  /api/biometrics/push        │
│  terminals (IP)    │   ID, Time, Status    │  parse → Attendance_Logs     │
└────────────────────┘                       │  ERP_Sync_Status = Pending   │
                                             └──────────────┬───────────────┘
┌────────────────────┐                       ┌──────────────▼───────────────┐
│  Mock simulator    │ ──── same path ─────▶ │  SQLite (node:sqlite)        │
│  (demo purposes)   │                       │  Employees · Terminals ·     │
└────────────────────┘                       │  Attendance_Logs · Batches   │
                                             └──────────────┬───────────────┘
┌────────────────────┐    POST JSON batch    ┌──────────────▼───────────────┐
│  External ERP      │ ◀─────────────────── │  /api/erp/sync               │
│  REST API          │   200 OK → Success   │  Sync Engine (retry loop +   │
└────────────────────┘   unreachable → stay │ manual Force Sync)           │
                                            └──────────────────────────────┘
```

**Stack:** Next.js 16 (App Router) · React 19 · Tailwind CSS v4 ·
TypeScript · SQLite via Node's built-in `node:sqlite` (zero native deps).

## API endpoints

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/biometrics/push` | Terminal listener — accepts ADMS/HTTP-Push frames (`?SN=<mac>&table=ATTLOG`), parses ID + timestamp, stores each punch as `Pending`. Also handles handshakes. **Public** (hardware can't log in). |
| `GET` | `/api/biometrics/push` | Device handshake / keep-alive (stamps `Last_Ping`). |
| `POST` | `/api/auth/login` | Master-password sign-in → sets signed HttpOnly session cookie. |
| `POST` | `/api/auth/logout` | Clears the session cookie. |
| `GET` | `/api/employees/search?q=` | Fuzzy employee search (name / ERP ID) for the dashboard search bar. |
| `GET` | `/api/employees/[id]` | Employee profile + timesheet grouped into weeks (Mon–Sat, ordered punch sequences). |
| `GET` | `/api/erp/sync` | Diagnostics snapshot: stats, batch history with payloads, offline buffer. |
| `POST` | `/api/erp/sync` | Force a sync of all `Pending` records to the ERP. |
| `GET` | `/api/dashboard` | Metrics + live feed with branch + day-sequence (polled every 2.5s). |
| `GET` | `/api/terminals` | Device registry with branch, health + daily counters. |
| `POST` | `/api/mobile/login` | Companion-app sign-in (Employee ID + PIN) → roster identity + the fences it may be judged against. |
| `POST` | `/api/attendance/geopunch` | The app's GPS punch. The bridge derives the governing site from the coordinates and returns an auditable verdict. |
| `POST` | `/api/my-portal/geopunch` | Browser self-clock. Identity comes **only** from the session (any body `employeeRef` is ignored); rate-limited per account + IP. |
| `GET` | `/api/attendance/geofences` | Display-only list of fences the browser clock-in map draws. |
| `GET` | `/api/attendance/geofence-activity` | Admin GPS report: every geofenced punch with distance/accuracy/verdict, filters, paging and biometric-vs-geofence counts. |
| `GET` | `/api/map/overview` | Session-gated, permission-aware snapshot for the app-wide map overlay (sites + recent punch locations). |

Everything except `/login`, `/api/auth/*` and `/api/biometrics/push` requires a
valid session: `src/proxy.ts` (Next 16's middleware) redirects page requests to
`/login` and answers admin APIs with **401 JSON**; each admin route handler
re-verifies the cookie via `requireAdmin()` (defence in depth).

### Simulating a hardware push

```bash
curl -X POST "http://localhost:3000/api/biometrics/push?SN=A4:1F:72:0C:9B:31&table=ATTLOG" \
  -d "ID=ERP-1001&Time=2026-10-07 08:02:07&Status=0&Verify=1"
```

JSON and CSV bodies are accepted too — see the parser in
`src/app/api/biometrics/push/route.ts`.

## Database schema

- **Employees** — `Employee_ID`, `ERP_User_ID`, `Full_Name`, `Fingerprint_Enrolled`, `Department`
- **Terminals** — `Terminal_MAC`, `IP_Address`, `Location_Name`, **`Branch_Name`** (`Branch 1` … `Branch 17`), `Status` (Online/Offline), `Last_Ping`
- **Attendance_Logs** — `Log_ID`, `Employee_ID`, `Timestamp`, `Terminal_ID`, `ERP_Sync_Status` (Pending/Success/Failed), `Verify_Result`, `Direction`, `Raw_Payload`
- **Erp_Sync_Batches** — diagnostic history: exact payload JSON, HTTP code, duration, trigger (Manual/Auto)

Timestamps are stored as epoch milliseconds; formatting happens at the edges.
The `Branch_Name` column is added by a guarded migration in `migrate()`
(`ALTER TABLE` only when missing), so existing databases upgrade in place.

### Multi-punch days

Devices that don't transmit a clock direction get one assigned by
`inferDirection()`: punches **alternate per employee per day**
(IN → OUT → IN → OUT), so grouped days always read
*Morning in → Lunch out → Return in → Knock off out* (17:00–18:00 window).
`src/lib/timesheet.ts` then groups punches by local day (Monday–Saturday),
pairs IN→OUT intervals for worked time, and buckets days into
`Week 1 … Week N` for the timesheet UI.

## Connecting real systems

### 1. Fingerprint terminals

On each device enable **HTTP Push / ADMS** with:

```
Server URL: http://<bridge-host>:3000/api/biometrics/push
```

Devices identify with `SN=<serial>` (matched against `Terminal_MAC`, then
source IP). The listener endpoint is heavily commented at the exact spots
where hardware-specific handling (user template sync, handshake commands,
serial-number column) plugs in.

### 2. External ERP

```bash
cp .env.example .env.local
# set:
ERP_API_URL=https://erp.example.com/api/v2/attendance/push
ERP_API_KEY=<token>
ERP_MOCK_MODE=false
```

The payload envelope built by `buildErpPayload()` in `src/lib/db.ts`:

```json
{
  "batch_ref": "TAB-…",
  "source": "TA-BRIDGE",
  "pushed_at": "2026-10-07T07:02:09.412Z",
  "record_count": 2,
  "records": [
    {
      "log_id": 1041,
      "employee_ref": "ERP-1001",
      "employee_name": "Amara Okafor",
      "direction": "IN",
      "punch_time": "2026-10-07 08:02:07",
      "timestamp_ms": 1791356527000,
      "verify_method": "Fingerprint",
      "terminal": { "mac": "A4:1F:72:BC:01:01", "ip": "192.168.17.21", "location": "Head Office — Main Gate", "branch": "Branch 1" }
    }
  ]
}
```

Delivery contract: **200 OK** → `Success`; unreachable/5xx → stays `Pending`
(offline buffer, retried every 20s); **4xx** → `Failed` (quarantined for
admin triage, retrying can't fix a rejected record).

### 3. Mobile clocking & maps

```bash
# Map tiles (browser + companion app). With nothing set, the maps use the
# public OpenStreetMap demo tiles — fine for review, NOT for production.
NEXT_PUBLIC_GEOAPIFY_API_KEY=<browser-restricted Geoapify key>
# Optional Geoapify style (default: osm-bright)
NEXT_PUBLIC_MAP_TILE_STYLE=
# …or point at any compliant provider with a full template:
NEXT_PUBLIC_MAP_TILE_URL=https://tiles.example/{z}/{x}/{y}.png
NEXT_PUBLIC_MAP_ATTRIBUTION=<required attribution HTML>
# Turn the OSM demo fallback off in production (maps then show a schematic):
NEXT_PUBLIC_MAP_DEMO_TILES=off

# Optional GPS gate: reject a mobile punch whose fix is less accurate than this
# many metres (0 / unset = no gate).
GEOFENCE_MAX_ACCURACY_METERS=
```

Maps are a courtesy layer. Every distance and accept/reject verdict is computed
on the server (`src/lib/geo-punch.ts`), so a missing key, a tile outage, or a
tampered client map can never produce a wrong clock-in. The companion app reads
its tile config from `mobile/app.json` → `expo.extra` instead; see
`mobile/README.md` §11.

## Design system

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#0A0A0A` | Pitch-black background |
| Containers | `#2D1B4E → #4A148C` | Purple gradient glass cards |
| Primary text | `#FFFFFF` | Headings, values |
| Secondary text | `#A0AEC0` | Labels, meta |
| Accent | `#00E676` | Success, online dots, master clock glow |

Tokens live in `src/app/globals.css` as Tailwind v4 `@theme` variables
(`bg-void`, `text-neon`, `text-muted`, …) plus reusable `.glass`, `.chip`,
`.btn--neon` and animation classes.

## Project layout

```
src/
├── proxy.ts                       # Auth wall (Next 16 middleware) — redirects to /login
├── app/
│   ├── page.tsx                    # Main dashboard (search + clock + feed)
│   ├── login/page.tsx              # Master-password sign-in
│   ├── employees/[id]/page.tsx     # Employee profile & weekly timesheet
│   ├── terminals/page.tsx          # Terminal Manager
│   ├── sync/page.tsx               # ERP Sync Logs
│   └── api/
│       ├── biometrics/push/route.ts  # ADMS listener (heavily commented)
│       ├── auth/login/route.ts       # Session cookie issue
│       ├── auth/logout/route.ts      # Session cookie clear
│       ├── employees/search/route.ts # Dashboard type-ahead
│       ├── employees/[id]/route.ts   # Profile + grouped timesheet
│       ├── erp/sync/route.ts         # Sync engine endpoint
│       ├── cron/erp-sync/route.ts    # Scheduled ERP drain (CRON_SECRET-guarded)
│       ├── dashboard/route.ts
│       ├── mobile/login/route.ts     # Companion-app sign-in (ID + PIN)
│       ├── attendance/geopunch/route.ts        # GPS punch (device channel)
│       ├── attendance/geofences/route.ts       # Fences for the clock-in map
│       ├── attendance/geofence-activity/route.ts# Admin GPS report
│       ├── my-portal/geopunch/route.ts         # Browser self-clock (session identity)
│       ├── map/overview/route.ts               # App-wide map overlay snapshot
│       └── terminals/route.ts
├── components/                     # Clock, feed, search, timesheet, consoles…
│   └── MapCanvas · MapOverlay · GeofenceClock · GeofenceMapEditor · GeofenceActivity
├── lib/
│   ├── sqlite.ts                   # The DB connection (local file / remote Turso)
│   ├── db.ts                       # Schema, migrations, seeds, queries (async)
│   ├── session.ts                  # HMAC session cookies (used by proxy too)
│   ├── auth.ts                     # requireAdmin() guard for API routes
│   ├── geofence.ts                 # Pure fence helpers (haversine, radius, method)
│   ├── geo-punch.ts                # Server-authoritative punch policy engine
│   ├── maps.ts                     # Leaflet tile config (env-driven, OSM demo fallback)
│   ├── rate-limit.ts               # In-memory fixed-window limiter
│   ├── timesheet.ts                # Multi-punch day/week grouping engine
│   ├── erp.ts                      # ERP delivery + buffering logic
│   ├── mock-generator.ts           # Simulated terminals + retry loop
│   ├── use-poll.ts                 # Client polling hook
│   ├── format.ts / types.ts
└── instrumentation.ts              # Boots background services on server start
```

## Deploying (serverless: Vercel / Netlify / Cloudflare)

The database layer talks to SQLite through **libSQL** (`@libsql/client`), so the
same code runs against a local file in development and a **Turso** database in
production — no query changes. Function filesystems on serverless hosts are
ephemeral, so a local `.db` file would be wiped on every deploy and cold start;
Turso keeps it durable. On a long-lived Node host you can keep using the file.

### 1. Create the database (free)

```bash
# https://turso.tech — sign up, then:
turso db create biobridge
turso db show biobridge --url          # → TURSO_DATABASE_URL
turso db tokens create biobridge       # → TURSO_AUTH_TOKEN
```

The schema is created automatically on first use — the exact same bootstrap as a
local run (see `src/lib/sqlite.ts` + `bootstrap()` in `src/lib/db.ts`). A fresh
install seeds the **13 real field-site branches** (with GPS geofences); the
demo branches are not seeded.

### 2. Set the environment variables

| Variable | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://…turso.io` — switches the app to remote mode |
| `TURSO_AUTH_TOKEN` | Database token |
| `CRON_SECRET` | Guards `/api/cron/erp-sync` (long random string) |
| `SESSION_SECRET` | HMAC key for session cookies — **set this** |
| `BIOBRIDGE_ADMIN_PASSWORD` | Password for the seeded admin — **set this** |
| `SIMULATOR_ENABLED` | `false` in production (real devices push instead) |
| `ERP_API_URL` / `ERP_API_KEY` / `ERP_MOCK_MODE` | Point at the real ERP |

Leave `TURSO_*` empty and the app falls back to the local SQLite file.

**Seeded logins.** On first use the app creates the admin account
(`admin@biobridge.com` / `admin`). Set `BIOBRIDGE_ADMIN_PASSWORD` to choose a
different password. The demo hr/sales/worker logins are seeded on a normal host but skipped
on serverless — set `BIOBRIDGE_SEED_DEMO_ACCOUNTS=true` to force them, or
`false` to never seed them. Change the admin password after your first login.

### 3. Deploy

Push the repo to GitHub and import it on Vercel (or Netlify / Cloudflare
Pages). No build tweaks are needed — `next build` / `next start` as usual.

### 4. Scheduled ERP draining

Serverless functions have no long-lived process, so the in-process retry loop
is skipped there (detected automatically via `VERCEL` / `NETLIFY` / `CF_PAGES`,
or force it with `BIOBRIDGE_SERVERLESS=1`). Draining is instead driven by:

1. **On every device push** — `/api/biometrics/push` schedules `runErpSync()`
   with `after()`: the terminal gets its ACK immediately, the Pending rows are
   pushed to the ERP a moment later.
2. **Scheduled calls** — `GET/POST /api/cron/erp-sync` (guarded by
   `CRON_SECRET`). `vercel.json` registers a **daily** cron (the only cadence
   Vercel Hobby allows); for near-real-time draining add a free external
   scheduler (e.g. cron-job.org) hitting that URL every minute with the header
   `Authorization: Bearer <CRON_SECRET>`.

```bash
# manual check
curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/erp-sync
```

