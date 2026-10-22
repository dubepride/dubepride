# Users and roles

Mineazy Network has three roles and one closed set of ten capabilities.
Everything the console can do is gated on one of those capabilities.

---

## 1. The three roles

| Role | Label | Who it is for |
| --- | --- | --- |
| `administrator` | **Administrator** | The person who owns the installation. Configures monitoring, manages credentials and users, runs discovery. |
| `operator` | **Network Operator** | The person doing the work. Acknowledges incidents, edits the inventory, runs discovery. Cannot change monitoring configuration, credentials or accounts. |
| `viewer` | **Viewer** | Read-only. Watches the map, the states, the traffic and the incidents. Cannot change anything. |

### The capability matrix

| Capability | Administrator | Operator | Viewer |
| --- | :---: | :---: | :---: |
| `can_view_topology` — see the console | ✅ | ✅ | ✅ |
| `can_view_traffic` — traffic and performance history | ✅ | ✅ | ✅ |
| `can_view_reports` — event history and reports | ✅ | ✅ | ✅ |
| `can_manage_incidents` — acknowledge, assign, note | ✅ | ✅ | — |
| `can_edit_inventory` — edit devices, ports, locations, manual connections | ✅ | ✅ | — |
| `can_run_discovery` — run discovery, change authorised ranges | ✅ | ✅ | — |
| `can_config_monitoring` — intervals, thresholds, targets, collector mode | ✅ | — | — |
| `can_manage_credentials` — SNMP credentials | ✅ | — | — |
| `can_manage_users` — accounts and roles | ✅ | — | — |
| `can_export_data` — import / export inventory | ✅ | ✅ | — |

The full matrix lives in `src/lib/rbac.ts`, and it is the **only** source of
truth. The browser uses it to hide what a role cannot do, and every API route
re-checks it server-side. Hiding a button is never the only barrier — an
operator who crafts the request by hand still gets a `403`.

### What a Viewer actually sees

The navigation rail only lists the sections the signed-in role may open. A
Viewer sees:

* **Monitor** — Overview, Live Map
* **Inventory** — Devices, Switches & Ports, Locations
* **Operations** — Incidents, Traffic, Event History

and nothing under **Configure**. The Overview, Devices, Incidents and Traffic
screens render, but every action — acknowledge, edit, run — is absent or
disabled.

---

## 2. Creating an account

**Settings → Users → Add user** (Administrator only).

| Field | Rule |
| --- | --- |
| Username | Required, unique, case-insensitive. |
| Email | Required, unique, case-insensitive. |
| Display name | Optional; falls back to the username. |
| Role | `administrator`, `operator` or `viewer`. |
| Password | At least 8 characters. |
| Active | Unchecking it disables the account without deleting it. |

### Rules the system enforces

* **The last administrator cannot be deleted.** The API refuses with
  *"The last administrator account cannot be deleted."*
* **The last active administrator cannot be deactivated.** Deactivating the
  only administrator would lock everybody out permanently.
* **A disabled account cannot sign in**, and its existing sessions stop
  working immediately.
* **Usernames and emails are unique** across the whole installation.

### Password storage

Passwords are hashed with **scrypt** (a memory-hard KDF) using a random
per-user salt. The hash never leaves the database and is never returned by any
API. A password is only ever *set* or *changed* — there is no endpoint that
can read one back, and no administrator can see another user's password.

### Resetting a password

An Administrator can set a new password for any account from the same screen.
There is no "send a reset email" flow — this is a local-first product with no
mail infrastructure, and pretending otherwise would be dishonest.

---

## 3. Signing in

**Sessions are stateless and signed.** The cookie is:

```
base64url(claims) "." base64url(HMAC-SHA256(claims))
```

| Property | Value |
| --- | --- |
| Cookie name | `mineazy_session` |
| Flags | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` over HTTPS |
| Lifetime | 12 hours, then a fresh sign-in is required |
| Claims | user id, display name, email, role, expiry |

The cookie is **HttpOnly**, so JavaScript cannot read it and an XSS bug
cannot exfiltrate the session.

> **The role inside the token is only a hint for the UI.** Every
> authorisation decision loads the account from the database first. That is
> why demoting a user takes effect *immediately* rather than when their
> cookie expires.

### Brute-force protection

Failed sign-ins are counted in a 10-minute window. After **8** failures the
process refuses further sign-in attempts until the window passes or a
successful sign-in clears it. The counter is in-memory, so restarting the
console resets it.

### The session secret

`MINEAZY_SESSION_SECRET` is the HMAC key. Without it, the fallback key
`mineazy-dev-session-secret-change-me` is used — and that string is in the
source. **Set it in production.** The Settings screen warns when it is
missing.

Changing it signs every user out. That is the intended behaviour.

---

## 4. The first administrator

On the very first start, the application creates an account called `admin`:

* With `MINEAZY_ADMIN_PASSWORD` set, that is the password.
* Without it, a one-time random password is printed to the server console and
  is never displayed again.

The setup wizard at `/setup` does the same thing through the browser. It
refuses to run once an administrator exists.

**Change the password after the first sign-in.** The first-run password is
printed to a log; it is not a long-term secret.

---

## 5. Auditing

Every privileged action is written to `Audit_Log`:

| Column | Meaning |
| --- | --- |
| `At` | When it happened. |
| `User_ID` / `User_Name` | Who did it. |
| `Action` | `create`, `update`, `delete`, `run`, `acknowledge`, `resolve`… |
| `Entity` / `Entity_ID` | What was changed. |
| `Before` / `After` | The previous and new values, as JSON. |
| `Note` | A human-readable summary. |

View it under **Event History → Audit log**, or via `GET /api/audit`
(requires `can_view_reports`).

The audit log is **append-only** — there is no API that edits or deletes an
entry. It is separate from the operational `Events` log, which records what
the *system* did rather than what a *person* did.

---

## 6. Verifying the enforcement

The test suite covers the matrix directly (`tests/rbac.test.ts` and
`tests/security.test.ts`). To check it by hand:

```bash
# Sign in as a viewer and try to create a credential.
curl -i http://localhost:3100/api/credentials \
  -H 'content-type: application/json' \
  -d '{"name":"test","version":"2c","community":"public"}' \
  -b 'mineazy_session=<viewer session cookie>'
```

```http
HTTP/1.1 403 Forbidden
{"ok":false,"error":"Your role (viewer) does not include \"can_manage_credentials\"."}
```

And the same request as an administrator returns `200`.

---

## Next

* [install.md](install.md) — setting `MINEAZY_SESSION_SECRET` on a real
  install.
* [backup-and-restore.md](backup-and-restore.md) — what to back up before an
  upgrade.
