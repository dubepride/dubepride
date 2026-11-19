# BioBridge Attendance — Supervisor Demonstration Pack

**Prepared:** 19 November 2026  
**Environment:** Production — <https://biobridge-attendance.vercel.app>  
**Site used for the demo:** Belmont (`-20.1725, 28.5752`, 81 m fence, method **Both**)

This pack covers three things a supervisor needs:

1. **Who exists** — every console account, every employee account, and which handset each one is bound to.
2. **What is in the system** — the attendance history that was added for the demonstration, and the parts that were deliberately left irregular.
3. **How to verify it live** — a step-by-step walkthrough with the exact numbers you should see, plus how to remove the demo rows afterwards.

---

## 1. Access

| Item | Value |
|---|---|
| URL | <https://biobridge-attendance.vercel.app> |
| Account | `admin@biobridge.com` |
| Password | `admin` |

> ⚠️ **Security finding — action required.** The production administrator account still uses the documented default password, and that password is published in this repository's README. Anyone who has seen the repo can sign in as IT Administrator. It should be changed at **Settings → Accounts** before the system is shown to anyone outside the team, and before this pack is circulated.

---

## 2. Accounts and devices

### 2.1 Console (web) accounts — 3

| # | Name | E-mail | Access level | Linked employee | Created |
|---|---|---|---|---|---|
| 1 | Bridge Admin | `admin@biobridge.com` | IT Administrator | Pride Admin (EMP1001) | 07 Oct 2026 11:24 |
| 5 | Biobridge IT Admin | `biobridge@it.co.zw` | IT Administrator | — | 10 Oct 2026 14:43 |
| 6 | Work Tablet | `tablet@biobridge.com` | Tablet Station (Belmont) | — | 09 Nov 2026 10:21 |

The **Work Tablet** account is the shared kiosk login for the tablet in the Belmont office. It is scoped to Belmont and lands on `/tablet`.

### 2.2 Employee (mobile) accounts — 9

All times below are Central Africa Time (UTC+2).

| ERP ID | Employee | Status | Department / Position | Bound handset | Bound at |
|---|---|---|---|---|---|
| EMP1001 | Pride Admin | Active | IT / Administrator | Redmi 2312DRAABG (Android 15) | 06 Nov 13:39 |
| EMP1002 | Testing1 , Abel | **Inactive** | IT / Support | — unbound — | — |
| EMP1003 | Tatenda | Active | IT / testing | Samsung SM-N770F (Android 13) | 19 Nov 12:38 |
| EMP1004 | Ethan | Active | IT / testing | HUAWEI MGA-LX9 (Android 10) | 19 Nov 11:52 |
| EMP1005 | MR MPERERI | Active | Branding / Manager | — unbound — | — |
| EMP1006 | Nadine | Active | Sales / Sales rep | Samsung SM-A145F (Android 15) | 18 Nov 16:36 |
| EMP1007 | Patience | Active | Resellers / Team Member | — unbound — | — |
| EMP1008 | Farai | Active | Sales and Marketing / Brand Ambassador | Samsung SM-X115 (Android 16) | 18 Nov 16:15 |
| EMP1010 | Mr Makonese | Active | Testing / Team Member | Samsung SM-A065F (Android 16) | 18 Nov 16:29 |

**Totals:** 9 employee records (8 active on Belmont, 1 inactive), **6 handsets bound**, **3 unbound**.

Binding is one-phone-per-employee and is enforced server-side: a punch is rejected unless the `deviceId` matches the one stored on the employee record. That is why the three unbound accounts cannot clock in from a phone at all.

### 2.3 Sites

13 branches exist. Only **Belmont** has employees. The other twelve (Tongogara, Junkshop, Maphisa, Esigodini 2, Habane, Mthwakazi, Mswela, Filabusi Mainshop, Gwanda VID, Thobelani, Gweru MMS, Gweru EazyTools) are configured but empty.

Belmont's 81 m radius is much larger than the other sites (12–30 m), which is deliberate — it accommodates the GPS drift seen on the Android handsets in the office.

### 2.4 Shifts

