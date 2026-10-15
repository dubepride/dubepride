# BIOBRIDGE Mobile — Hands-Free Geofenced Clocking

The Expo companion app for the BIOBRIDGE Time & Attendance bridge. Its only
job is to clock an employee in and out **without them touching anything**: the
phone notices they have arrived at a registered site, waits to make sure they
are staying, and files the punch.

An employee may clock in at **any registered site**, not just the branch on
their roster row — the fence that matters is the one they are physically inside.
The app watches every registered fence at once, but the **bridge** decides which
one a punch belongs to (§4); the phone never gets to claim a branch.

Biometric terminals remain the primary channel. This app is the optional
secondary one, and the bridge refuses a mobile punch at any site whose
**Clocking Method** is `Biometric`.

---

## 1. Prerequisites

| | |
|---|---|
| Node | 20+ (same as the bridge) |
| Expo SDK | 57 (React Native 0.86, React 19.2) |
| Bridge | running and reachable from the phone |

Install:

```powershell
cd mobile
npm install
```

## 2. Configure the server address

Two values live in `app.json` → `expo.extra`:

| Key | Meaning |
|---|---|
| `apiUrl` | Base URL of the BIOBRIDGE bridge, **no trailing slash** |
| `mobileKey` | Shared secret sent as `x-mobile-key`; must equal the bridge's `MOBILE_PUNCH_KEY` (default `biobridge-mobile`) |

Defaults are set for the emulator:

