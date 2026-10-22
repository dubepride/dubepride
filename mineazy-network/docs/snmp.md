# SNMP setup

Mineazy Network polls managed devices over SNMP. SNMP is what gives the
console the things it cannot infer from a ping: interface inventory,
negotiated speed, duplex, per-port error and discard counters, LLDP/CDP
neighbours, the MAC forwarding table and the ARP cache.

This guide covers three things:

1. What the collector reads, and what it needs in order to read it.
2. How to turn SNMP on for the vendors you actually have.
3. How to store the credentials safely.

---

## 1. What the collector reads

Every OID below is walked by `src/lib/net/snmp.ts`. If a subtree is not
exposed by the device, the walk returns nothing and the console simply reports
that the information is unavailable — it never invents a value.

### System identity

| What | OID |
| --- | --- |
| `sysDescr` | `1.3.6.1.2.1.1.1.0` |
| `sysObjectID` | `1.3.6.1.2.1.1.2.0` |
| `sysUpTime` | `1.3.6.1.2.1.1.3.0` |
| `sysName` | `1.3.6.1.2.1.1.5.0` |

`sysName` becomes the device's hostname. It is only used when the device does
**not** have a name you set by hand — the collector never overwrites an
administrator's label (`Name_Locked`).

### Interface inventory

| What | OID |
| --- | --- |
| `ifDescr` | `1.3.6.1.2.1.2.2.1.2` |
| `ifType` | `1.3.6.1.2.1.2.2.1.3` |
| `ifSpeed` | `1.3.6.1.2.1.2.2.1.5` |
| `ifPhysAddress` | `1.3.6.1.2.1.2.2.1.6` |
| `ifAdminStatus` | `1.3.6.1.2.1.2.2.1.7` |
| `ifOperStatus` | `1.3.6.1.2.1.2.2.1.8` |
| `ifLastChange` | `1.3.6.1.2.1.2.2.1.9` |
| `ifHighSpeed` | `1.3.6.1.2.1.31.1.1.1.15` |
| Bridge port → ifIndex | `1.3.6.1.2.1.17.1.4.1.2` |

`ifOperStatus` is the single most valuable column: it is what tells the
console that a **physical link** is down (`LINK_DOWN`) as opposed to a device
that stopped answering (`OFFLINE`).

### Traffic counters

| What | OID |
| --- | --- |
| `ifHCInOctets` / `ifHCOutOctets` | `1.3.6.1.2.1.31.1.1.1.6` / `.10` |
| `ifHCInUcastPkts` / `ifHCOutUcastPkts` | `1.3.6.1.2.1.31.1.1.1.7` / `.11` |
| `ifInOctets` / `ifOutOctets` | `1.3.6.1.2.1.2.2.2.1.10` / `.16` |
| `ifInErrors` / `ifOutErrors` | `1.3.6.1.2.1.2.2.2.1.14` / `.20` |
| `ifInDiscards` / `ifOutDiscards` | `1.3.6.1.2.1.2.2.2.1.13` / `.19` |

**The 64-bit high-capacity counters are preferred.** A 32-bit counter wraps at
about 4.3 GB, which on a busy gigabit port is roughly 35 seconds. The 32-bit
family is only used as a fallback, and the console records which family the
numbers came from.

Rollover is handled in `src/lib/traffic.ts`: a counter that goes *backwards*
is treated as a reset, not as a 40 Gbps spike, and the sample is stored with
`Counter_Valid = 0` so no rate is published for it.

### Neighbours and forwarding

| What | OID |
| --- | --- |
| LLDP remote table | `1.0.8802.1.1.2.1.4.1.1.*` |
| CDP cache | `1.0.8802.1.4.1.9.9.23.1.2.2.1.*` |
| `dot1dTpFdbAddress` / `dot1dTpFdbPort` | `1.3.6.1.2.1.17.4.3.1.1` / `.2` |
| `dot1qTpFdbAddress` / `dot1qTpFdbPort` | `1.3.6.1.2.1.17.7.1.2.2.1.1` / `.2` |
| `ipNetToMediaPhysAddress` | `1.3.6.1.2.1.4.22.1.2` |
| `ipAdEntAddr` | `1.3.6.1.2.1.4.20.1.1.1` |

LLDP is read first; CDP is used where LLDP is not available. Both give the
**remote system name and the local port number**, which is what turns a
neighbour sighting into a topology edge with a confidence score.

---

## 2. SNMP versions

### SNMPv3 — preferred

Use v3 for anything that crosses a network you do not control. It is
authenticated and encrypted, so the community string problem does not exist.

The collector supports:

* **Auth protocols:** `none`, `md5`, `sha`, `sha1`, `sha224`, `sha256`,
  `sha384`, `sha512`.
* **Privacy protocols:** `none`, `des`, `aes`, `aes128`, `aes256`, `aes256b`.

The security level is always **authPriv** when a v3 credential is used. An
unknown protocol name falls back to the strongest supported one rather than
silently downgrading to "no authentication".

> **Minimum passphrase lengths matter.** Most vendors refuse an auth key
> shorter than 8 characters and a privacy key shorter than 8. AES-256 wants at
> least 32. Use a passphrase of 32+ characters for both.

### SNMPv2c — for legacy kit

Read-only community strings over plain UDP. Acceptable on a trusted, isolated
management VLAN; not acceptable anywhere else.