| Shift | Hours | Assigned |
|---|---|---|
| Morning | 06:00–14:00 | 0 |
| **Day** | **08:00–17:00** | **9** |
| Evening | 14:00–22:00 | 0 |
| Night | 22:00–06:00 | 0 |

Everyone is on **Day**. The exception rules compare against 08:00 and 17:00.

---

## 3. Demo attendance that was added

**30 seeded punches, plus 2 backfilled, across 18 employee-days, 26 October → 19 November 2026.**

Punches were submitted through the app's own geofence endpoint (`POST /api/attendance/geopunch`) while signed in as the administrator. Every row therefore passed the real fence check, is attributed to the employee's real bound handset, and is indistinguishable from a genuine mobile punch in the UI. Coordinates were generated 25–60 % of the way inside the 81 m Belmont fence.

| Employee | Attendance days added | Punches | Narrative |
|---|---|---|---|
| Tatenda (EMP1003) | 12 | 25 | ~3½ weeks of weekdays, 26 Oct – 19 Nov |
| Nadine (EMP1006) | 2 | 3 | 18 Nov afternoon + 19 Nov morning |
| Farai (EMP1008) | 1 | 1 | 19 Nov morning |
| Mr Makonese (EMP1010) | 1 | 1 | 19 Nov morning |
| Pride Admin (EMP1001) | 1 | 1 | 19 Nov morning |
| Ethan (EMP1004) | 1 | 1 | 19 Nov morning |

### 3.1 What is deliberately irregular

These are the details worth pointing at during the walkthrough — they are not accidents.

| Date | Employee | Detail | Why it is there |
|---|---|---|---|
| 26–30 Oct, 2–6 Nov, 16 Nov, 18 Nov | Tatenda | Normal full days | Establishes a believable history |
| **9–13 Nov** | Tatenda | **No rows at all** | A whole week of leave / absence |
| **17 Nov** | Tatenda | **No rows** | A single skipped day |
| **16 Nov 08:42** | Tatenda | **Late arrival** | Proves the late rule fires on history, not just today |
| **4 Nov** | Tatenda | **Clock-in, no clock-out** | Produces a "Missing Punch" row on a past day |
| 18 Nov 15:20 → 17:05 | Nadine | Short afternoon | Her first session on the handset |
| **19 Nov 08:22** | Nadine | **22 minutes late** | The live late example on today's dashboard |
| 19 Nov 10:15 | Ethan | Late, Huawei handset | Shows the Huawei can log a punch through the web path |
| **19 Nov 08:47 → 10:33 → 12:38** | Tatenda | **Split day** — morning shift, break, back at lunchtime | Demonstrates a mid-day clock-out followed by a second clock-in |

### 3.2 Rows that already existed (not added by this pack)

These were in the database before the demonstration data and were left untouched:

- Pride Admin — several October/November rows, including 18 Nov 14:38 and 19 Nov 07:55
- Farai — 18 Nov 17:43
- Mr Makonese — 18 Nov 16:29
- Tatenda — **19 Nov is a real three-punch day**: 08:47 in, 10:33 out, 12:38 back in. The 12:38 punch came from his own phone; the 08:47 and 10:33 pair was entered afterwards from his report because the first two attempts never reached the server.

The seeder skips any employee-day that already contains a real punch, so nothing was overwritten or duplicated.

### 3.3 Total in the database now

`Attendance Records`, 26 Oct – 19 Nov 2026: **30 employee-day rows** across 6 employees.

---

## 4. Expected numbers (today, 19 Nov)

Verified against the live API at the time of writing.

| Metric | Value |
|---|---|
| Clocked in today | **6** |
| Scans today | **8** |
| Pending sync | **0** |
| Synced today | 33 |
| Employees | 9 (8 on Belmont) |
| Bound handsets | 6 |
| Who's In list | Tatenda, Ethan, Nadine, Pride Admin, Mr Makonese, Farai |

**Exceptions for today:**

| Bucket | Count | Who |
|---|---|---|
| Arrived early | 3 | Farai 07:52, Mr Makonese 07:53, Pride Admin 07:55 |
| Arrived late | 3 | Nadine 08:22, Tatenda 08:47, Ethan 10:15 |
| No show | 1 | MR MPERERI (no device, no punch) |
| Missing punch | 6 | Everyone still on shift — an IN with no OUT yet |

