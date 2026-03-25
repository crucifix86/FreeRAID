# FreeRAID — Development Progress

## What is FreeRAID?

Open source NAS OS alternative to Unraid. No accounts, no subscriptions, no login wall.

Built on Debian Linux + MergerFS + SnapRAID + Cockpit web UI.

**GitHub:** https://github.com/crucifix86/FreeRAID

---

## Current Version: v0.2.0

---

## What Works Right Now

### Array Management
- `freeraid start` — formats new drives (XFS/ext4/btrfs), mounts all drives, starts MergerFS pool
- `freeraid stop` — clean unmount of pool, data disks, cache, parity
- `freeraid status` — per-disk usage, pool size, array state (human + JSON)
- `freeraid sync` — SnapRAID parity sync
- `freeraid scrub` — verify parity integrity
- `freeraid diff` — show what changed since last sync
- Array auto-starts on boot via systemd, nightly sync and weekly scrub timers

### Disk Management
- `freeraid disks-scan` — detect all block devices, show size/model/type/assignment
- `freeraid disks-assign <dev> <array|parity|cache>` — assign a drive, auto-picks next slot
- `freeraid disks-unassign <dev>` — remove from config (data untouched)
- Disks tab in web UI — color-coded role cards, Assign modal, Unassign button
- Guards: can't reassign while array is running

### Shares
- `freeraid shares-list` — JSON list of all shares
- `freeraid shares-add <name>` — add a share
- `freeraid shares-remove <name>` — remove a share
- `freeraid shares-apply` — write smb.conf and reload Samba
- `freeraid shares-import <dir>` — import from Unraid config directory
- Shares tab: create form (name, comment, SMB security, cache mode, SMB/NFS toggles)
- Unraid zip uploader: drag & drop backup zip, preview contents, import

### Unraid Migration
- **Shares** ✅ — all 16 shares imported from real backup, correct field mapping
  (shareExport, shareSecurity, shareUseCache, shareExportNFS, etc.)
- **Docker apps** ✅ — 65 apps converted to docker-compose files
- **Hostname + network** ✅ — DHCP/static settings imported
- **Disk assignments** ⚠️ — Unraid stores disks by serial number, not device path.
  Cannot auto-map on migration. Users assign drives manually via Disks tab.
  This is intentional — drives get re-identified on the new system.

### Web UI (Cockpit Plugin)
- **Dashboard** — array start/stop, parity sync, live disk cards with usage bars,
  array capacity, used/free, last sync time, operation log
- **Disks** — all detected drives, role assignment modal (Array/Parity/Cache)
- **Shares** — share list with badges, create form, Unraid zip uploader
- **Settings** — version info, check for updates, Update Now with live log
- **Plugins** — placeholder (coming soon)

### Update System
- `freeraid update` — fetch latest release tarball from GitHub, apply in place
- `freeraid check-update` — JSON output for web UI polling
- `scripts/release.sh <version> <notes>` — one command cuts a GitHub release
- Component tarball only (~25KB) — no full OS image downloads
- Web UI shows update notification banner, Settings tab has one-click update

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│            Cockpit Web UI (port 9090)               │
│   Dashboard | Disks | Shares | Settings | Plugins   │
└────────────────────┬────────────────────────────────┘
                     │ cockpit.spawn()
┌────────────────────▼────────────────────────────────┐
│           /usr/local/bin/freeraid (bash CLI)        │
│  status│start│stop│sync│scrub│disks-*│shares-*│update│
└──────┬──────────────┬──────────────┬────────────────┘
       │              │              │
  MergerFS        SnapRAID       Samba/NFS
  (pool)          (parity)       (shares)
       │
  /mnt/disk1, /mnt/disk2... → /mnt/user (pool)
  /mnt/parity, /mnt/cache
```

**Config file:** `/boot/config/freeraid.conf.json` — single JSON file, human readable

---

## File Layout

```
FreeRAID/
├── VERSION                     ← single source of truth for version
├── core/
│   └── freeraid                ← main CLI (bash)
├── core/
│   └── freeraid.conf.json      ← config schema / default config
├── importer/
│   └── unraid-import.py        ← Unraid config → FreeRAID converter
├── scripts/
│   ├── install.sh              ← Debian installer
│   └── release.sh              ← cut a GitHub release with component tarball
├── web/freeraid/
│   ├── manifest.json           ← Cockpit plugin registration
│   ├── index.html              ← tab-based SPA
│   ├── freeraid.css            ← dark theme UI
│   └── freeraid.js             ← cockpit.spawn() API calls, UI logic
├── vm/
│   ├── create-vm.sh            ← QEMU VM with 7 virtual disks
│   └── start-vm.sh             ← start VM after install
└── docs/
    ├── ARCHITECTURE.md
    └── PROGRESS.md             ← this file
```

---

## VM Test Environment

QEMU VM on the dev machine with:
- `vda` 20G — OS (Debian 12)
- `vdb/vdc` 8G — array disk1/disk2 (XFS, in pool)
- `vdd/vde` 8G — disk3/disk4 (assigned, not yet enabled)
- `vdf` 8G — parity
- `vdg` 4G — cache

Access:
```bash
ssh root@localhost -p 2222
# Web UI:
https://localhost:9090  (login: doug / freeraid)
```

---

## Release History

| Version | What changed |
|---------|-------------|
| v0.1.0 | Initial: CLI, MergerFS+SnapRAID, Cockpit plugin, VM scripts |
| v0.1.1 | Show total array capacity in storage summary |
| v0.1.2 | Fix version tracking (VERSION file as source of truth) |
| v0.1.3 | Settings tab with web-based update manager |
| v0.1.4 | Fix cockpit.js not loading (buttons non-functional) |
| v0.1.5 | Plugins tab placeholder |
| v0.1.6 | Shares tab with Unraid config import |
| v0.1.7 | Full share create form + Unraid zip uploader with preview |
| v0.1.8 | Disks tab: scan, assign to array/parity/cache, unassign |
| v0.1.9 | Fix disks-scan failing on virtio/no-model drives |
| v0.2.0 | Docker tab — list containers, start/stop/logs per app |

---

## What's Next (Planned)

- [x] Docker tab — list containers, start/stop/logs per app
- [ ] Drive health — SMART data per disk in UI
- [ ] Disk assignment persists across reboots (fstab generation)
- [ ] User management — add Samba users, set passwords from UI
- [ ] NFS export configuration in UI
- [ ] Plugin system — real implementation
- [ ] Bootable ISO / live USB builder
- [ ] First-boot wizard (hostname, network, disk assignment flow)
