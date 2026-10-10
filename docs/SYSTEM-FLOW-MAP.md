# BIOBRIDGE — System Flow & Architecture Map

> Static analysis of the current codebase (Next.js 16.4.0 App Router, Tailwind, SQLite via `node:sqlite`).
> Every file name, component name, and API URL below was read directly from the repository.
> Items that were discussed but do **not** exist in the code are flagged **[Pending Implementation]**.

---

## 1. Page Routing & Navigation Map (The "Click Flow")

### 1.0 The auth wall — `src/proxy.ts` (applies to every request)

Next 16's `proxy.ts` (middleware successor) runs before every route:

| Request | Condition | Result |
|---|---|---|
| Any | Public path (`/login`, `/api/auth/login`, `/api/auth/logout`, `/api/biometrics/push`) | `NextResponse.next()` |
| `/login` page | Session **valid** | **307 → `/`** (authenticated users bounce off login) |
| `/login` page | No session | `NextResponse.next()` |
| `/api/*` | No valid session | **401 JSON** `{ ok:false, error:"Unauthorized — sign in at /login." }` (no redirect) |
| Any page | No valid session | **307 → `/login`** |
| Everything else | Valid session | `NextResponse.next()` |

- Session = HMAC-SHA256 signed cookie **`biobridge_session`** (`base64url(claims).base64url(hmac)`), claims `{ sub:"hr-admin", role:"admin", exp }`, **12 h TTL**, verified with constant-time compare (`src/lib/session.ts`). No server-side session store.
- Matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `robots.txt` and image/css/js/map file extensions.
- Defense-in-depth: every admin API route *also* calls `requireAdmin()` from `src/lib/auth.ts`, which returns a ready-made 401 `Response` (never throws/redirects).
- Exception: `src/app/api/biometrics/push/route.ts` is intentionally **unguarded** (device trust = network placement + shared push URL).

### 1.1 `/login` — Sign in (only public page)

**File:** `src/app/login/page.tsx` → renders `src/components/LoginForm.tsx`.

- Form input: password field (placeholder `"Enter the HR department password"`, show/hide toggle, `autoFocus`).
- **Action: Submit ("Unlock Console")** → `POST /api/auth/login` with `{ password }`.
  - Success → 200 `{ ok:true, message:"Welcome back, Admin" }` + `Set-Cookie: biobridge_session` (HttpOnly, SameSite=Lax, expires +12 h) → client does `router.push("/?welcome=1")`.
  - Wrong password → 401 `{ error:"Incorrect master password." }` (counted toward throttle); ≥ **8 failures / 10 min** → 429 `"Too many failed attempts — try again in 10 minutes."`
  - `demoHint` block renders `"Demo credentials — password biobridge-admin"` only when `ADMIN_PASSWORD` env is unset (computed at build time).
- Sidebar on this route renders the degraded "Secure area" plate (no nav links). Footer: *"Every route behind this wall is session-protected."*

### 1.2 `/` — Main Dashboard

**Files:** `src/app/page.tsx` (server shell: `MasterClock` + `DashboardBody`) → `src/components/DashboardBody.tsx` (client, polls `GET /api/dashboard` every **2500 ms** via `usePoll`).

**Global chrome on every page** (rendered by `src/app/layout.tsx` → `AppChrome` → `Sidebar` + `Nav`):

**Sidebar** (`src/components/Sidebar.tsx`) — fixed `w-64` left rail on desktop, slide-over drawer (`z-50`, backdrop, Escape, scroll-lock, `inert` when closed) on mobile:

| Label | href | Click result |
|---|---|---|
| Dashboard | `/` | Client navigation to dashboard (active state: exact `/` match) |
| My Portal | — | **Inert `<span>` "SOON" chip** — [Pending Implementation] |
| Employees | — | **Inert `<span>` "SOON" chip** — [Pending Implementation] (no `/employees` index page exists) |
| Reports | — | **Inert `<span>` "SOON" chip** — [Pending Implementation] |
| Exceptions | `/#exceptions` | Navigates to dashboard and scrolls to the Exceptions widget (`id="exceptions"` in `ExceptionsCard.tsx`) |
| Timesheets | — | **Inert `<span>` "SOON" chip** — [Pending Implementation] (timesheets only reachable per-employee) |
| Who's In | `/#whos-in` | Navigates to dashboard and scrolls to Employee Status (`id="whos-in"` in `EmployeeStatusCard.tsx`) |
| Time Clocks | `/terminals` | Client navigation to the Terminal Manager |
| SYSTEM → ERP Sync Logs | `/sync` | Client navigation to the Sync Console |

- Hash anchors never light up as "active"; `/#exceptions` and `/#whos-in` targets exist on the dashboard.
- Footer: neon dot + `Bridge online`, `17 branches · Biometric T&A`.

**Nav header** (`src/components/Nav.tsx`):