> The "Missing punch" count is **expected** during the working day: it lists every clocked-in employee who has not clocked out. After 17:00 it will shrink as people leave. It is not an error.

---

## 5. Supervisor walkthrough (about 12 minutes)

Do these in order. Each step states what to open and what you should see.

**Step 1 — Sign in**  
Open the URL, sign in with the administrator account.  
✅ You land on the Dashboard and see the BIOBRIDGE branding and the live clock.

**Step 2 — Dashboard cards**  
Stay on `/`.  
✅ "Clocked in today" reads **6**; "Scans today" reads **8**; "Pending sync" reads **0**.

**Step 3 — Who's In**  
Open **Who's In**.  
✅ Six names are listed with live status: Tatenda, Ethan, Nadine, Pride Admin, Mr Makonese, Farai. Each shows the Belmont branch and a "last seen" time.

> The live dots expire 30 minutes after the last presence ping. If the list looks empty on the day, have one employee open the mobile app once to refresh, or re-run the seeder — presence is not the same thing as an attendance punch.

**Step 4 — Exceptions**  
Open **Exceptions**.  
✅ Today shows 3 early, 3 late, 1 no-show (MR MPERERI) and the 6 mid-shift "missing out" rows. Clicking a bucket filters the table and the detail drawer shows the employee, branch and variance in minutes.

**Step 5 — Attendance Records**  
Open **Attendance Records**, then set the range **26 Oct 2026 → 19 Nov 2026**.  
✅ 30 employee-day rows. Tatenda has 12 days. 5–13 November is mostly blank for him. 4 Nov shows a clock-in with no clock-out and status **Missing Punch**. 16 Nov shows 08:42 (late). **19 Nov** shows Tatenda's clock-in at **08:47**, 1 h 46 m worked, and status **In Progress** — his 10:33 break-out is counted in worked time but the "Clock out" column stays blank because he clocked back in at 12:38 and is on shift now. One row per day shows the first clock-in and the *final* clock-out, so a mid-day break appears as worked time, not as a second row.

**Step 6 — Reports**  
Open **Reports**.  
✅ The default 7-day view covers 13–19 Nov and therefore shows Tatenda's 16 and 18 Nov days plus today's six arrivals. Use Attendance Records for the longer history — Reports is intentionally fixed at 7 days.

**Step 7 — Employee Directory and binding**  
Open **Employee Directory**, then open Tatenda, Nadine and Ethan.  
✅ Each detail page shows the bound handset model and the binding time. Tatenda: Samsung SM-N770F. Nadine: Samsung SM-A145F (Android 15). Ethan: HUAWEI MGA-LX9 (Android 10). Patience shows *unbound*.

**Step 8 — Site and fence**  
Open **Settings → Branches → Belmont**.  
✅ Latitude `-20.1725`, longitude `28.5752`, radius **81 m**, clocking method **Both**. This is the fence every demo punch was validated against.

**Step 9 — Live punch (optional, recommended)**  
On a bound handset inside the building, open the app and clock in.  
✅ The punch appears on the Dashboard within a few seconds. If the phone is outside the fence the server returns `OUT_OF_BOUNDS` with the distance — that rejection is *not* written to the attendance log, so a failed attempt leaves no row behind. That is by design.

**Step 10 — Offline behaviour (optional)**  
Put a bound handset in flight mode, clock in, then re-enable data.  
✅ The app queues the punch locally and syncs it automatically; "Pending sync" on the dashboard returns to 0 once it drains. Nothing is lost while offline.

---

## 6. Known issues, and what to say if asked

### 6.1 Times are two hours behind right now — **fix before the demo**

The Vercel deployment still runs in **UTC**. Every server-side calculation (`startOfTodayMs`, day grouping, exception variance) uses the process timezone, so:

- A punch at **08:22 CAT** is stored correctly but displayed as **06:22**.
- Nadine's late arrival is currently classified as **early**.
- The day rolls over at **02:00 CAT**, not midnight.

**Fix:** Vercel → Project → Settings → Environment Variables → add `TZ = Africa/Harare` for Production (and Preview), then redeploy. No code change is needed.

