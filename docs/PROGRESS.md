# FreeRAID — Development Progress

## What is FreeRAID?

Open source NAS OS alternative to Unraid. No accounts, no subscriptions, no login wall.

Built on Debian Linux + MergerFS + SnapRAID + Cockpit web UI.

**GitHub:** https://github.com/crucifix86/FreeRAID

---

## Current Version: v0.4.0

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

### Docker
- `freeraid docker-list` — list containers with state, ports, host IP, WebUI URL (JSON)
- `freeraid docker-start <name>` — start a container via docker compose
- `freeraid docker-stop <name>` — stop a container via docker compose
- `freeraid docker-logs <name>` — stream last 100 lines of container logs
- `freeraid docker-delete <name>` — remove a compose file
- `freeraid ports-used` — JSON list of all in-use host ports (docker + ss)
- Compose files stored at `/etc/freeraid/compose/` as `<name>.docker-compose.yml`
- Container cards show host IP, mapped port badges, running state
- Context menu (⋮): Open Web UI, Terminal (Cockpit), Edit, Logs, Delete
- WebUI URL resolved from `window.location.hostname` (always correct regardless of IP changes)
- Multi-select delete: checkboxes + "Select all" + bulk delete with confirmation

### Community App Browser
- `freeraid apps-fetch` — download Unraid Community Applications feed (~3000+ Docker apps)
- `freeraid apps-search <query>` — search with relevance scoring
- `freeraid apps-get <name>` — get full app JSON including config template
- `freeraid apps-install <name> [config-json]` — generate docker-compose from template
- `freeraid apps-categories` — list all categories
- App browser in Docker tab: search, filter by category, app icons from GitHub/Docker Hub
- Install form: auto port conflict detection, suggests next free port
- Network type selector: Bridge (NAT) / Host (share host network) / Custom (named Docker network + optional static IP)
- Install paths auto-remapped from `/mnt/user/` to `/mnt/freeraid/` on install
- docker-compose v1/v2 fallback helper (`docker compose` → `docker-compose`)

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

### Drive Recovery & Degraded Mode
- UUID-based drive tracking — drives are identified by UUID, survives `/dev/sdX` renumbering
- Degraded mode — array starts with a missing drive, files on other disks remain accessible
- `freeraid replace-disk <slot> <dev>` — format replacement, mount, run `snapraid fix`, re-sync
- `freeraid replace-disk-bg <slot> <dev>` — same but backgrounded (PID + status file)
- `freeraid replace-disk-status <slot>` — poll rebuild progress from UI
- `freeraid registry-sync` — scan mounted drives, update UUID/serial in config
- Dashboard: missing drive cards with Replace button, rebuilding progress bar
- When array is stopped: reassign drives via dropdown, unassigned drive cards visible

### SMART Data
- `freeraid smart <dev>` — full SMART data via `smartctl -j -x` (health, temp, hours, attributes)
- `freeraid smart-test <dev> <short|long|conveyance>` — trigger self-test
- SMART modal on each drive card: health status, temperature, power-on hours,
  reallocated/pending/uncorrectable sectors, full ATA attribute table, self-test history

### Web UI (Cockpit Plugin)
- **Sidebar layout** — FreeRAID owns the full UI; custom left sidebar replaces Cockpit nav
  (Cockpit chrome, sidebar, and topbar all hidden via branding.css override)
- **Dashboard** — array status + controls panel (Start/Stop, Sync Parity, Parity Check),
  live disk cards with usage bars, array capacity, used/free, last sync time, operation log,
  SMART details per drive; CPU/RAM/Network sparkline graphs
- **Disks** — all detected drives, role assignment modal (Array/Parity/Cache),
  missing/rebuilding drive states, reassign when stopped
- **Shares** — share list with badges, create form, Unraid zip uploader
- **Docker** — container cards with ports/IP, context menu, app browser, install form,
  network type selector (Bridge/Host/Custom macvlan + static IP), Docker Networks panel,
  per-container xterm.js terminals (open in new tab)
- **Network** — hostname editor, per-interface DHCP/static IP config
- **Share Users** — Samba user management (add, delete, set password)
- **Settings** — version info, check for updates, Update Now with live log
- **Plugins** — placeholder (coming soon)
- **Sidebar footer** — Log Out, Reboot, Shutdown
- **WebUI Accounts** — links to Cockpit's own user management (Settings section)

### Login Page
- Custom FreeRAID-themed login (dark, centered card, purple accent — matches the UI)
- "Remember login" checkbox — saves credentials to localStorage, auto-fills on next visit

### Update System
- `freeraid update` — fetch latest release tarball from GitHub, apply in place
- `freeraid check-update` — JSON output for web UI polling
- `scripts/release.sh <version> <notes>` — one command cuts a GitHub release
- Component tarball only (~35KB) — no full OS image downloads
- Web UI shows update notification banner, Settings tab has one-click update
- Fixed: page no longer re-checks GitHub immediately after a successful update
  (used sessionStorage flag to skip post-update reload check)

