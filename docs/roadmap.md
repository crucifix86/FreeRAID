# FreeRAID Roadmap — Feature Gap vs Unraid

A ground-up audit of what Unraid ships that FreeRAID doesn't yet. Written after the first-half-day of real-hardware testing on POUGHKEEPSIE (Apr 2026). Meant to drive the roadmap, not to be exhaustive to the line-item level — the settings-level breakdown is in [settings-catalog.md](settings-catalog.md).

Status key:
- ✅ Done
- 🟡 Partial
- ❌ Missing
- 💭 Intentionally different (we do it our way)

Effort key: **S** (hours) · **M** (a day) · **L** (a week) · **XL** (multi-week engineering)

---

## 1. Storage & Array

| Feature | Status | Effort | Notes |
|---|---|---|---|
| SnapRAID (batch parity) | ✅ | — | Our default; up to 6 parity disks |
| **Realtime parity (Unraid-compat md driver)** | ❌ | **XL** | Killer migration feature. Requires porting Unraid's md patches or writing a dm-unraid target. Separate design doc. |
| Cache-pool (single) | ✅ | — | |
| Multiple named pools | ✅ | — | We beat Unraid here |
| Cache modes per share (yes/no/prefer/only) | 🟡 | M | Stored in schema but enforcement is ad-hoc; needs proper "cache-only = bind-mount to /mnt/cache" plumbing for the non-appdata case |
| Share include/exclude disks | ❌ | M | Field exists in schema, no UI or enforcement |
| Allocation method (fill/MFS/HWM) | 🟡 | S | We expose mergerfs category.create; Unraid's UI is friendlier |
| Split level (directory granularity) | ❌ | M | mergerfs has equivalents but no UI to set per-share |
| Default fs type for new disks | 🟡 | S | Hardcoded XFS for data, btrfs for cache; add a picker |
| File-level scrub + bit-rot detection | ✅ | — | snapraid scrub; we schedule it |
| Turbo write (bypass parity during bulk writes) | ✅ | — | |
| Disk pre-clear | ✅ | — | |
| 4Kn native drive support | ✅ | — | Auto loop-wrap with 512-byte sectors (commit dceea33) |
| TRIM schedule for SSDs | ❌ | S | Systemd timer, easy |
| ZFS pool creation via UI | 🟡 | M | zfsutils installed, no create/destroy UI |
| Btrfs pool balancing | ❌ | S | CLI exists, no UI trigger |

## 2. Docker

| Feature | Status | Effort | Notes |
|---|---|---|---|
| Docker daemon + Compose | ✅ | — | |
| Unraid docker.img auto-detect + mount | ✅ | — | Just landed (commit 740ab1f) |
| Import Unraid containers via flash backup | ✅ | — | 66 templates → compose files |
| Filter stale templates | ❌ | M | Task #6 — use template mtime or Unraid's live docker state signal |
| Community Apps browser | ✅ | — | Uses Unraid CA feed |
| Per-container start/stop/logs/update | ✅ | — | |
| Autostart on boot | ❌ | M | Inherit from Unraid's autostart config on import; expose per-container toggle |
| Autostart order + delays | ❌ | M | Unraid has a slider per container |
| GPU passthrough (NVIDIA) | ✅ | — | One-click install in Settings → Hardware (commit 10cfbd7/baf7ec6) |
| GPU passthrough (AMD, Intel) | ❌ | L | Each has its own driver story (ROCm, iHD) |
| macvlan/ipvlan networks per container | ✅ | — | |
| Custom bridge networks | ✅ | — | |
| VPN-routed containers (gluetun style) | 🟡 | M | Works if user configures manually; no built-in helper |
| Container templates editor in UI | 🟡 | M | We can view compose, no in-browser YAML editor yet |
| Docker image prune UI | ❌ | S | `docker image prune` with a button |
| Per-container CPU/RAM limits UI | ❌ | S | Compose supports it, UI doesn't expose |

## 3. Virtual Machines

| Feature | Status | Effort | Notes |
|---|---|---|---|
| libvirt installed | ✅ | — | |
| **Any VM UI at all** | ❌ | **L** | Biggest gap vs Unraid. Create/edit/start/stop/console. |
| VFIO GPU passthrough | ❌ | L | PCIe bind/unbind, IOMMU groups UI |
| USB passthrough | ❌ | M | |
| SPICE / VNC console in browser | ❌ | M | noVNC + cockpit integration |
| Machine type / chipset / BIOS picker | ❌ | M | i440fx/q35/OVMF |
| vdisk creation + size-on-demand | ❌ | M | qcow2 sparse management |
| CPU pinning / isolation | ❌ | M | |
| Templates (Windows/Linux/macOS) | ❌ | L | Including macinabox-style helpers |

