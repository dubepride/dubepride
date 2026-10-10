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

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you land on **`/login`**
(the whole console is protected). Sign in with the master password
(`biobridge-admin` by default — set `ADMIN_PASSWORD` in `.env.local` to
change it), then the dashboard, feed and clock start working immediately
(demo data — including **8 weeks of multi-punch history** — is seeded into
`data/ta-bridge.db` on first run).

```bash
npm run build   # production build
npm start       # production server
npx eslint src  # lint
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
│       ├── dashboard/route.ts
│       └── terminals/route.ts
├── components/                     # Clock, feed, search, timesheet, consoles…
├── lib/
│   ├── db.ts                       # SQLite schema, migrations, seeds, queries
│   ├── session.ts                  # HMAC session cookies (used by proxy too)
│   ├── auth.ts                     # requireAdmin() guard for API routes
│   ├── timesheet.ts                # Multi-punch day/week grouping engine
│   ├── erp.ts                      # ERP delivery + buffering logic
│   ├── mock-generator.ts           # Simulated terminals + retry loop
│   ├── use-poll.ts                 # Client polling hook
│   ├── format.ts / types.ts
└── instrumentation.ts              # Boots background services on server start
```