- Hamburger (`lg:hidden`) → opens the mobile sidebar drawer (state in `AppChrome.tsx`).
- Brand plate `BIOBRIDGE` → `<Link href="/">`.
- Page title from `AppChrome.TITLES` map: `/`→Dashboard, `/login`→Secure Area, `/terminals`→Time Clocks, `/sync`→ERP Sync Logs, `/employees/*`→Employee Timesheet.
- Live wall clock (1 s `setInterval`, `en-GB` 24 h).
- **Action: "Sign Out"** → `POST /api/auth/logout` (always 200, expires cookie) → `finally` does `router.push("/login")` (navigation happens even if the fetch fails).

**Dashboard widgets, in DOM order:**

1. **`WelcomeToast.tsx`** — shown when URL has `?welcome=1` (set by login), scrubs the query via `history.replaceState`, auto-dismiss 6 s. Only action: dismiss ✕ (`aria-label="Dismiss welcome message"`). Non-interactive otherwise.
2. **4 × `MetricCard.tsx`** — *Clocked In Today*, *Scans Today*, *Terminals Online*, *Pending ERP Sync*. Pure display, **not clickable**.
3. **Error banner** (only when poll fails with no data): *"Live data unavailable — {error}. The bridge keeps retrying automatically."*
4. **2 × 2 widget grid** (`DashboardBody`):
   - **`EmployeeStatusCard.tsx`** (`id="whos-in"`, title *Employee Status*) — columns Name / Status / Time; chips `WORKING` / `ON BREAK` / `NOT IN` from static `EMPLOYEE_STATUS` (`src/lib/dashboard-mock.ts`).
     - **Action: click a roster row** → `router.push("/employees/{employeeId}")` (opens that employee's timesheet).
     - **Action: type in the search box** (placeholder & aria-label exactly `"Search for ID or Name"`) → 250 ms debounce, ≥2 chars → `GET /api/employees/search?q=…`; results dropdown; **click a result** → `router.push("/employees/{id}")`; keyboard Arrow/Enter/Escape supported.
     - **Action: filter icon** → local dropdown (All statuses / Working / On break / Not in) — client-side filter only, no API.
   - **`ExceptionsCard.tsx`** (`id="exceptions"`, title *Exceptions*) — wrapped in `<Suspense>` inside `DashboardBody`.
     - Six `<button aria-haspopup="dialog">` boxes (hover `scale-105`, gradient, `active:scale-100`), display order & tones: **Arrived Early** (`arrived_early`, white) · **Arrived Late** (`arrived_late`, amber) · **Left Early** (`left_early`, amber) · **Left Late** (`left_late`, white) · **No Show** (`no_show`, red) · **Missing Punch** (`missing_punch`, red).
     - On mount: `GET /api/dashboard/exceptions` (no params) hydrates live counts over the static `SEED_COUNTS` first paint (guarded by `seqRef` so a drawer response can't be overwritten).
     - **Action: click an exception box** → opens `src/components/ExceptionDrawer.tsx` (right slide-over, `z-[60]`, `backdrop-blur-sm bg-black/40`) and fetches **`GET /api/dashboard/exceptions?type={type}`** (e.g. `?type=arrived_late`; aliases `early`/`late`, case/hyphen-insensitive; unknown type → 400 + `allowed[]` list).
     - Drawer header: kicker *Exception drill-down* → `"{Label} - Today"` (e.g. **"Arrived Late - Today"**) → rule line from `EXCEPTION_RULES` (e.g. *"First punch of the day after the 08:00 shift start."*); count chip `N record(s)`.
     - Drawer table columns: **Employee · Branch · Timestamp · Variance · Action**; variance badges — amber `+X mins late`, green `-X mins early`, red `No punch recorded` / `Missing IN punch` / `Missing OUT punch`.
     - States: skeleton → error + **Retry** button → per-type empty state (`EXCEPTION_EMPTY`) → table.
     - **Action: "View Timesheet"** → `<Link href="/employees/{row.employeeId}">` and closes the drawer first.
     - Close: Escape, backdrop click, ✕ button, or any route change; focus returns to the originating box; body scroll locked while open.
   - **`OvertimeCard.tsx`** — static `OVERTIME_ROWS`, columns Name / Worked Hours / Approaching / Status. **Rows are plain `<tr>` — no links/actions** (flagged inert; deep-links to `/employees/[id]` would be [Pending Implementation]).
   - **`TimeOffCard.tsx`** — static `TIME_OFF_REQUESTS`. **Action: Approve / Deny per row** → both call the same `decide(id)` which only removes the row from local React state — **no fetch, no persistence** (flagged; real approval flow is [Pending Implementation]).
5. **Feed + right rail** (`grid lg:grid-cols-3`):
   - **`LiveFeed.tsx`** (`lg:col-span-2`) — prop-driven by `/api/dashboard` poll (`data.feed`), header `{N} EVENTS · AUTO-REFRESH 2.5s`. Rows: avatar, name + `ERP_User_ID`, day punch sequence `#N`, IN/OUT arrow, **branch chip (`Branch_Name`)**, location, `formatFeedTime` timestamp, ✓ Verified/Denied chip, ERP sync chip (Pending/Failed/Synced). **No interactions** — pure display. Empty state mentions pushes to `/api/biometrics/push`.
   - **`TerminalPulse.tsx`** — `usePoll("/api/terminals", 3000)`. Rows: status dot, branch, location, IP, scans today, last ping. **Action: footer link "Manage devices →"** → `<Link href="/terminals">`.
   - **`SyncMini.tsx`** — `usePoll("/api/erp/sync", 5000)`. Pending buffer / last push / synced today / failed batches + `LIVE ERP` or `ERP SIMULATOR` mode chip. **Action: footer link "Open sync console →"** → `<Link href="/sync">`.
6. **`MasterClock.tsx`** (rendered above `DashboardBody` by `page.tsx`) — giant neon clock + `formatLongDate` date line, ticked by a local 1 s `setInterval`. **No API, no interactions.**

### 1.3 `/employees/[id]` — Employee Timesheet

**Files:** `src/app/employees/[id]/page.tsx` → `<Suspense fallback={TimesheetSkeleton}><EmployeeProfile /></Suspense>` → `src/components/EmployeeProfile.tsx` (reads `useParams()` client-side, fetches `GET /api/employees/{id}` with `cache:"no-store"`; 404 → *"No employee matches "{id}"."*).

Entry points: roster row / search result / drawer "View Timesheet" (see above). **No sidebar link reaches it** — `Employees` is a SOON stub ([Pending Implementation] — there is no `/employees` index page either).

- **Action: "← Dashboard"** → `<Link href="/">` (also in the error state as "← Back to dashboard").
- **Action: "↻ Refresh Timesheet"** → bumps `refreshNonce` → re-GETs `/api/employees/{id}` (stale-error footer shows `(stale snapshot)` if a refresh fails after data exists).
- **Week selector — grouped by month:** weeks (Mon–Sat, 8-week window = current week + prior 7) are bucketed under headings `Weeks in August` / `Weeks in September` / `Weeks in October` (month of each week's Monday, `en-GB` long name), each group a wrapping row of buttons `Week {n}` + date range (+ `· no activity` when `punches === 0`).
  - **Action: click a week button** → `setSelected(w.index)` — re-renders the calendar table **without refetching**; active button gets the neon border/glow; table header shows `Week {n} · {range}`.
  - Default selection: most recent week with `punches > 0` (preserved across refresh if still valid).
- Table: Day · Date · Punch sequence (Morning in → Lunch out → Return in → Knock off out) · First in · Last out · Worked; `Today`/`Open` chips; tfoot week totals. Rows are non-interactive.
- Profile header: avatar, name, `ERP_User_ID`, department, fingerprint chip; stats strip (punches / days / hours / branches).

### 1.4 `/terminals` — Terminal Manager

**Files:** `src/app/terminals/page.tsx` → `src/components/TerminalManager.tsx`, `usePoll("/api/terminals", 3000)` (chip *"Auto-refresh 3s"*).

- 3 summary MetricCards: Devices Online `N/17`, Devices Offline, Scans Today.
- Connected Devices table: Status · Branch · Location · IP Address · Terminal MAC · Last Ping · Scans Today (header: `17 REGISTERED`).
- **No buttons or mutations — the page is read-only.** Simulate-punch / enable-disable device controls are [Pending Implementation].
- Static "Device Push Configuration" cheat-sheet section (no actions): documents `PUSH URL http://<bridge-host>:3000/api/biometrics/push?SN=<terminal-mac>`, ADMS body format, and a curl example.

### 1.5 `/sync` — ERP Sync Logs

**Files:** `src/app/sync/page.tsx` → `src/components/SyncConsole.tsx`, `usePoll("/api/erp/sync", 4000)`.

- 4 MetricCards: Pending Backlog · Synced Today · Successful Batches · Failed Batches; mode chip `LIVE · {url}` or `ERP SIMULATOR MODE`.
- **Action: "Force Sync Now"** → `POST /api/erp/sync` (no body) → banner `✓/✕ {message}` (auto-dismiss 7 s) → immediate `refresh()` of the GET poll. Guarded against double-click (`disabled`, `aria-busy`).
- Payload History table (Batch · Timestamp · Trigger · Records · Status · HTTP · Duration), header hint *"CLICK A ROW TO INSPECT THE PUSHED JSON"*.
  - **Action: click a batch row** → expands an inline drawer (`colSpan=7`) with the error box and `<pre>` of the exact `Payload_JSON` pushed to the ERP.
- Offline Buffer table (Log ID · Employee · Punch Time · Origin · Queued For) — read-only view of `Attendance_Logs` rows still `Pending`.
- Empty-state copy: *"No sync attempts recorded yet — the engine runs automatically every 20s once punches arrive."*

### 1.6 Navigation target inventory (every link in the app)

| Source | Target |
|---|---|
| Sidebar | `/`, `/#exceptions`, `/#whos-in`, `/terminals`, `/sync` (+ 4 SOON stubs) |
| Nav | `/` (brand), `/login` (after Sign Out) |
| LoginForm | `/?welcome=1` (on success) |
| EmployeeStatusCard roster row / search result | `/employees/{id}` |
| ExceptionDrawer "View Timesheet" | `/employees/{id}` |
| EmployeeProfile | `/` (back links) |
| TerminalPulse footer | `/terminals` |
| SyncMini footer | `/sync` |
| WelcomeToast | `history.replaceState` (query scrub, not a navigation) |

**Pending Implementation (routes/pages referenced or implied but absent):** `/employees` (list page — sidebar *Employees* is a SOON stub), *My Portal*, *Reports*, *Timesheets* (dedicated page), terminal mutate actions on `/terminals`, persisted Time-Off approvals, OvertimeCard row deep-links. In-code "WIRE HERE LATER" hooks also exist in `src/app/api/biometrics/push/route.ts` (Userinfo/template sync, device command queue on handshake).

---

## 2. Next.js Directory & Component Structure

```
(Default Project)/
├── next.config.ts            # cacheComponents + partialPrefetching enabled (Next 16)
├── package.json              # scripts: dev / build (next build, Turbopack) / start / lint
├── AGENTS.md                 # agent rules block (re-added by `next dev`)
├── docs/SYSTEM-FLOW-MAP.md   # this document
└── src/
    ├── proxy.ts                          # Auth wall (middleware successor) — see §1.0
    ├── instrumentation.ts                # Server lifecycle: boots SQLite + simulator + auto-sync
    ├── app/
    │   ├── layout.tsx                    # Root layout: Geist fonts, metadata, AppChrome in Suspense,
    │   │                                 #   lg:pl-64 content wrapper + footer (names /api/biometrics/push)
    │   ├── page.tsx                      # "/" Dashboard shell → MasterClock + DashboardBody
    │   ├── login/page.tsx                # "/login" → LoginForm (+ build-time demo hint)
    │   ├── employees/[id]/page.tsx       # "/employees/[id]" → Suspense → EmployeeProfile
    │   ├── terminals/page.tsx            # "/terminals" → TerminalManager
    │   ├── sync/page.tsx                 # "/sync" → SyncConsole
    │   └── api/
    │       ├── auth/login/route.ts       # POST {password} → throttle(8/10min→429), 401, cookie+200
    │       ├── auth/logout/route.ts      # POST → always 200, expires biobridge_session
    │       ├── biometrics/push/route.ts  # ADMS GET handshake + POST punches (public, unguarded)
    │       ├── dashboard/route.ts        # GET → { metrics, feed, generatedAt } (no-store)
    │       ├── dashboard/exceptions/route.ts # GET [?type=] → counts / rows / 400 (no-store)
    │       ├── terminals/route.ts        # GET → { terminals, generatedAt }
    │       ├── erp/sync/route.ts         # GET overview / POST force-sync (runErpSync "Manual")
    │       ├── employees/search/route.ts # GET ?q= → top-10 LIKE matches
    │       └── employees/[id]/route.ts   # GET (by Employee_ID or ERP_User_ID) → employee+weeks+stats
    ├── components/
    │   ├── AppChrome.tsx                 # Client chrome shell: Sidebar + Nav, TITLES map, drawer state,
    │   │                                 #   scroll-lock, Escape, lg matchMedia auto-close
    │   ├── Sidebar.tsx                   # Fixed w-64 rail + mobile slide-over; nav items, SOON stubs,
    │   │                                 #   active-state logic, "Secure area" degraded mode on /login
    │   ├── Nav.tsx                       # Sticky header: hamburger, brand, title, Admin Session pill,
    │   │                                 #   Sign Out (POST /api/auth/logout → push /login), wall clock
    │   ├── LoginForm.tsx                 # Login form → POST /api/auth/login → /?welcome=1
    │   ├── WelcomeToast.tsx              # ?welcome=1 toast, 6 s auto-dismiss, history.replaceState scrub
    │   ├── MasterClock.tsx               # Neon clock, local 1 s tick, no API
    │   ├── DashboardBody.tsx             # Dashboard composition: polls /api/dashboard @2500ms,
    │   │                                 #   metric tiles, 2×2 grid, feed+rail; Suspense around ExceptionsCard
    │   ├── MetricCard.tsx                # Presentational stat tile (tone: neon/warn/danger)
    │   ├── EmployeeStatusCard.tsx        # "Who's In" roster (static mock) + search box →
    │   │                                 #   /api/employees/search → router.push /employees/{id}; status filter
    │   ├── ExceptionsCard.tsx            # 6 clickable exception boxes, SEED_COUNTS hydration,
    │   │                                 #   drawer orchestration (open/Escape/scroll/focus/route-close)
    │   ├── ExceptionDrawer.tsx           # Right slide-over z-[60]: skeleton/error+retry/empty/table,
    │   │                                 #   variance badges, View Timesheet → /employees/{id}
    │   ├── OvertimeCard.tsx              # Static OT table (inert rows)
    │   ├── TimeOffCard.tsx               # Static requests; Approve/Deny = local state only
    │   ├── LiveFeed.tsx                  # Prop-driven live scan feed (Branch_Name chip, IN/OUT, sync chips)
    │   ├── TerminalPulse.tsx             # /api/terminals @3000ms mini panel → link /terminals
    │   ├── SyncMini.tsx                  # /api/erp/sync @5000ms mini panel → link /sync
    │   ├── TerminalManager.tsx           # /terminals page: device table + push-config cheat sheet (read-only)
    │   ├── SyncConsole.tsx               # /sync page: Force Sync Now, batch JSON inspector, offline buffer
    │   ├── EmployeeProfile.tsx           # /employees/[id]: profile, month-grouped week selector, timesheet
    │   ├── WidgetShell.tsx               # Shared glass card frame (id anchor, title, meta, footer)
    │   ├── Avatar.tsx                    # Deterministic initials circle
    │   ├── icons.tsx                     # 19 inline SVG icons (IconUsers, IconScan, IconFingerprint, …)
    │   └── timesheet skeleton — (TimesheetSkeleton lives inside EmployeeProfile.tsx)
    └── lib/
        ├── db.ts                         # SQLite layer: schema/migrate/seed, dashboard+timesheet+exception
        │                                 #   queries, ERP payload builder, sync status updates (~1.4k lines)
        ├── erp.ts                        # runErpSync engine: single-flight lock, deliver() live|mock,
        │                                 #   fail-every-Nth batch simulation, env config (erpConfig)
        ├── mock-generator.ts             # startMockServices(): terminal simulator, heartbeat, auto-sync (20s)
        ├── session.ts                    # Stateless HMAC session: token create/verify, password check,
        │                                 #   login throttle (8 fails/10 min)
        ├── auth.ts                       # requireAdmin() guard + unauthorizedResponse() + re-exports
        ├── use-poll.ts                   # usePoll(url, intervalMs=3000): in-flight skip, nonce refresh
        ├── timesheet.ts                  # buildTimesheet(): punches → Mon–Sat weeks → days → punch labels
        ├── exception-meta.ts             # Isomorphic constants: 6 types, labels, rules, empties, aliases
        ├── dashboard-mock.ts             # Static mock data: EMPLOYEE_STATUS, EXCEPTION_METRICS (seed
        │                                 #   counts), OVERTIME_ROWS, TIME_OFF_REQUESTS
        ├── types.ts                      # All wire + row TypeScript interfaces (DTOs, ErpRecord, …)
        ├── format.ts                     # en-GB formatters: time/date/relative/duration/feed time
        └── (mock data helpers co-located: format + feed formatting)
```

No `loading.tsx`, no `error.tsx`, no route segment config (`dynamic`/`revalidate`), no `use cache` blocks, no Context providers, no global state library — the only `Suspense` boundaries are in `layout.tsx` (chrome fallback) and `employees/[id]/page.tsx` (timesheet skeleton), plus the one around `ExceptionsCard`.

---

## 3. Database Schema & State Management

### 3.1 SQLite database

- **File:** `data/ta-bridge.db` (`path.join(process.cwd(), "data", "ta-bridge.db")`), opened with **`node:sqlite`** `DatabaseSync`.
- **Pragmas:** `journal_mode = WAL` (concurrent readers during pushes), `foreign_keys = OFF` (punch rows survive employee churn).
- Singleton on `globalThis.__taBridgeDb`; `migrate()` + `seedIfEmpty()` run on first `getDb()` (forced early by `instrumentation.ts → startMockServices()`).
- Created/maintained in `src/lib/db.ts` (`migrate()`), all statements `CREATE TABLE IF NOT EXISTS`.

**Tables (exact columns):**

```sql
Employees (
  Employee_ID          INTEGER PRIMARY KEY AUTOINCREMENT,
  ERP_User_ID          TEXT    NOT NULL UNIQUE,        -- e.g. "ERP-1001"
  Full_Name            TEXT    NOT NULL,
  Fingerprint_Enrolled INTEGER NOT NULL DEFAULT 0,     -- SQLite 0/1 boolean
  Department           TEXT    NOT NULL DEFAULT '',
  Created_At           INTEGER NOT NULL                -- epoch ms
)

Terminals (
  Terminal_ID   INTEGER PRIMARY KEY AUTOINCREMENT,
  Terminal_MAC  TEXT    NOT NULL UNIQUE,               -- ≙ device serial (SN) in push URL
  IP_Address    TEXT    NOT NULL,
  Location_Name TEXT    NOT NULL,
  Branch_Name   TEXT    NOT NULL DEFAULT '',           -- Phase 2 column (added via ALTER TABLE migration)
  Status        TEXT    NOT NULL DEFAULT 'Offline',    -- 'Online' | 'Offline'
  Last_Ping     INTEGER                                -- epoch ms heartbeat/scan
)

Attendance_Logs (
  Log_ID          INTEGER PRIMARY KEY AUTOINCREMENT,
  Employee_ID     INTEGER,               -- NULL = unrecognised device ID
  Timestamp       INTEGER NOT NULL,      -- epoch ms of the punch
  Terminal_ID     INTEGER,               -- NULL = unknown source terminal
  ERP_Sync_Status TEXT    NOT NULL DEFAULT 'Pending',   -- Pending | Success | Failed
  Verify_Result   TEXT    NOT NULL DEFAULT 'Verified',  -- Verified | Denied
  Direction       TEXT    NOT NULL DEFAULT 'IN',        -- IN | OUT
  Verify_Method   TEXT    NOT NULL DEFAULT 'Fingerprint',
  Raw_Payload     TEXT,                    -- original device frame
  Created_At      INTEGER NOT NULL         -- epoch ms of ingestion
)

Erp_Sync_Batches (
  Batch_ID       INTEGER PRIMARY KEY AUTOINCREMENT,
  Created_At     INTEGER NOT NULL,
  Record_Count   INTEGER NOT NULL,
  Status         TEXT    NOT NULL,                     -- 'Success' | 'Failed'
  Response_Code  INTEGER,                              -- HTTP code from ERP (503 on simulated outage)
  Error_Message  TEXT,
  Duration_MS    INTEGER,
  Trigger_Source TEXT    NOT NULL DEFAULT 'Auto',      -- 'Manual' | 'Auto'
  Payload_JSON   TEXT    NOT NULL                      -- exact JSON pushed to the ERP
)
```

**Indexes:**
- `idx_logs_sync ON Attendance_Logs (ERP_Sync_Status, Log_ID)` — pending-buffer drain
- `idx_logs_ts ON Attendance_Logs (Timestamp DESC)` — feed ordering
- `idx_logs_emp ON Attendance_Logs (Employee_ID, Timestamp)` — timesheets

**Migration note:** pre-Phase-2 databases get `ALTER TABLE Terminals ADD COLUMN Branch_Name` (guarded by `PRAGMA table_info`), then `ensureBranchCoverage()` backfills `Branch 1..N` and guarantees all 17 branches have a device.

**Seed data (`seedIfEmpty`):**
- **12 employees** `ERP-1001`…`ERP-1012` (Amara Okafor … Rafael Moreno, 10 departments, all fingerprint-enrolled).
- **17 terminals** — one per branch (`Branch 1`…`Branch 17`, MACs `A4:1F:72:BC:NN:01`, IPs `192.168.17.21-37`); **Branch 9 and Branch 14 seed `Offline`**.
- `seedAttendanceHistory()` — ~7 weeks of past Mon–Sat working days (4-punch sequence, occasional half days, natural branch variation) + today up to the current wall clock; **newest 5 rows stay `Pending`** so the sync page opens with a live offline buffer, everything older `Success`.
- `seedSyncHistory()` — believable batch history (one failed attempt then retries).

### 3.2 Frontend state management

**Pattern: standard React hooks only — no Context API, no Redux/Zustand, no URL-state library.**

| Concern | Mechanism |
|---|---|
| Repeated server data | `usePoll(url, intervalMs)` (`src/lib/use-poll.ts`): immediate fetch (`cache:"no-store"`), `setInterval`, **skips ticks while a request is in flight**, `refresh()` via nonce de-dup, errors kept as strings without dropping stale data |
| One-off fetches | `useEffect` + `useState` in `EmployeeProfile` (`/api/employees/{id}`, keyed by `[id, refreshNonce]`) and `ExceptionsCard` (summary on mount + per-type on drawer open, stale-response guard `seqRef`) |
| Route identity | `useParams()` for `/employees/[id]`; `usePathname()` in `AppChrome` (titles, drawer close) and `ExceptionsCard` (route-change closes drawer) |
| Drill-down state | **Local component state**: ExceptionsDrawer `active`/`open`/`triggerRef` (focus restore); no query-string is written for drill-downs |
| URL-driven bits (only these) | `?welcome=1` (WelcomeToast), hash anchors `/#exceptions` `/#whos-in` (sidebar scroll targets) |
| Cross-component data | Props down only (e.g. `DashboardBody` poll result → MetricCards/LiveFeed) |
| Static/mock content | `src/lib/dashboard-mock.ts` constants (roster, OT, time-off, exception seed counts) — never fetched |
| Server session | Stateless HMAC cookie (`biobridge_session`, 12 h); in-process login throttle `globalThis.__taLoginThrottle`; ERP single-flight lock `globalThis.__taErpSyncLock` |

---

## 4. The Data Flow Pipeline (Hardware to ERP)

Full lifecycle of one fingerprint scan, e.g. `ERP-1001 (Amara Okafor)` badge at the Head Office gate:

### Step 1 — Terminal pushes payload → `POST /api/biometrics/push?SN=<terminal-mac>&table=ATTLOG`

**Handler:** `src/app/api/biometrics/push/route.ts` (public — bypasses `requireAdmin`; ADMS/HTTP-Push receiver for ZKTeco-class devices).

1. **Packet filter:** non-`ATTLOG` tables (DeviceInfo/Userinfo/template/photo) → `200 OK "OK: ignored table=…"` ACK, no write.
2. **Terminal resolution:** `SN` query param matched against `Terminals.Terminal_MAC`, falling back to client IP (`x-forwarded-for`/`x-real-ip`) via `findTerminal()`; match → `touchTerminal()` stamps `Last_Ping` (device shows **Online**). Unknown sources are **never dropped** — stored with `Terminal_ID = NULL`.
3. **Body parsing (tolerant):** JSON → ADMS line format `ID=ERP-1001&Time=2026-10-07 08:02:07&Status=0&Verify=1` → CSV. Timestamps normalised from `"YYYY-MM-DD HH:MM:SS"`, epoch s/ms to epoch ms (`parseDeviceTime`). Direction from `Direction/Status` keys (`0/IN` vs `1/OUT`).
4. **Persist:** each event → `resolveEmployee()` (by `ERP_User_ID`/`Employee_ID`; not enrolled → `Verify_Result = 'Denied'`) → **`insertPunch()` → `INSERT INTO Attendance_Logs` with `ERP_Sync_Status = 'Pending'`** (`Raw_Payload` keeps the original frame).
5. **ACK:** plain-text `200 OK: received=N` (`Cache-Control: no-store`) — without the 200, device firmware would retransmit for hours.

`GET /api/biometrics/push?SN=…` = handshake/keep-alive → stamps `Last_Ping`, returns `200 OK` (command-queue response marked *WIRE HERE LATER*).

> **Demo equivalent:** the same table write is produced in-process by the **simulator** (`src/lib/mock-generator.ts`, started from `src/instrumentation.ts`): every **2 500–5 500 ms** (`SIMULATOR_MIN_MS`/`SIMULATOR_MAX_MS`) a random online terminal records a punch for a random enrolled employee through the identical `insertPunch()` — with believability guards (4-minute per-person gap, branch stickiness, 6 % unregistered `GHOST-*` IDs) and ~10 % terminal Online/Offline flapping. A heartbeat refreshes `Last_Ping`; disabled with `SIMULATOR_ENABLED=false`.

### Step 2 — Database handles the data (`src/lib/db.ts`)

- Row lands in **`Attendance_Logs`** (`Pending`), WAL mode so readers never block the writer.
- Every dashboard read is derived at request time: `getDashboard()` computes `metrics` (`clockedInToday`, `scansToday`, `terminalsOnline/Total`, `pendingSync`, `syncedToday`) + `feed` (last N logs joined to `Employees`/`Terminals` → `FeedEntry.branchName` from **`Branch_Name`**); `listTerminals()` joins `Terminals` + per-terminal `Scans_Today`.
- Exceptions are computed on demand by `getExceptions(type)` / `classifyExceptions()` in `db.ts` against the rules in `src/lib/exception-meta.ts` (08:00 shift start; 17:00–18:00 knock-off window; Mon–Sat).

### Step 3 — Web UI updates via polling (no WebSockets)

`usePoll` clients, all `cache:"no-store"`, all re-checked by `requireAdmin()` on the server:

| Consumer | Endpoint | Interval |
|---|---|---|
| `DashboardBody` → MetricCards + LiveFeed | `GET /api/dashboard` | **2 500 ms** |
| `ExceptionsCard` (mount + drawer open) | `GET /api/dashboard/exceptions[?type=]` | on demand |
| `TerminalPulse` (dashboard rail) | `GET /api/terminals` | **3 000 ms** |
| `TerminalManager` (`/terminals`) | `GET /api/terminals` | **3 000 ms** |
| `SyncMini` (dashboard rail) | `GET /api/erp/sync` | **5 000 ms** |
| `SyncConsole` (`/sync`) | `GET /api/erp/sync` (+ `refresh()` after Force Sync) | **4 000 ms** |
| `EmployeeStatusCard` search | `GET /api/employees/search?q=` | 250 ms debounce |
| `EmployeeProfile` | `GET /api/employees/{id}` | mount + manual refresh |

So a punch pushed in Step 1 is visible in the Live Feed within ~2.5 s, and its terminal's `Last_Ping` keeps the device Online in the pulse panel.

### Step 4 — Sync engine pushes to ERP

**Two triggers** (single-flight via `globalThis.__taErpSyncLock`):
- **Auto:** background retry loop `startAutoSync()` (`mock-generator.ts`) runs **`runErpSync("Auto")` every 20 s** when `getSyncOverview().stats.pendingLogs > 0`.
- **Manual:** **`POST /api/erp/sync`** (`src/app/api/erp/sync/route.ts`, `requireAdmin`-guarded) → `runErpSync("Manual")` → always HTTP 200 with `{ ok, attempted, synced, failed, message, batch, trigger }` (500 only on internal throw).

**Inside `runErpSync()` (`src/lib/erp.ts`):**
1. Drain queue: `getPendingLogs(500)` → `SELECT … FROM Attendance_Logs WHERE ERP_Sync_Status='Pending' ORDER BY Timestamp ASC LIMIT 500`. Empty → `{ ok:true, message:"Buffer is empty …" }`, no batch.
2. Build payload: `buildErpPayload(logIds, batchRef)` (`db.ts`) with `batch_ref = "TAB-<base36>"`, `source: "TA-BRIDGE"`, `pushed_at` ISO-8601 UTC, `records[] = { log_id, employee_ref, employee_name, direction, punch_time, timestamp_ms, verify_method, terminal:{ mac, ip, location, branch } }`.
3. **Deliver** (`deliver()`):
   - **live mode** (set when `ERP_API_URL` exists and `ERP_MOCK_MODE !== "true"`): `fetch(ERP_API_URL, { method:"POST", headers:{ "Content-Type":"application/json", "X-Bridge-Source":"TA-BRIDGE", Authorization: Bearer `ERP_API_KEY` }, body, signal: AbortSignal.timeout(8000) })`.
   - **mock mode (default)**: sleeps 350–900 ms, then **fails every Nth batch** (`ERP_MOCK_FAIL_EVERY`, default **5**; `batchSeq % failEvery === 0` → simulated `503` *"Simulated ERP outage (offline-buffering demo) — will retry"*) — this is what keeps the Offline Buffer populated for the demo.
4. **Write results:**
   - HTTP success → `markLogsSynced()` → `UPDATE Attendance_Logs SET ERP_Sync_Status='Success'`
   - ERP 4xx → `markLogsFailed()` → `'Failed'` (quarantined, never retried)
   - 5xx / timeout / unreachable → **no update; rows stay `Pending`** (offline buffering — never lost)
   - always → `insertSyncBatch()` → **`INSERT INTO Erp_Sync_Batches`** (`Status`, `Response_Code`, `Error_Message`, `Duration_MS`, `Trigger_Source`, exact `Payload_JSON`).
5. **Back to the UI:** the next `/api/erp/sync` GET (≤4–5 s later) returns `{ stats, batches[≤40], backlog[≤10], mode, erpUrl, failEvery, generatedAt }` → `SyncMini` counters on the dashboard and `SyncConsole` batch history/offline buffer on `/sync`; `LiveFeed` sync chips flip Pending → Synced per row.

```
┌─────────────┐  ADMS POST /api/biometrics/push?SN=…   ┌──────────────────────┐
│ Fingerprint  │ ─────────────────────────────────────► │ Attendance_Logs      │
│ terminal     │   (simulator writes the same rows)     │ ERP_Sync_Status =     │
│ (or mock)    │                                        │ 'Pending'            │
└─────────────┘                                        └──────────┬───────────┘
                                                                   │ poll (≤2.5s)
                     GET /api/dashboard · /api/terminals ·         ▼
                     /api/dashboard/exceptions  ◄──────────  Dashboard widgets
                                                                   │
             auto every 20s / POST /api/erp/sync (manual)          │
                                                                   ▼
┌──────────────────────────┐   buildErpPayload + deliver   ┌──────────────────┐
│ Erp_Sync_Batches         │ ◄──────────────────────────── │ runErpSync()     │
│ (audit: payload, HTTP,   │   Success→'Success' / 4xx→    │ src/lib/erp.ts   │
│  duration, trigger)      │   'Failed' / 5xx→ stays       │ (live fetch or   │
└──────────────────────────┘   'Pending' (buffer)          │  mock + fail/5)  │
                                                           └────────┬─────────┘
                                                                    ▼
                                                          External ERP REST API
                                                          (or built-in simulator)
```

**Configuration surface (env):** `ADMIN_PASSWORD` (default `biobridge-admin`), `SESSION_SECRET`, `ERP_API_URL`, `ERP_API_KEY`, `ERP_MOCK_MODE`, `ERP_MOCK_FAIL_EVERY` (default 5), `SIMULATOR_ENABLED`, `SIMULATOR_MIN_MS`/`SIMULATOR_MAX_MS`.

---

*Generated by static analysis of the repository. Sections marked **[Pending Implementation]** are routes/features referenced by the UI or prior discussions that do not exist in code yet.*