### Live USB — Boots Like Unraid
- `scripts/build-image.sh` — builds the full live OS image (one-time, ~20-30 min)
  - debootstrap Debian 12 minimal rootfs
  - Installs all FreeRAID dependencies: mergerfs, snapraid, docker, cockpit, samba, jq
  - NIC firmware: Realtek, Intel, Broadcom, iwlwifi
  - Configures freeraid/freeraid user, DHCP networking, all systemd services
  - Builds custom busybox-based initrd: finds USB by FREERAID label, mounts squashfs,
    sets up overlay filesystem (read-only OS + tmpfs writes), bind-mounts USB
    `config/` at `/boot/config` (persistent across reboots)
  - Packs rootfs as xz squashfs (~407MB)
  - Output: `build/vmlinuz`, `build/initrd.gz`, `build/rootfs.squashfs`
- `scripts/create-usb.sh /dev/sdX [unraid-backup.zip]` — writes live image to USB
  - FAT32 MBR partition, labeled `FREERAID` (identical structure to Unraid USB)
  - Syslinux BIOS bootloader (MBR) + syslinux EFI64 (`EFI/boot/bootx64.efi`)
  - `syslinux.cfg` matches Unraid style with FreeRAID branding
  - Copies vmlinuz, initrd.gz, rootfs.squashfs
  - Creates `config/` directory — this is the persistent layer (mounted at `/boot/config`)
  - Copies Unraid backup zip to `config/unraid-backup.zip` if provided
  - Copies default `freeraid.conf.json` to `config/`

**Boot flow (no screen needed, headless):**
1. Server boots USB (BIOS or UEFI)
2. Syslinux loads kernel + initrd
3. initrd finds `FREERAID` USB, mounts squashfs + overlay, bind-mounts `config/`
4. System hands off to systemd — Cockpit, Docker, SSH, FreeRAID all start
5. DHCP gets an IP — navigate to `https://<ip>:9090` in a browser
6. Login: `freeraid` / `freeraid`
7. Assign drives in Disks tab → Start Array → shares and containers are live

**What persists (on USB `config/`):**
- `freeraid.conf.json` — array config, disk assignments, shares
- `unraid-backup.zip` — optional Unraid import source

**What does NOT persist (in RAM overlay, lost on reboot):**
- Changes outside of `/boot/config`
- Docker container state (container data should live on array drives)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Cockpit Web UI (port 9090)                     │
│  Dashboard | Disks | Docker | Shares | Settings | Plugins  │
└────────────────────┬────────────────────────────────────────┘
                     │ cockpit.spawn()
┌────────────────────▼────────────────────────────────────────┐
│            /usr/local/bin/freeraid (bash CLI)               │
│  status│start│stop│sync│scrub│disks-*│shares-*│docker-*│update│
└──────┬──────────────┬──────────────┬──────────────────────┘
       │              │              │
  MergerFS        SnapRAID       Samba/NFS
  (pool)          (parity)       (shares)
       │
  /mnt/disk1, /mnt/disk2... → /mnt/user (pool)
  /mnt/parity, /mnt/cache

USB (FREERAID label, FAT32)
  ├── vmlinuz / initrd.gz / rootfs.squashfs  ← live OS (read-only)
  └── config/                                ← persistent config (rw)
       └── freeraid.conf.json
```

**Config file:** `/boot/config/freeraid.conf.json` — single JSON file, human readable
(on live USB this is the `config/` directory on the USB drive itself)

---

## File Layout

```
FreeRAID/
├── VERSION                     ← single source of truth for version
├── core/
│   ├── freeraid                ← main CLI (bash)
│   └── freeraid.conf.json      ← config schema / default config
├── importer/
│   └── unraid-import.py        ← Unraid config → FreeRAID converter
├── compose/                    ← user-installed app compose files (gitignored)
├── scripts/
│   ├── build-image.sh          ← builds live OS squashfs + initrd
│   ├── create-usb.sh           ← writes live image to USB drive
│   ├── install.sh              ← traditional Debian installer (alternative)
│   └── release.sh              ← cut a GitHub release with component tarball
├── web/
│   ├── branding.css            ← hides Cockpit chrome (deployed to cockpit branding dir)
│   ├── login.html              ← FreeRAID-themed login page with remember-login
│   └── freeraid/
│       ├── manifest.json       ← Cockpit plugin registration
│       ├── index.html          ← sidebar SPA
│       ├── freeraid.css        ← dark theme UI
│       ├── freeraid.js         ← cockpit.spawn() API calls, UI logic
│       ├── terminal.html       ← standalone xterm.js terminal (per-container)
│       ├── xterm.js / xterm.css / xterm-addon-fit.js  ← bundled xterm 5.3.0
├── vm/
│   ├── create-vm.sh            ← QEMU VM with 7 virtual disks
│   ├── start-vm.sh             ← start VM (TAP networking, fallback to NAT)
│   ├── setup-vm-network.sh     ← TAP + proxy ARP: gives VM its own LAN IP
│   ├── teardown-vm-network.sh  ← remove TAP interface
│   └── vm-netplan.yaml         ← static IP config for inside the VM
├── build/                      ← gitignored, output of build-image.sh
│   ├── vmlinuz
│   ├── initrd.gz
│   └── rootfs.squashfs
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

