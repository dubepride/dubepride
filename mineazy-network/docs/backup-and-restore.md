# Backup and restore

Everything Mineazy Network knows lives in three files in the `data/`
directory:

| File | What it holds | Losable? |
| --- | --- | --- |
| `data/mineazy.db` | The database: devices, ports, connections, observations, traffic samples, incidents, events, the audit log, settings, users and encrypted SNMP credentials. | **No.** |
| `data/secret.key` | The AES-256-GCM key that decrypts the stored SNMP credentials. | **No** — without it the credentials are unrecoverable. |
| `data/collector.lock` | The single-writer lock. | Yes. It is recreated on the next start. |

If you set `MINEAZY_SECRET_KEY` in the environment instead of letting the
application generate one, then `secret.key` is not needed — but you must back
up the **environment variable** itself, because it cannot be recovered from
the database.

> **Back up the database *and* the key together.** A database without its key
> keeps every device, port, connection, incident and event — but the stored
> SNMP credentials become unreadable and have to be re-entered.

---

## 1. A safe backup

The database runs in SQLite's **WAL** mode, which means there are three
files in play: `mineazy.db`, `mineazy.db-wal` and `mineazy.db-shm`. Copying
only `mineazy.db` while the collector is running can produce a torn file.

The application exposes a checkpoint endpoint precisely so this is safe.

### Option A — the console (recommended)

**Settings → Maintenance → Checkpoint the database**

or over the API:

```bash
curl -X POST http://localhost:3100/api/settings \
  -H 'content-type: application/json' \
  -d '{"action":"checkpoint"}'
```

```json
{"ok":true,"action":"checkpoint","detail":"The write-ahead log was flushed into the database file."}
```

This flushes the write-ahead log into the main database file. After it
returns, `mineazy.db` is self-contained and can be copied on its own.

> The endpoint requires an authenticated session with
> `can_config_monitoring` (an Administrator). The action is written to the
> audit log and the event history.

### Option B — stop the collector first

The simplest, safest approach: stop writing, copy, start again.

```bash
sudo systemctl stop mineazy-collector
cp data/mineazy.db /backup/mineazy-$(date +%F).db
cp data/secret.key  /backup/secret-$(date +%F).key
sudo systemctl start mineazy-collector
```

On Windows:

```powershell
# Stop the collector window (Ctrl+C), then:
Copy-Item data\mineazy.db "D:\backups\mineazy-$(Get-Date -Format yyyy-MM-dd).db"
Copy-Item data\secret.key "D:\backups\secret-$(Get-Date -Format yyyy-MM-dd).key"
```

### Option C — copy all three files together

If you cannot stop anything, copy the whole set at once:

```bash
tar -czf /backup/mineazy-$(date +%F).tar.gz data/mineazy.db data/mineazy.db-wal data/mineazy.db-shm data/secret.key
```

Copying the WAL and the main file together is safe as long as they come from
the same moment; the `-shm` file is a shared-memory index and can be skipped.

### Option D — the SQLite backup API (the most correct one)

`sqlite3` has a proper online backup command:

```bash
sqlite3 data/mineazy.db ".backup '/backup/mineazy-$(date +%F).db'"
```

This takes a consistent snapshot while the database is in use, with no
downtime and no torn pages.

### What a good backup looks like

```bash
ls -la /backup/
-rw-r--r-- 1 mineazy mineazy  412992 Oct 22 09:14 mineazy-2026-10-22.db
-rw------- 1 mineazy mineazy      64 Oct 22 09:14 secret-2026-10-22.key
```

Then **prove it restores**:

```bash
sqlite3 /backup/mineazy-2026-10-22.db "SELECT COUNT(*) FROM Devices;"
sqlite3 /backup/mineazy-2026-10-22.db "PRAGMA integrity_check;"
```

`integrity_check` must print `ok`.

---

## 2. Restoring

### From a single-file backup

```bash
sudo systemctl stop mineazy-console mineazy-collector

cp /backup/mineazy-2026-10-22.db data/mineazy.db
cp /backup/secret-2026-10-22.key  data/secret.key

# Remove any stale write-ahead log from the failed instance.
rm -f data/mineazy.db-wal data/mineazy.db-shm

sudo systemctl start mineazy-console mineazy-collector
```

> **Do not restore the database without the matching key.** The application
> will start and everything will work *except* that the stored SNMP
> credentials cannot be decrypted. The collector will report the affected
> devices as unreachable, which looks exactly like a network fault. If you
> restore the database, restore the key from the same backup.

### Verifying the restore

```bash
curl http://localhost:3100/api/health
```

```json
{"ok":true,"databaseReady":true,"adminAccountExists":true,"demoMode":false,"collectorMode":"real"}
```

Then sign in and check **Settings → SNMP credentials** — the credentials should
still be listed with their redacted previews intact. If they are listed but
the devices are unreachable, the key does not match the database.

---

## 3. Migrating to a new machine

