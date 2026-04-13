# Settings Catalog — Unraid vs FreeRAID

Snapshot of the per-category settings surface. `✅` = implemented in FreeRAID,
`⚠️` = partial, `❌` = not yet, `N/A` = intentionally not ported.

---

## System / Identity

| Setting                 | Unraid | FreeRAID | Notes |
|---|---|---|---|
| Hostname                | ✅ | ✅ | `system.hostname` |
| Timezone                | ✅ | ⚠️ | stored but no UI picker |
| Language / locale       | ✅ | ⚠️ | stored, not enforced |
| Root password change    | ✅ | ✅ | via user management |
| License key / trial     | ✅ | N/A | we're free |
| SSL cert (LetsEncrypt)  | ✅ | ❌ | self-signed Cockpit default |
| Web UI port             | ✅ | ❌ | hardcoded :9090 |
| Auto-shutdown on temp   | ⚠️ | ❌ | Unraid has protection mode |

## Network

| Setting                  | Unraid | FreeRAID |
|---|---|---|
| Static IP / DHCP          | ✅ | ✅ |
| Gateway / DNS             | ✅ | ✅ |
| Interface bonding         | ✅ | ❌ |
| VLANs                     | ✅ | ❌ |
| Bridge (br0) config       | ✅ | ❌ (VMs need this) |
| IPv6                      | ✅ | ⚠️ kernel supports, no UI |
| WireGuard (server)        | ✅ | ❌ planned as plugin |
| Tailscale                 | ❌ | ✅ |
| mDNS / SMB discovery      | ✅ | ✅ (avahi + wsdd) |

## Storage — Array

| Setting                       | Unraid | FreeRAID |
|---|---|---|
| Parity disk(s)                | ✅ realtime (2 max) | ✅ snapraid (6 max, batch) |
| Data disk slots               | ✅ 30 | ✅ unlimited |
| Per-disk spindown timeout     | ✅ | ✅ |
| Per-disk warn / critical temp | ✅ | ✅ (global threshold only) |
| Per-disk compression          | ✅ btrfs | ❌ |
| Default fs type for new disks | ✅ xfs/btrfs/zfs | ⚠️ xfs hardcoded on format |
| Turbo write (bypass parity)   | ✅ | ✅ |
| Disable disk auto-format      | ✅ | ❌ (always formats on fs mismatch) |
| md driver tunables            | ✅ | N/A (no md) |
| Cache pool (separate)         | ✅ | ✅ |
| Multiple extra pools          | ❌ | ✅ |
| Pool filesystem (zfs/btrfs)   | ✅ | ⚠️ btrfs only, zfs planned |

## Storage — Shares