- **Android emulator** — `http://10.0.2.2:3000` (the emulator's alias for your
  machine's `localhost`). Nothing to change.
- **iOS simulator** — `http://localhost:3000`.
- **Physical phone** — use your machine's LAN address, e.g.
  `http://192.168.1.42:3000`.

You do **not** need to rebuild to change this: the login screen has a
"Change server address" disclosure that overrides it at runtime, and the last
working address is remembered.

> Make sure the bridge is listening on your LAN interface
> (`npx next dev -H 0.0.0.0` or the equivalent for `next start`), and that
> Windows Firewall allows the port.

### Every site you want phones to use must be registered

The app can only clock someone in at a branch the bridge knows about. A branch
becomes a usable mobile site when **both** are true in
**Settings → Branches** (or the `Branches` table):

| Field | Required value |
|---|---|
| `Clocking_Method` | `Geofence` or `Both` — `Biometric` keeps the site terminal-only |
| `Latitude` / `Longitude` / `Geofence_Radius_Meters` | a centre and a positive radius |

There is no "assign the employee to a branch" step for mobile clocking: an
employee clocking in *away from* their roster branch is the whole point. Their
roster branch (`Employees.Branch_Name`) is only their home site, used for
display and reporting.

To fill every branch in for a demo, there is a script at the repo root:

```powershell
node scripts/seed-branch-geofences.js --dry-run   # report only
node scripts/seed-branch-geofences.js             # fill branches with no centre yet
node scripts/seed-branch-geofences.js --force     # overwrite every branch
```

It writes plausible **Harare-area demo coordinates** ~1.4–2 km apart with 500 m
radii and sets `Clocking_Method='Both'` (so the fingerprint terminals keep
working). That is enough to demonstrate travelling, but re-centre each branch on
its real position before relying on it. By default a branch that already has a
centre is left alone, and the script prints a pairwise-distance report so you
can see immediately if two fences overlap.

> Two overlapping fences are not an error — the fix is awarded to whichever
> centre is nearest — but keep them disjoint if you want the demo to be
> unambiguous.

### Plain HTTP in release builds — the "Cannot reach the bridge" trap

BIOBRIDGE talks to the bridge over plain **`http://`** on the LAN. Android 9
(API 28) and later **block cleartext HTTP by default**, and Expo's template only
sets the escape hatch `android:usesCleartextTraffic="true"` in the **debug**
manifests (`android/app/src/debug/`). A **release** APK therefore refuses every
request at the OS level and the login screen reports:

> *Cannot reach the bridge, and this device has no saved session for that ID.
> Connect once to sign in.*

…even when the server, firewall and Wi-Fi are all fine. Symptom to recognise:
identity + PIN are never even attempted, and there is no `POST` in the server log.

The flag is applied in two places:

1. `plugins/withAndroidCleartext.js` (registered first in `app.json` →
   `expo.plugins`) — re-applies it after any `npx expo prebuild`.
2. `android/app/src/main/AndroidManifest.xml` — written by hand, for builds that
   skip prebuild (the current release build does).

Verify a built APK actually carries it:

```powershell
aapt2 dump xmltree --file AndroidManifest.xml BIOBRIDGE-Mobile.apk |
  Select-String usesCleartextTraffic
```

## 3. Run it

```powershell
cd mobile
npx expo run:android     # or: npx expo run:ios
```

> **This app will not fully work in Expo Go.** Continuous background location
> and the Android foreground service need native code that Expo Go does not
> embed. Use a development build (`expo run:*`). The UI will render in Expo Go
> so you can style-check it, but hands-free clocking will not.

### Permissions the app will ask for

1. **Location — While using the app.** Required before Android will even offer
   the next prompt.
2. **Location — Allow all the time.** Without this, background location is
   refused and hands-free clocking cannot run.
3. **Notifications** (Android 13+). The foreground-service notification that
   keeps monitoring alive while the app is closed.

On some Android skins (Xiaomi, Huawei, Samsung) you must also exempt the app
from battery optimisation, or the OS will kill the monitor overnight:

**Settings → Apps → BIOBRIDGE → Battery → Unrestricted**

## 4. How the 3-minute dwell actually works

This is the part most worth reviewing, because the obvious implementation is
wrong.

### The trap

You cannot do this:

```ts
// ✗ NEVER FIRES
TaskManager.defineTask(GEOFENCE_TASK, ({ data }) => {
  if (data.eventType === GeofencingEventType.Enter) {
    setTimeout(() => punch(), 3 * 60 * 1000);
  }
});
```

A background task's JS context is **suspended as soon as its callback
returns**. Android dozes the process, iOS suspends it, and a headless JS
context has no event loop between OS wake-ups — so that timer is simply never
delivered. `DWELL_MS` would be a lie.

### What this app does instead

Two tasks cooperate, and the dwell is a **state machine evaluated on real
location fixes** rather than a timer:

```
        ENTER (OS region event, one region per registered site)
              │
              ▼
   arm dwell  { branch, enteredAt: now, samples: 1 }   ← nothing is sent yet
              │
              │  background fixes every 30s while armed
              ▼
   each fix: which registered site am I in?
        ├─ none ─────────────────────► clear dwell, back to the relaxed cadence
        └─ yes ─► still inside *this visit's* site?
                    ├─ no ──────────► arm a NEW visit at the site we are in
                    └─ yes ─► samples++
                                │
                                ▼
                    elapsed ≥ 180s AND samples ≥ 2 ?
                                ├─ no  ──────► record the fix and wait
                                └─ yes ──────► stamp firedAt, then send the punch
                                               (offline → queue it with the original timestamp)
```

Three consequences worth knowing:

- **`DWELL_MS` (180 s) is exact; the *confirmation* is quantised by the fix
  interval.** A punch lands on the first fix whose elapsed time exceeds 180 s —
  never earlier, later by at most one interval.
- **The cadence runs at two speeds** so that quantisation is tight without
  draining the battery while idling:

  | State | Interval | Punch lands |
  |---|---|---|
  | relaxed (idle) | 120 s | 3:00–5:00 after entry |
  | armed (dwelling) | 30 s | 3:00–3:30 after entry |

  The `ENTER` event requests the armed cadence; the punch (or leaving the
  fence) requests the relaxed one.
- **One punch per visit.** `firedAt` is set the instant the punch is claimed —
  *before* the network call — and is only cleared when the employee leaves the
  fence. Without that, a stationary employee would punch again every ~3 minutes
  and the bridge, which infers IN/OUT from the punch sequence, would record
  nonsense. Walking out and back in is a new visit and does produce a new punch.

### Verifying it on Android

Watch the task log (every transition is logged under one prefix):

```powershell
adb logcat | Select-String "biobridge:geofence"
```

You should see, in order: `region ENTER …` → `armed dwell …` →
`fix cadence → armed` → repeated `dwelling 30s / 180s (2 fixes, 12 m from
centre)` → `dwell complete after 181s — sending punch` → `punch accepted: …`.

To drive it without walking around, move the emulator's position:

```powershell
# adb emu geo fix takes LONGITUDE first, then latitude
adb emu geo fix 31.0534 -17.8277      # Branch 1's centre — step inside its fence
adb emu geo fix 31.0339 -17.8277      # Branch 5's centre — a different registered site
adb emu geo fix 31.4000 -17.9500      # nothing at all — expect an OUTSIDE_GEOFENCE exception
```

Then confirm the row landed in the bridge (it should be `Pending`, appear in the
dashboard feed as a `Geofence` punch within a second or two, and show the
resolved site in `Branch_Name`).

The timing to check: the `dwelling …` lines should cross 180 s at a **30 s**
granularity, and the punch should fire on the first sample at or after 180 s.

## 5. Offline behaviour

A punch that cannot reach the bridge is never lost. The payload is stored
verbatim — **including the original `timestamp`**, because that is the moment
the employee was at the gate — in AsyncStorage, and replayed oldest-first:

- Transport failure, or a bridge `5xx` → the punch is queued.
- The dashboard shows everything waiting, with a **Sync Now** button.
- **FIFO order matters**: the bridge infers IN/OUT from the punch sequence, so
  replaying out of order would invert a clock-in and a clock-out.
- A policy answer is *not* queued. `OUTSIDE_GEOFENCE` is a real verdict (the
  bridge has already logged it as a denied exception), and `BIOMETRIC_ONLY`
  will never change — retrying those would loop forever.

Sign-in works offline too, but only against a session this device has already
verified: same Employee ID, same PIN, bridge unreachable.

## 6. Manual fallback

The dashboard's **Clock In / Out** button sends the same payload to the same
endpoint. It is a fallback, not a bypass — the bridge still works out which
registered site you are in, still measures the distance, and still rejects
anything outside the radius. It is the right tool indoors (where GPS is poor),
at a site whose fence is not configured yet, and whenever the employee simply
does not want to rely on the monitor.

## 7. Server contract

| | |
|---|---|
| `POST /api/mobile/login` | Employee ID + PIN → identity + **`fences`** (every registered site the phone may use) + `geofence` (the employee's home branch, for display only — it may be `null`). Headers: `x-mobile-key`. `401` = bad key or bad credentials. Sign-in is *not* gated on the home branch: an employee rostered to a biometric-only site can still sign in and clock in elsewhere. |
| `POST /api/attendance/geopunch` | The punch. Same header. `200 ok:false reason:"OUTSIDE_GEOFENCE"` is a recorded exception, not a failure; `403 BIOMETRIC_ONLY` means the fix is inside a site that requires the terminal. |

The request carries **only coordinates** — no branch. The bridge resolves the
site itself, in this order, and returns which rule decided it in
`geo.detectedBy`:

| `detectedBy` | When | Behaviour |
|---|---|---|
| `terminal` | the payload named a `terminalRef` | the terminal's branch wins (device-level override) |
| `branchRef` | the payload named a `branchRef` | **strict** — validated against that branch's fence, with no fallback |
| `auto` | neither was sent (the app's normal path) | the fix is matched against every mobile-capable fence; nearest centre wins when fences overlap |

A fix outside every fence is judged against the **nearest** registered site, so
the exception row names a real place and carries a meaningful distance
(`geo.nearestBranch` / `geo.nearestDistanceMeters`). Leaving `branchRef` out is
deliberate: a phone that could name its own branch could name the wrong one.

The resolved site is written to `Attendance_Logs.Branch_Name`, so "who clocked
in where" is directly queryable.

The PIN is a *device* credential (an ATM PIN), verified server-side so a phone
cannot invent an identity. Every employee can be given a personal PIN
(`Employees.Mobile_PIN`); until then the bridge's `MOBILE_DEFAULT_PIN`
(default `0000`) applies.

## 8. Layout

```
mobile/
├── App.tsx                     shell: one context, two screens
├── index.ts                    entry — registers the background tasks
└── src/
    ├── theme.ts                the palette (see below)
    ├── components/             Panel · PrimaryButton · StatusChip
    ├── screens/                Login · Dashboard
    ├── hooks/                  useGeofenceStatus · usePendingQueue
    ├── lib/
    │   ├── api.ts              transport + failure taxonomy
    │   ├── geo.ts              Haversine, per-site fence verdict + ranking, dwell constants
    │   ├── queue.ts            the offline queue (serialised, FIFO)
    │   ├── session.ts          auth context + sign-in / offline unlock
    │   ├── storage.ts          SecureStore (session, PIN) · AsyncStorage (queue, dwell)
    │   └── types.ts            mirrors the bridge's wire shapes
    └── tasks/geofenceTask.ts   ★ the task definitions and the dwell state machine
```

## 9. Design tokens

Matching the Next.js dashboard:

| Token | Hex | Used for |
|---|---|---|
| Background | `#0a0a0a` | Pitch black page |
| Panel | `#2d1b4e` | Deep purple cards |
| Text | `#ffffff` | Primary copy |
| Accent | `#00e676` | Neon green buttons, active chip |
| Recessed | `#1d1233` | Inputs, nested boxes |
| Border | `#452f6b` | Hairlines |

## 10. Type-checking

```powershell
cd mobile
npm run typecheck
```

The root Next.js project excludes `mobile/` from both `tsc` and ESLint, so the
two toolchains stay independent — run each from its own directory.

## 11. Known limitations

- **Not verified on a physical device in this repo.** The logic is written
  against the documented platform behaviour; the `adb` recipe in §4 is the
  fastest way to confirm the timing on your hardware.
- Region monitoring is a *fast path* only. Android rejects radii under 100 m,
  so the registered region is `max(configured, 100)`. The verdict always uses
  the configured radius and the real distance, so a 60 m zone still behaves as
  60 m.
- One OS region is registered **per site**. Android caps a single app at ~100
  regions, which is far above any realistic branch list; if registration is
  ever refused, the fix stream still detects arrival within one 30 s interval,
  just without the immediate ENTER wake-up.
- A punch is claimed once per visit. Walking from one registered site to
  another starts a **new** visit (and so can earn a new punch); if the dwell
  fires while the employee is genuinely on site but the punch is refused (e.g.
  the site was switched to Biometric), they must leave and re-enter, or use the
  manual button.
- The background engine only *proposes* a time and a place. The bridge is the
  authority on both: a phone cannot name a branch it is not standing in, and a
  queued punch keeps its original timestamp.
- The foreground-service notification is static; there is no local
  "you have been clocked in" toast yet.
- `android/` and `ios/` are git-ignored — this project uses continuous native
  generation, so run `npx expo prebuild` to regenerate them.