1. **On the old machine**, take a backup (Option A or B above).
2. **Copy the files** to the new machine:

   ```bash
   scp mineazy@old:/backup/mineazy-2026-10-22.db ./mineazy.db
   scp mineazy@old:/backup/secret-2026-10-22.key ./secret.key
   ```

3. **On the new machine**, install the application and place the files:

   ```bash
   cd /opt/mineazy-network
   npm ci && npm run build
   mkdir -p data
   cp ~/mineazy.db data/mineazy.db
   cp ~/secret.key  data/secret.key
   chmod 600 data/secret.key
   sudo systemctl start mineazy-console mineazy-collector
   ```

4. **Keep `MINEAZY_SESSION_SECRET`** if you used one. If you change it,
   everybody is signed out — harmless, but annoying.

### Moving to a remote libSQL / Turso database

The application speaks the same SQL dialect against a remote libSQL database:

```dotenv
MINEAZY_DATABASE_URL=libsql://your-db.turso.io
MINEAZY_DATABASE_TOKEN=your-token
```

Migrate the data with the libSQL CLI:

```bash
turso db shell your-db.turso.io < data/mineazy.db
```

The local `secret.key` still applies — the credentials are encrypted before
they are written, so they travel encrypted.

> A remote database is **not** local-first any more: the estate leaves the
> network. The console keeps working, but the data is now on someone else's
> infrastructure. Use it only if that is a deliberate decision.

### Upgrading to a new release

Take a backup first (Option A or B above). Then install the new version and
restart it — that is the whole procedure.

The schema is migrated **in place, on start**:

1. missing base tables are created;
2. missing columns are added with `ALTER TABLE` (additive only — nothing is
   ever dropped or rewritten);
3. the indexes are created last, because several of them cover the newly
   added columns.

Your inventory, ports, connections, history, incidents, audit log, settings
and encrypted credentials are carried across untouched. The migration is
idempotent, so restarting twice is harmless.

> The upgrade is additive only. There is no down-migration: rolling back to
> an older release leaves the newer columns in place, which the older code
> ignores. Take a backup before an upgrade so that a rollback is a file copy
> rather than a schema problem.

---

## 4. Docker

The data lives in the `mineazy-data` volume.

```bash
# Back up the whole volume.
docker run --rm \
  -v mineazy-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar -czf /backup/mineazy-data.tar.gz -C /data .

# Restore it.
docker run --rm \
  -v mineazy-data:/data \
  -v "$PWD":/backup \
  alpine sh -c "cd /data && tar -xzf /backup/mineazy-data.tar.gz"

docker compose restart
```

Stop the collector before restoring, so nothing writes while the files are
being replaced:

```bash
docker compose stop collector
# ... restore ...
docker compose start collector
```

---

## 5. A sensible schedule

| How often | What |
| --- | --- |
| **Nightly** | A database + key backup, kept for 30 days. |
| **Before every upgrade** | A backup you have verified restores. |
| **Before any bulk edit** | A backup. The console has no undo for a device mass-edit. |
| **After adding a credential** | A backup — otherwise a lost key means re-entering every SNMP secret. |

A minimal cron entry:

```cron
30 2 * * * cd /opt/mineazy-network && sqlite3 data/mineazy.db ".backup '/backup/mineazy-$(date +\%F).db'" && cp data/secret.key /backup/secret-$(date +\%F).key && find /backup -name 'mineazy-*.db' -mtime +30 -delete
```

---

## 6. What is *not* backed up by copying the database

| Thing | Where it lives | How to back it up |
| --- | --- | --- |
| `MINEAZY_SESSION_SECRET` | The environment | Your secret store. Changing it signs everyone out. |
| `MINEAZY_SECRET_KEY` | The environment | Your secret store. |
| `MINEAZY_ADMIN_PASSWORD` | The environment (first run only) | Not needed after the account exists. |
| The authorised scan ranges | The database (`Scan_Targets`) | Included in the database backup. |
| The collector mode and thresholds | The database (`Settings`) | Included in the database backup. |
| The `.env` file | The filesystem | Your configuration management. Never commit it. |

---

## 7. Retention

Observations and traffic samples accumulate. A large estate running a 30-second
poll produces a lot of rows.

The **Settings** screen holds the retention windows:

| Setting | Default | Meaning |
| --- | --- | --- |
| `retention.observationDays` | 7 | How long health observations are kept. |
| `retention.trafficDays` | 14 | How long traffic samples are kept. |
| `retention.eventDays` | 90 | How long the event log is kept. |

Old rows are pruned by the collector. **Incidents, the audit log, the device
inventory and the credentials are never pruned automatically** — the audit log
in particular is append-only and grows forever by design.

If the database grows too large, check the file size first:

```bash
ls -lh data/mineazy.db*
sqlite3 data/mineazy.db "SELECT COUNT(*) FROM Traffic_Samples;"
```

---

## Next

* [troubleshooting.md](troubleshooting.md) — when a restore goes wrong.
* [install.md](install.md) — where the `data/` directory lives on your
  platform.