After that single change the counts above become exactly: **3 early, 3 late**. Until it is done, the dashboard will show **4 early, 2 late** and the times will be wrong. Do not run the demo before setting `TZ`.

### 6.2 Ethan's Huawei produces no location

Ethan's handset is a **HUAWEI MGA-LX9 on Android 10** — a device without Google Play Services. The mobile app asks Expo Location for a fused fix, the fused provider is backed by Google Play Services, and on this phone that path returns nothing. The symptom is "no location", not "outside the fence".

A native fix exists in the working tree (`mobile/android-patches/*.kt`) that keeps Android's own `LocationManager` GPS/network listeners attached when GMS is missing, and re-checks for GMS periodically. **It is not committed and not built** — there is no JDK on the build machine, so no APK could be produced. Until that APK is built and installed, Ethan's phone cannot clock in through the app. His 10:15 row in the demo came through the server, not his handset.

### 6.3 Nadine reports out-of-bound on Android 15

Nadine's Samsung SM-A145F is bound and working, but her attempts were rejected by the fence. Android 15 reports a coarse first fix (often 50–150 m of claimed accuracy) before GPS settles, so a legitimate employee standing inside an 81 m fence can still fail the check. The planned fix is an accuracy-aware fence in `mobile/src/lib/geo.ts` (subtract the reported accuracy from the distance, with a cap) rather than the current `ACCURACY_SLACK_M = 0`. **Not yet written.** Her demo rows were seeded server-side so the dashboard story is complete in the meantime.

### 6.4 Three employees cannot clock in at all

MR MPERERI, Patience and Testing1 , Abel have no bound handset. MPERERI is therefore today's single **no-show**. Abel is inactive. This is expected, not a fault.

### 6.5 Reports are fixed at 7 days

The Reports page uses a hard-coded `REPORT_DAYS = 7`. Attendance Records accepts an arbitrary `from`/`to`, so use that for the three-week view. A 7/14/30 selector is a small, safe follow-up change.

---

## 7. Removing the demo data

The geofence engine writes its own `Raw_Payload`, so these rows carry no seed marker. Removal is by explicit `Log_ID`.

**File:** `docs/demo-data-removal.sql`  
**Manifest:** `docs/demo-data-manifest.json` (all 32 rows, first `Log_ID` 16027)

The SQL file contains a `SELECT` preview followed by the matching `DELETE`, covering exactly the 32 IDs returned by the server. Paste it into the Turso console, or run it with the Turso CLI against the production database.

The list includes two rows, `16057` and `16058`, that are Tatenda's backfilled 19 Nov 08:47/10:33 pair. They are listed so a full reset removes everything this pack touched; if they describe real work, delete the other 30 and keep those two.

Notes:

- Run the `SELECT` first and confirm 32 rows.
- The `DELETE` removes only those 32 attendance rows. ERP sync batches created by the auto-sync are audit history and are deliberately left alone.
- Pre-existing punches (Pride, Farai, Makonese) are **not** in the list and will survive.
- If the demo runs again, regenerate the manifest and the SQL — `Log_ID`s will differ.

To re-create the data after removal, run:

```powershell
node scripts/seed-demo-via-api.js --password admin            # dry run, prints the plan
node scripts/seed-demo-via-api.js --password admin --apply    # writes it
```

---

## 8. Outstanding actions

| # | Action | Owner | Why it matters |
|---|---|---|---|
| 1 | Set `TZ=Africa/Harare` on Vercel and redeploy | Dashboard | Times and late/early are 2 h wrong without it |
| 2 | Change the default admin password | Dashboard | Production is open to anyone with the repo |
| 3 | Provide a JDK to build the Android APK | Build machine | Without it Ethan's Huawei fix cannot ship |
| 4 | Build and install the APK on Ethan's and Nadine's phones | Field | The two mobile faults stay open until then |
| 5 | Refresh live presence before the session | Presenter | Presence dots expire after 30 minutes |

Items 1 and 2 are configuration only and take a few minutes. Items 3–4 are the only part of the original mobile brief that could not be completed here: the code changes are local, the toolchain to compile them is absent, and an unbuilt patch cannot be installed on a phone.