v1 is also selectable for very old equipment. It is not recommended: v1 has no
concept of a scoped view and transmits the community string in the clear.

### Creating a credential in the console

**Settings → SNMP credentials → Add credential**

| Field | Meaning |
| --- | --- |
| Name | A label, e.g. `core-switch-v3`. |
| Version | `3`, `2c` or `1`. |
| Username | The v3 security name. |
| Auth protocol / auth key | The v3 authentication protocol and passphrase. |
| Privacy protocol / privacy key | The v3 encryption protocol and passphrase. |
| Community | The v1/v2c community string. |

The credential is **tested before it is saved**. If the device does not
answer, the console says so and refuses to store a credential that cannot
work.

> **The secret is write-only.** Once it is saved, the browser only ever
> receives a redacted preview (`p•••••••d`) and the flags `hasCommunity` /
> `hasAuthKey` / `hasPrivKey`. The decrypted value never leaves the server,
> and it is never included in any API response.

---

## 3. Vendor quick reference

### Cisco IOS / IOS-XE

```
snmp-server community <community> RO
snmp-server group MINEAZY v3 priv
snmp-server user <user> MINEAZY v3 auth sha <authpass> priv aes 128 <privpass>
snmp-server host 192.0.2.10 version 3 priv <user>
snmp-server enable traps
```

### Cisco NX-OS

```
snmp-server user <user> auth sha <authpass> priv aes-128 <privpass>
snmp-server community <community> ro
feature snmp
```

### Arista EOS

```
snmp-server community <community> ro
snmp-server user <user> sha <authpass> aes <privpass> auth sha priv aes
! Or the simpler form:
snmp-server v3 user <user> auth sha <authpass> priv aes-128 <privpass>
```

### Juniper JunOS

```
set snmp community public authorization read-only
set snmp user <user> authentication sha authentication-key <authpass>
set snmp user <user> privacy aes-128 privacy-key <privpass>
```

### HPE Aruba (AOS-CX) and Comware

```
snmp-server community <community> ro
snmp-server user <user> auth sha <authpass> priv aes-128 <privpass>
```

### MikroTik RouterOS

```
/snmp community set 0 name=<community> addresses=192.0.2.0/24 read-access=yes
```

### Ubiquiti UniFi

UniFi's controller does not expose a full SNMP agent on the switches. The
UniFi gateway/UDM devices do. Enable it in the UniFi Network application under
**Settings → System → SNMP**. Community-based v2c is the only option.

### TP-Link Omada / Meraki / Ubiquiti EdgeOS

* **Omada** — the Omada controller can proxy SNMP; enable it under
  **Settings → SNMP** and point it at the controller.
* **Meraki** — SNMP is enabled per device under **Switching → SNMP**.
* **EdgeOS** — `set service snmp community <community> authorization ro`.

> **A device that does not answer SNMP is reported as unreachable, not as a
> healthy device with no data.** The console will show it as `OFFLINE` (if it
> also fails to ping) or `UNKNOWN` (if there is simply no evidence). It never
> fabricates a port table.

---

## 4. Access lists and firewalls

Restrict SNMP to the monitoring host. On Cisco:

```
access-list 10 permit host 192.0.2.10
access-list 10 deny any
snmp-server community <community> RO 10
```

On Linux with `ufw`:

```bash
sudo ufw allow from 192.0.2.10 to any port 161 proto udp
```

Remember that SNMP uses **UDP 161** and has no session state — a stateless
firewall rule is fine.

---

## 5. Verifying it works from the command line

Before blaming the console, check the device directly.

**SNMPv3:**

```bash
snmpwalk -v3 -u <user> -l authPriv -a SHA -A <authpass> -x AES -X <privpass> <device> 1.3.6.1.2.1.1.1.0
```

**SNMPv2c:**

```bash
snmpwalk -v2c -c <community> <device> 1.3.6.1.2.1.1.1.0
```

Useful subtrees to check:

| Check | OID |
| --- | --- |
| The device answers at all | `1.3.6.1.2.1.1.1.0` |
| The interface table exists | `1.3.6.1.2.1.2.2.1.2` |
| High-capacity counters exist | `1.3.6.1.2.1.31.1.1.1.6` |
| LLDP neighbours exist | `1.0.8802.1.1.2.1.4.1.1.9` |

If `snmpwalk` works but the console does not, the problem is usually:

1. **A different credential** — the collector uses the credential attached to
   the device, not the one you just tested.
2. **The device's `Mgmt_IP` is wrong** — the collector polls the address in
   the device record.
3. **The device is not in the collector's cycle** — see
   `Monitoring_Enabled` on the device.

---

## 6. How credentials are stored

* The community string and both v3 keys are encrypted with **AES-256-GCM**
  before they touch the disk (`src/lib/secrets.ts`).
* The key is either `MINEAZY_SECRET_KEY` from the environment, or the
  generated file at `MINEAZY_SECRET_KEY_FILE` (default `data/secret.key`).
* Every ciphertext carries its own random IV and authentication tag, so a
  tampered row fails to decrypt rather than returning garbage.
* The API returns only a redacted preview. There is no endpoint that reads a
  secret back.
* **Back up `secret.key` together with the database.** Without it the
  credentials are unrecoverable and must be re-entered.

---

## Next

* [discovery.md](discovery.md) — how devices are found and how the topology is
  built from the SNMP data above.
* [troubleshooting.md](troubleshooting.md#snmp-problems) — what to do when a
  device does not answer.