## 4. Network

| Feature | Status | Effort | Notes |
|---|---|---|---|
| DHCP / static IP | 🟡 | M | Works via `freeraid network-set` only when NetworkManager isn't fighting (currently it is). **Needs a unified network stack choice — NM or ifupdown, not both.** Task #7 relates. |
| **Auto-apply imported Unraid static IP on first boot** | ❌ | M | Task #7 |
| Hostname setting | ✅ | — | |
| IPv6 config | 🟡 | M | Kernel supports, no UI |
| Interface bonding | ❌ | M | mode=balance-tlb / 802.3ad |
| VLANs | ❌ | M | `ip link add link eth0 name eth0.100 type vlan id 100` + UI |
| Bridge (br0) for VMs | ❌ | M | Required before VMs become useful |
| WireGuard server | ❌ | M | Planned as plugin |
| WireGuard client | 🟡 | S | CLI works, no UI |
| Tailscale | ✅ | — | We beat Unraid here |
| mDNS / wsdd discovery | ✅ | — | |
| **VPS-bypass plugin (CGNAT)** | ❌ | **M** | Spec complete in `docs/vps-cgnat-bypass-reference.md`. Just needs to be built. |

## 5. Shares & File Sharing

| Feature | Status | Effort | Notes |
|---|---|---|---|
| SMB public/secure/private | ✅ | — | |
| SMB per-user ACLs | ✅ | — | |
| **Share-level passwords** | ✅ | — | We beat Unraid (they don't have this) |
| NFS exports | ✅ | — | |
| NFS squash options UI | 🟡 | S | Backend supports, expose in UI |
| AFP | 💭 | — | Deprecated, not porting |
| FTP export | ❌ | S | vsftpd + share integration |
| WebDAV per-share | ❌ | M | |
| Per-share encryption | 🟡 | M | gocryptfs installed, no UI polish |

## 6. Users & Auth

| Feature | Status | Effort | Notes |
|---|---|---|---|
| Add/delete Samba users | ✅ | — | |
| Root password change | ✅ | — | |
| SSH access for non-root users | ❌ | S | Enable per-user + shell selection |
| 2FA | ❌ | M | TOTP via Cockpit or our own |
| API tokens | ❌ | M | For scripting / homelab automation |
| Session history / active sessions UI | ❌ | S | `who` / `last` behind a tab |

## 7. Web UI / Access

| Feature | Status | Effort | Notes |
|---|---|---|---|
| Cockpit plugin UI | ✅ | — | |
| **Web UI port configurable** | ❌ | S | Currently hardcoded 9090 |
| **Real SSL cert (LE / custom)** | ❌ | M | Cockpit default is self-signed |
| Custom theme | ✅ | — | Dark + purple |
| Remote access (my.freeraid.com style) | ❌ | L | Unraid's my.unraid.net equivalent |
| Responsive mobile UI | 🟡 | S | Works on phones but not optimized |
| Search across all tabs | ❌ | S | |

## 8. Notifications

| Feature | Status | Effort | Notes |
|---|---|---|---|
| Email (SMTP) | ✅ | — | |
| Webhook (Discord/Slack/generic) | ✅ | — | We beat Unraid (they need plugin) |
| **Pushover** | ❌ | S | |
| **Gotify** | ❌ | S | |
| ntfy.sh | ❌ | S | |
| Per-event toggles | ✅ | — | |
| Temperature alerts | ✅ | — | |
| Array degraded alert | ✅ | — | |
| Parity error alert | ✅ | — | |

## 9. Hardware / Monitoring

| Feature | Status | Effort | Notes |
|---|---|---|---|
| NVIDIA driver install | ✅ | — | Settings → Hardware (commit baf7ec6) |
| AMD / Intel GPU support | ❌ | L | Separate install paths |
| Fan control | ❌ | L | Unraid has nothing here either (plugin) — opportunity |
| CPU temperature | ✅ | — | Via Cockpit sensors |
| Drive temperature | ✅ | — | smartctl |
| SMART test scheduling | ❌ | S | We show data, don't schedule tests |
| IPMI integration | ❌ | M | For servers with BMCs |
| UPS (NUT) | 🟡 | S | Backend in place, needs UI polish |
| Power button action UI | ❌ | S | |
| Auto-shutdown on overheat | ❌ | S | |
| Hardware-accelerated video transcode detection | 🟡 | S | Partial via nvidia-smi; add Intel QSV / AMD VAAPI |

## 10. Plugins & Extensibility

| Feature | Status | Effort | Notes |
|---|---|---|---|
| Plugin stub system | 🟡 | — | Minimal scaffold at `plugins/` |
| **Real plugin manager UI** | ❌ | **L** | Install/update/remove, dependency handling, signing |
| Plugin marketplace / index | ❌ | M | Curated list, auto-refresh |
| Sandbox / permissions model for plugins | ❌ | L | Trust boundary |
| Hook system (pre-sync, post-start, etc.) | ❌ | M | |

## 11. Backup & Migration

| Feature | Status | Effort | Notes |
|---|---|---|---|
| Unraid config import | ✅ | — | Shares + docker + disks |
| Import filter stale templates | ❌ | M | Task #6 |
| Apply imported static IP | ❌ | M | Task #7 |
| USB flash backup (download config zip) | 🟡 | S | Config persists to USB, no "download backup" button |
| Auto flash-backup to cloud / local | ❌ | M | `restic`/`rsync` on a schedule |
| Restore-from-backup wizard | ❌ | M | |
| rsync to external destinations | ❌ | S | |

## 12. Updates & Release Management

| Feature | Status | Effort | Notes |
|---|---|---|---|
| In-place component update (CLI + web) | ✅ | — | |
| Atomic update (no torn-write) | ✅ | — | commit 6049743 |
| Check for updates in UI | ✅ | — | |
| Rollback / downgrade | ❌ | M | Keep N-1 release on disk |
| Release notes in UI | 🟡 | S | Shown as text; could link PROGRESS.md nicer |
| Kernel / base-image update | ❌ | L | Requires image rebuild + user re-flashes USB. Workflow design. |

## 13. Dashboard / UX polish

| Feature | Status | Effort | Notes |
|---|---|---|---|
| Array status card | ✅ | — | |
| Sparklines (CPU / RAM / net) | ✅ | — | |
| Per-drive activity lights | 🟡 | S | Basic; could be more live |
| Temperature heatmap | ❌ | S | Over all disks |
| "What changed since last sync" diff | ❌ | S | snapraid diff summary |
| Notifications bell with history | ❌ | S | |
| Onboarding wizard | 🟡 | M | Install wizard exists; could walk through first Docker install, first share, etc. |

## 14. Boot & Persistence

| Feature | Status | Effort | Notes |
|---|---|---|---|
| USB live boot (squashfs + overlay) | ✅ | — | |
| Config persists to USB | ✅ | — | `/boot/config` |
| Kernel-panic logs to USB | ❌ | M | For post-mortem debugging |
| Remote boot-log capture (serial / netconsole) | ❌ | M | |
| Memtest option in GRUB | ❌ | S | |
| Safe-mode (no plugins, no containers) | ❌ | S | |

## 15. Not porting

- Unraid's license key / trial infrastructure — we're free
- AFP protocol — deprecated
- Unraid's docker.img-in-XFS model — we use overlay2 directly (or btrfs on docker.img when inheriting)
- Unraid's md-driver tunables — different parity model entirely

---

## Prioritization (first cut)

**Next up (fits in a day each, unblocks real usage):**
1. Pushover + Gotify notification channels
2. Timezone picker → verify already done, extend to language
3. SMB squash options in UI
4. Docker image prune button
5. UPS UI polish
6. SMART test scheduler

**Next quarter of work (medium-effort, high-value):**
1. Importer: apply static IP + filter stale templates (Tasks #6, #7)
2. VPS CGNAT bypass plugin (spec ready)
3. Real plugin manager UI
4. VM manager UI v1
5. Network stack consolidation (pick NM xor ifupdown, not both)
6. Share cache modes + include/exclude disks

**Big bets:**
1. **Unraid-compatible realtime parity** — XL, but the migration story
2. **my.freeraid.com** remote access — L, but gets us the Unraid-grade convenience
3. Plugin ecosystem + signing — L, but unlocks community growth

---

## Where we already beat Unraid

- Share-level passwords (unique to us)
- Multiple named extra pools
- Up to 6 parity disks (vs 2)
- Webhook notifications built-in (vs plugin)
- Tailscale support
- Disk pre-clear built-in
- File balancer built-in
- Atomic in-place updates
- Free for personal use, no license, no nag

This is real. The gap isn't as scary as it looks line-by-line.