Access (with TAP networking active):
```bash
ssh root@192.168.1.150
# Web UI:
https://192.168.1.150:9090  (login: freeraid / freeraid)
```
Run `sudo vm/setup-vm-network.sh` once before starting the VM to set up TAP + proxy ARP.

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
| v0.2.0 | Docker tab — list/start/stop/logs for compose-managed containers |
| v0.2.1 | Multi-select delete for Docker containers |
| v0.2.2 | Fix update flow — no stale "update available" after applying |
| v0.3.0 | App browser (3000+ apps), Docker context menu, SMART data, drive recovery, degraded mode, VM gets own LAN IP |
| v0.3.1 | Network tab, Share Users tab, per-container xterm.js terminals, Docker network type selector + macvlan panel |
| v0.4.0 | Custom sidebar replaces Cockpit nav, FreeRAID login theme + remember login, array controls on dashboard, logout button |

---

## What's Next (Planned)

- [x] Docker tab — list containers, start/stop/logs per app
- [x] Multi-select delete for Docker containers
- [x] Live USB — boots FreeRAID directly, no installer, headless-safe
- [x] Community App Browser — install from 3000+ Unraid CA templates
- [x] Docker context menu — WebUI, Terminal, Edit, Logs, Delete
- [x] Drive SMART data in UI — health, temp, attributes, self-test
- [x] Drive recovery / degraded mode — replace failed drive, rebuild from parity
- [x] User management — add Samba users, set passwords from UI
- [x] Network settings tab (static IP, hostname from web UI)
- [x] Custom sidebar — FreeRAID owns the full UI, Cockpit chrome hidden
- [x] Per-container xterm.js terminals (open in new tab)
- [x] Docker network type selector (Bridge / Host / Custom macvlan + static IP)
- [x] Docker Networks panel — create/delete macvlan networks
- [x] Custom login page — FreeRAID theme + remember login
- [ ] First-boot Unraid import on live USB (auto-import from config/unraid-backup.zip)
- [ ] First-boot wizard (hostname, network, disk assignment flow)
- [ ] NFS export configuration in UI
- [ ] Plugin system — real implementation

---

## Feature Parity with Unraid (Roadmap)

Features Unraid has that FreeRAID doesn't yet. Grouped by area.

### Dashboard / Monitoring
- [x] Disk temperatures (from SMART data)
- [x] Full SMART data per disk — health, ATA attributes, self-test history
- [x] CPU / RAM / network usage graphs (sparklines, live polling)
- [ ] Per-disk I/O stats
- [ ] System log viewer in UI
- [ ] Notifications — email/Telegram alerts for array events, drive warnings

### Storage
- [x] Degraded mode — array stays up with a missing drive
- [x] Drive replacement + parity rebuild from UI
- [ ] Multiple storage pools
- [ ] Per-share encryption
- [ ] Turbo write mode (bypass parity during writes for speed)
- [ ] File mover / balancer utility (redistribute files across array disks)
- [ ] ZFS pool support

### Drives
- [x] Full SMART data per disk in UI
- [x] UUID-based drive tracking (survives device renumbering)
- [ ] Drive pre-clear utility
- [ ] Disk spin-down / power management settings

### Docker
- [x] App browser — 3000+ apps from Unraid Community Applications feed
- [x] Install form with port conflict detection + auto-assignment
- [x] Network type selector (Bridge / Host / Custom with static IP)
- [x] Context menu — WebUI, Terminal, Edit, Logs, Delete
- [x] Per-container xterm.js terminals in new browser tab
- [x] Network type selector (Bridge / Host / Custom macvlan + static IP)
- [x] Docker Networks panel — create/delete macvlan networks
- [ ] Auto-update containers

### VMs
- [ ] VM manager (KVM/QEMU) — create, start, stop, delete VMs from UI

### Users & Shares
- [x] User management — add/delete Samba users, set passwords from UI
- [ ] Per-share user permissions
- [ ] Share-level passwords
- [ ] Advanced NFS export options in UI

### Network & System
- [x] Network settings tab (static IP / DHCP, hostname from UI)
- [x] Custom login page (FreeRAID themed + remember login)
- [ ] UPS support (NUT integration)
- [x] Web terminal — per-container xterm.js terminals in new tab
- [ ] Tailscale / VPN built-in

### Plugins
- [ ] Real plugin system (install/remove/update plugins)
- [ ] Plugin marketplace / community plugins