| Setting                   | Unraid | FreeRAID |
|---|---|---|
| Per-share name / path     | ✅ | ✅ |
| SMB public/secure/private | ✅ | ✅ |
| Per-user read / write     | ✅ | ✅ |
| Share-level password      | ❌ | ✅ (we do this, Unraid doesn't) |
| NFS export                | ✅ | ✅ |
| AFP export                | ⚠️ deprecated | ❌ |
| Cache mode (yes/no/prefer/only) | ✅ | ⚠️ stored, enforcement partial |
| Include/exclude disks     | ✅ | ❌ |
| Allocation method         | ✅ (HW/MFS/fill) | ⚠️ mergerfs opt only |
| Split level               | ✅ | ❌ |
| COW on/off                | ✅ | ❌ |
| Export to FTP             | ✅ | ❌ |
| Per-share encryption      | ❌ | ⚠️ gocryptfs support, no UI polish |

## Docker

| Setting                     | Unraid | FreeRAID |
|---|---|---|
| Enable/disable docker       | ✅ | ✅ |
| docker.img loop file        | ✅ 200G default | ❌ overlay2 on disk1 |
| App-specific data root      | ⚠️ fixed to appdata | ✅ configurable |
| Community app browser       | ✅ | ✅ (uses Unraid CA feed) |
| Per-container templates     | ✅ XML | ✅ compose |
| Bridge / Host / Macvlan     | ✅ | ✅ |
| Custom networks             | ✅ | ✅ |
| VPN-routed containers (gluetun) | ⚠️ manual | ❌ planned |
| Auto-update containers      | ✅ | ✅ |
| Auto-start container order  | ✅ | ❌ (we have compose, no ordering UI) |

## VMs

| Setting                   | Unraid | FreeRAID |
|---|---|---|
| Enable VMs                | ✅ | ⚠️ libvirt installed, no UI |
| Per-VM create/edit        | ✅ | ❌ |
| VFIO GPU passthrough      | ✅ | ❌ |
| PCI device passthrough    | ✅ | ❌ |
| Virtual disks (vdisk)     | ✅ | ❌ |
| USB device assignment     | ✅ | ❌ |
| Machine type / chipset    | ✅ | ❌ |

## Users

| Setting                    | Unraid | FreeRAID |
|---|---|---|
| Add/delete Samba user      | ✅ | ✅ |
| Set password               | ✅ | ✅ |
| SSH access per user        | ⚠️ root only | ⚠️ root only |
| Per-user home share        | ❌ | ❌ |
| 2FA                        | ✅ | ❌ |

## Notifications

| Setting                  | Unraid | FreeRAID |
|---|---|---|
| Email (SMTP)             | ✅ | ✅ (msmtp) |
| Webhook (Discord/Slack)  | ⚠️ via plugin | ✅ built-in |
| Push (Pushover/Gotify)   | ✅ | ❌ |
| Per-event toggles        | ✅ | ✅ |
| Temperature thresholds   | ✅ | ✅ |
| Array degraded alert     | ✅ | ✅ |
| Sync/scrub error alert   | ✅ | ✅ |
| Update available         | ✅ | ✅ |

## Scheduling

| Setting              | Unraid | FreeRAID |
|---|---|---|
| Parity check schedule | ✅ | ✅ |
| SMART test schedule  | ✅ | ❌ |
| Cache mover schedule | ✅ | ✅ |
| Docker update schedule | ✅ | ✅ |

## Power / Monitoring

| Setting                  | Unraid | FreeRAID |
|---|---|---|
| UPS (NUT)                | ✅ | ❌ planned |
| Power button action      | ✅ | ❌ defaults only |
| CPU pinning for VMs      | ✅ | ❌ |
| CPU temperature sensors  | ✅ | ✅ (Cockpit) |
| Fan control              | ❌ plugin | ❌ |

## System / Boot

| Setting                     | Unraid | FreeRAID |
|---|---|---|
| USB backup download         | ✅ | ⚠️ config persists to USB, no "download backup" button |
| Auto-backup USB to flash    | ✅ plugin | ❌ |
| Boot options (safe mode, memtest) | ✅ | ⚠️ GRUB menu has verbose mode only |
| Persistence toggle          | ✅ | ❌ always persists |
| Syslog to flash / remote    | ✅ | ❌ |

---

## Stored-but-unsurfaced (quick wins)

These already live in `freeraid.conf.json` — need UI plumbing, not new backend:

1. **Timezone picker** — `system.timezone` exists; add dropdown → `timedatectl set-timezone`.
2. **Cache mode enforcement per share** — `shares[].cache_mode` stored but mergerfs-share-routing is ad-hoc (we fixed it in the importer this session). Needs a native "create share" UI that writes the right bind-mounts.
3. **Include/exclude disks on shares** — field is in the schema, never enforced.
4. **Allocation method (split level, COW)** — stored, ignored.

## Architecturally missing (real engineering)

Ranked by what an Unraid migrator would notice first:

1. **VM manager UI** — libvirt is installed, need create/edit/start/stop/console. Big one.
2. **Unraid-compatible realtime parity** — discussed earlier; weeks of kernel work, but the killer migration story.
3. **VPS bypass plugin** — we have the reference doc, need to actually build it.
4. **Web UI port / cert** — Cockpit's :9090 + self-signed blocks putting FreeRAID directly on the LAN without a reverse proxy.
5. **Real plugin system** — everything else above this line should be plugins once that exists.
6. **UPS / NUT** — straightforward, just not built.

## Not planning to port

- License key infrastructure (we're free)
- AFP (dead protocol)
- Unraid's specific .img-on-XFS docker model — we use overlay2 directly
- Unraid md driver tunables (different parity model)
