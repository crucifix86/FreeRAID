# FreeRAID — Master Reference

**Version**: 0.5.3
**GitHub**: https://github.com/crucifix86/FreeRAID
**License**: Free for personal/non-commercial use

---

## Table of Contents

1. [What It Is](#what-it-is)
2. [Directory Structure](#directory-structure)
3. [Config File](#config-file)
4. [CLI Commands](#cli-commands)
5. [Web UI](#web-ui)
6. [Update Process](#update-process)
7. [USB Creation Process](#usb-creation-process)
8. [Image Build Process](#image-build-process)
9. [Install on Existing Debian](#install-on-existing-debian)
10. [Plugin System](#plugin-system)
11. [Unraid Importer](#unraid-importer)
12. [VM Dev Environment](#vm-dev-environment)
13. [Implemented Features](#implemented-features)

---

## What It Is

FreeRAID is a free, open-source NAS OS built on Debian 12. It boots from a USB drive and manages storage arrays via a web UI (Cockpit plugin). Core stack: SnapRAID (parity), mergerfs (pooling), Samba/NFS (sharing), Docker (apps).

The web UI runs on port `9090` and communicates with the system exclusively by spawning `freeraid <command>` via `cockpit.spawn()`. There is no separate API server — everything goes through the CLI.

Config persists to `/boot/config/freeraid.conf.json` which lives on the USB drive's config partition, so it survives OS reflashes.

---

## Directory Structure

```
FreeRAID/
├── core/
│   ├── freeraid              # Main CLI script (~4200 lines bash)
│   └── freeraid.conf.json    # Default config template
├── web/freeraid/
│   ├── index.html            # Single-page app (64 KB)
│   ├── freeraid.js           # All UI logic (187 KB)
│   ├── freeraid.css          # Dark theme, purple accent (45 KB)
│   ├── manifest.json         # Cockpit plugin registration
│   ├── terminal.html         # Per-container xterm.js terminal
│   ├── xterm.js / xterm.css / xterm-addon-fit.js
├── scripts/
│   ├── install.sh            # Install onto existing Debian 12
│   ├── build-image.sh        # Build live USB image (squashfs + kernel)
│   ├── create-usb.sh         # Write image to USB device
│   └── release.sh            # Build tarball + GitHub release
├── plugins/
│   ├── index.json            # Available plugins index
│   └── filebrowser/          # (example plugin dir)
├── importer/
│   └── unraid-import.py      # Unraid config → FreeRAID config converter
├── build/                    # Output of build-image.sh
│   ├── vmlinuz               # Kernel (~12 MB)
│   ├── initrd.gz             # Initramfs (~70 MB)
│   └── rootfs.squashfs       # Compressed root FS (~708 MB)
├── docs/
│   ├── ARCHITECTURE.md
│   └── PROGRESS.md           # Feature checklist + release history
├── vm/
│   ├── create-vm.sh          # Create QEMU dev VM (7 virtual disks)
│   ├── start-vm.sh
│   ├── setup-vm-network.sh   # TAP networking → VM gets LAN IP
│   └── teardown-vm-network.sh
├── VERSION                   # Single source of truth for version number
└── MASTER.md                 # This file
```

---

## Config File

Lives at `/boot/config/freeraid.conf.json` (on USB) or `/boot/config/freeraid.conf.json` (installed).

The CLI reads/writes this via `jq`. The web UI never touches it directly — it calls CLI commands.

```json
{
  "_version": "1",
  "_schema": "freeraid-config",

  "system": {
    "hostname": "freeraid",
    "timezone": "America/Chicago",
    "language": "en_US"
  },

  "array": {
    "state": "stopped",
    "parity": [
      { "slot": "parity", "device": "/dev/sdb", "label": "Parity",
        "mountpoint": "/mnt/parity", "fstype": "xfs" }
    ],
    "disks": [
      { "slot": "disk1", "device": "/dev/sdc", "mountpoint": "/mnt/disk1",
        "fstype": "xfs", "label": "Disk 1", "enabled": true,
        "uuid": "...", "serial": "..." }
    ],
    "cache": [
      { "slot": "cache", "device": "/dev/sdd", "mountpoint": "/mnt/cache",
        "fstype": "ext4", "label": "Cache", "enabled": true }
    ],
    "pool_mountpoint": "/mnt/user",
    "mergerfs_options": "defaults,allow_other,cache.files=partial,dropcacheonclose=true,category.create=mfs"
  },

  "snapraid": {
    "sync_schedule": "0 3 * * *",
    "scrub_schedule": "0 4 * * 0",
    "scrub_percent": 22,
    "scrub_age": 10,
    "diff_warn_deleted": 40,
    "diff_warn_updated": 40,
    "content_files": ["/mnt/disk1/.snapraid.content"],
    "exclude": ["/lost+found/", "*.tmp", "*.!qB", "*.part"]
  },

  "pools": [
    { "name": "appdata", "mountpoint": "/mnt/appdata",
      "disks": ["/dev/sde"], "mergerfs_options": "..." }
  ],

  "shares": [
    { "name": "Videos", "path": "/mnt/user/Videos",
      "smb_enabled": true, "smb_security": "public",
      "smb_read_list": [], "smb_write_list": [],
      "nfs_enabled": false, "cache_mode": "yes", "cache_pool": "cache" }
  ],

  "samba_anon": true,

  "network": {
    "interface": "eth0", "dhcp": true,
    "ip": "", "gateway": "", "dns": ["1.1.1.1", "8.8.8.8"]
  },

  "docker": {
    "enabled": true,
    "data_root": "/mnt/user/appdata",
    "compose_dir": "/etc/freeraid/compose",
    "autoupdate": {}
  },

  "notifications": {
    "email": { "enabled": false, "smtp_host": "", "smtp_port": "587",
               "smtp_user": "", "smtp_pass": "", "smtp_from": "", "smtp_to": "" },
    "webhook": { "enabled": false, "url": "", "type": "discord" },
    "events": {
      "array_degraded": true, "drive_temp": true,
      "sync_error": true, "scrub_error": true,
      "update_available": false, "container_updated": false
    },
    "temp_threshold": 55
  }
}
```

---

## CLI Commands

The `freeraid` CLI lives at `/usr/local/bin/freeraid`. It is the single interface between the web UI and the OS. All commands require root.

### Array

| Command | Description |
|---|---|
| `status [--json]` | Array state, disk usage, pool capacity |
| `start` | Mount disks, start mergerfs pool, enable services |
| `stop` | Clean unmount of pool and all disks |
| `add-disk <slot> <dev> [fstype]` | Add drive to array |
| `remove-disk <slot>` | Disable a drive slot |

### Parity (SnapRAID)

| Command | Description |
|---|---|
| `sync` | Update parity after file changes |
| `scrub` | Verify parity integrity |
| `diff` | Show what changed since last sync |
| `turbo-get` | Check turbo-write mode status |
| `turbo-set <true\|false>` | Enable/disable turbo-write (skips parity for speed) |

### Disks

| Command | Description |
|---|---|
| `disks-scan` | Detect all block devices with size/model/type |
| `disks-assign <dev> <role> [slot] [label]` | Assign to array/parity/cache |
| `disks-unassign <dev>` | Remove from config |
| `registry-sync` | Sync UUID/serial data from mounted drives |

### Pools (no-parity groups)

| Command | Description |
|---|---|
| `pool-list` | List all pools |
| `pool-add <name>` | Create pool |
| `pool-remove <name>` | Delete pool |
| `pool-assign <dev> <pool> [slot]` | Assign drive to pool |
| `pool-unassign <dev> <pool>` | Remove drive from pool |
| `pool-start <name>` | Start pool |
| `pool-stop <name>` | Stop pool |

### Shares (Samba/NFS)

| Command | Description |
|---|---|
| `shares-list` | JSON list of all shares |
| `shares-add <name>` | Create share |
| `shares-remove <name>` | Delete share |
| `shares-apply` | Write smb.conf and reload Samba |
| `shares-import <dir>` | Import from Unraid config directory |
| `shares-set-perms <name> <security> <read> <write>` | Set permissions (public/secure/private) |
| `shares-set-password <name> <password>` | Per-share Samba password |
| `shares-get-anon` / `shares-set-anon <true\|false>` | Anonymous access toggle |
| `shares-set-nfs <name> <enabled> <security> <options>` | NFS export config |
| `nfs-apply` | Write /etc/exports and reload NFS |

### Share Encryption (gocryptfs)

| Command | Description |
|---|---|
| `share-encrypt-enable <name> <password>` | Encrypt a share |
| `share-encrypt-disable <name> <password>` | Decrypt/remove encryption |
| `share-encrypt-unlock <name> <password>` | Unlock encrypted share |
| `share-encrypt-lock <name>` | Lock encrypted share |
| `share-encrypt-status <name>` | Show encryption status |

### Docker & Apps

| Command | Description |
|---|---|
| `docker-list` | List containers with state, ports, WebUI URLs (JSON) |
| `docker-start <name>` | Start container via docker-compose |
| `docker-stop <name>` | Stop container |
| `docker-logs <name>` | Tail last 100 lines |
| `docker-delete <name>` | Remove compose file |
| `docker-update <name>` | Update single container image |
| `docker-update-all` | Update all containers |
| `docker-autoupdate-set <name> <true\|false>` | Enable auto-update for container |
| `docker-autoupdate-get` | Get auto-update config (JSON) |
| `docker-get-config <name>` | Get compose YAML |
| `docker-network-list` | List Docker networks (JSON) |
| `docker-network-create <name> <driver> <subnet> [gateway]` | Create macvlan network |
| `docker-network-delete <name>` | Delete network |
| `ports-used` | JSON list of all in-use ports (docker + system) |
| `apps-fetch` | Download Unraid Community Applications feed (~3000 apps) |
| `apps-search <query> [limit]` | Search with relevance scoring |
| `apps-get <name>` | Get full app JSON with config template |
| `apps-install <name> [config-json]` | Generate docker-compose from template and install |
| `apps-categories` | List all app categories |

### Drive Health & Recovery

| Command | Description |
|---|---|
| `smart <dev>` | Full SMART data: health, temp, attributes, self-tests (JSON) |
| `smart-test <dev> [short\|long\|conveyance]` | Trigger SMART self-test |
| `replace-disk <slot> <dev>` | Format new drive, recover from parity, re-sync |
| `replace-disk-bg <slot> <dev>` | Background replace with status polling |
| `replace-disk-status <slot>` | Poll rebuild progress |
| `preclear-bg <dev>` | Background pre-clear (SMART → zero → SMART) |
| `preclear-status <dev>` | Poll preclear progress |
| `preclear-cancel <dev>` | Cancel preclear |

### Disk Balancer

| Command | Description |
|---|---|
| `balance-status` | Per-disk usage and balance progress (JSON) |
| `balance-bg [threshold]` | Start background file balancer (moves files from full → empty disks) |
| `balance-cancel` | Stop balancer |

### Cache Mover

| Command | Description |
|---|---|
| `mover-run` | Run cache mover now |
| `mover-status` | Get mover job status (JSON) |
| `mover-set-schedule <schedule> <type>` | Set nightly schedule (systemd timer format) |

### Parity Scheduler

| Command | Description |
|---|---|
| `parity-get-schedule` | Get current sync/scrub schedule (JSON) |
| `parity-set-schedule <sync-time> <scrub-day> <scrub-time>` | Set schedules |

### Monitoring & Performance

| Command | Description |
|---|---|
| `sysinfo` | CPU/RAM/network/uptime stats (JSON) |
| `iostat [interval]` | Per-disk I/O stats (KB/s read/write) |
| `spindown-get` | Get per-disk idle spindown timeout config |
| `spindown-set <dev> <minutes>` | Set spindown timeout (0=disabled) |
| `spindown-apply` | Apply spindown settings via hdparm |
| `temp-check [threshold]` | Check drive temps, send alerts if over threshold |

### Logging

| Command | Description |
|---|---|
| `logs-get <source> [lines]` | Get logs: freeraid/syslog/kernel/samba (JSON) |

### Network & System

| Command | Description |
|---|---|
| `set-hostname <name>` | Set server hostname |
| `network-info` | Get current network config (JSON) |
| `network-set <iface> <dhcp\|static> <ip-cidr> <gw> [dns]` | Configure network |

### Users (Samba)

| Command | Description |
|---|---|
| `users-list` | JSON list of all Samba users |
| `users-add <name> [password]` | Add Samba user |
| `users-delete <name>` | Remove user |
| `users-setpassword <name> <password>` | Change password |
| `users-enable-samba <name> <password>` | Enable Samba for user |
| `users-disable-samba <name>` | Disable Samba for user |

### UPS/NUT

| Command | Description |
|---|---|
| `ups-status` | Battery/load/runtime status (JSON) |
| `ups-config-get` | Get NUT config (JSON) |
| `ups-config-set <config-json>` | Update NUT config |

### Tailscale VPN

| Command | Description |
|---|---|
| `tailscale-status` | Connection status |
| `tailscale-install` | Install Tailscale |
| `tailscale-up` | Connect to Tailscale network |
| `tailscale-down` | Disconnect |

### Notifications

| Command | Description |
|---|---|
| `notify-get` | Get notification config (JSON) |
| `notify-set <config-json>` | Update config (email/webhook/Discord/Slack) |
| `notify-send <event> <message>` | Send notification now |
| `notify-test <method>` | Test email or webhook |

### Plugins

| Command | Description |
|---|---|
| `plugin-list` | List installed plugins |
| `plugin-available` | List available plugins from index.json |
| `plugin-install <name>` | Download and run install.sh |
| `plugin-remove <name>` | Uninstall plugin |
| `plugin-update <name>` | Update plugin |

### VM Management (KVM/QEMU)

| Command | Description |
|---|---|
| `vm-list` | List VMs (JSON) |
| `vm-create <name> [ram-mb] [cores] [disk-gb] [os] [extra]` | Create VM |
| `vm-start <name>` | Power on |
| `vm-stop <name> [force]` | Power off (graceful or force) |
| `vm-delete <name>` | Delete VM |
| `vm-info <name>` | VM details (JSON) |
| `vm-vnc-port <name>` | Get VNC port |
| `vm-iso-list` | List available ISOs |

### ZFS

| Command | Description |
|---|---|
| `zfs-pool-list` | List ZFS pools |
| `zfs-pool-status <pool>` | Pool status/health |
| `zfs-pool-create <pool> <layout> <devs...>` | Create pool (stripe/mirror/raidz) |
| `zfs-pool-destroy <pool>` | Destroy pool |
| `zfs-pool-scrub <pool>` | Run ZFS scrub |
| `zfs-pool-import <pool>` | Import pool |
| `zfs-import-scan` | Scan for importable pools |
| `zfs-dataset-create <pool/dataset> [compression]` | Create dataset |
| `zfs-dataset-destroy <pool/dataset>` | Destroy dataset |
| `zfs-snapshot-list <pool/dataset>` | List snapshots |
| `zfs-snapshot-create <pool/dataset@snap>` | Create snapshot |
| `zfs-snapshot-delete <snap>` | Delete snapshot |
| `zfs-snapshot-rollback <snap>` | Rollback to snapshot |
| `zfs-set-prop <pool/dataset> <prop> <value>` | Set ZFS property |

### Setup Wizard

| Command | Description |
|---|---|
| `setup-status` | Wizard completion status (JSON) |
| `setup-complete` | Mark wizard complete |

### Updates

| Command | Description |
|---|---|
| `check-update` | Compare installed vs latest GitHub release (JSON) |
| `update` | Download and apply latest release tarball |

### System

| Command | Description |
|---|---|
| `install-deps` | Install all package dependencies (Debian) |
| `config` | Print config file path and contents |
| `version` | Show installed version |
| `help` | Show help text |

---

## Web UI

### Stack

Single-page app served by Cockpit at `https://<ip>:9090`. No build step — vanilla JS/HTML. Cockpit communicates with the system via `cockpit.spawn()` which runs CLI commands as root.

### Files

| File | Size | Purpose |
|---|---|---|
| `index.html` | 64 KB | Full SPA markup, tabs, modals, wizard |
| `freeraid.js` | 187 KB | All UI logic and CLI dispatch |
| `freeraid.css` | 45 KB | Dark theme, purple accent |
| `manifest.json` | 295 B | Cockpit plugin registration |
| `terminal.html` | 3 KB | Per-container xterm.js terminal |
| `xterm.js/css` | bundled | Terminal emulator v5.3.0 |

### Tabs

1. **Dashboard** — Array status, disk cards, pool capacity, last sync, controls, CPU/RAM/network sparklines
2. **Disks** — Scan, assign, unassign, replace, preclear, SMART modal
3. **Shares** — List/create, Unraid ZIP uploader, per-share passwords, encryption, NFS
4. **Docker** — Container cards, 3000-app browser, install form, network selector, logs, terminal
5. **Network** — Hostname, DHCP/static IP, DNS
6. **Share Users** — Samba user CRUD, enable/disable, passwords
7. **Logs** — FreeRAID/syslog/kernel/Samba viewer with live tail
8. **Settings** — Version, check/apply updates with live log stream, system info
9. **Plugins** — List/install available plugins

### First-Boot Wizard Steps

1. Welcome (fresh start or migrate from Unraid)
2. Hostname & network (DHCP or static)
3. Unraid import (optional ZIP upload)
4. Assign drives (parity, data, cache)
5. Start array

### Update Notification

The Settings tab calls `freeraid check-update` every 8 seconds. If `update_available: true`, it shows a notification banner. "Update Now" streams `freeraid update` output live. After completion, sets `sessionStorage.justUpdated` and reloads the page.

---

## Update Process

### How Updates Work on Devices

1. Device calls `freeraid check-update`
2. CLI hits `https://api.github.com/repos/crucifix86/FreeRAID/releases/latest`
3. Compares `tag_name` to `/etc/freeraid/VERSION`
4. Returns `{"update_available": true/false, "current": "0.5.3", "latest": "0.5.4", "notes": "..."}`

If update available, `freeraid update` runs:
1. Downloads `freeraid-components-VERSION.tar.gz` from the release assets
2. Extracts to `/tmp/freeraid-update-XXXXXX/`
3. Installs:
   - `freeraid` → `/usr/local/bin/freeraid` (chmod +x)
   - `web/freeraid/*` → `/usr/share/cockpit/freeraid/`
   - `unraid-import` → `/usr/local/bin/freeraid-import` (chmod +x)
   - `compose/*.yml` → `/boot/config/compose/` (skip if file already exists)
4. Updates `/etc/freeraid/VERSION`

### How to Cut a Release

**Script**: `bash scripts/release.sh <version> "<notes>"`

Example:
```bash
bash scripts/release.sh 0.5.4 "Fix samba user creation on setup"
```

What it does:

1. **Updates `VERSION` file** with the new version number

2. **Builds the component tarball** — stages a temp dir with:
   - `freeraid` (from `core/freeraid`)
   - `unraid-import` (from `importer/unraid-import.py`)
   - `web/freeraid/` (manifest.json, index.html, freeraid.css, freeraid.js)
   - `compose/` (Docker compose templates if any)
   - `VERSION` file
   - Output: `freeraid-components-0.5.4.tar.gz`

3. **Commits and tags**:
   ```
   git add VERSION core/freeraid
   git commit -m "Release v0.5.4"
   git tag -a v0.5.4 -m "0.5.4 — Fix samba user creation on setup"
   ```

4. **Pushes to GitHub**:
   ```
   git push origin main
   git push origin v0.5.4
   ```

5. **Creates GitHub Release** with tarball attached:
   ```
   gh release create v0.5.4 freeraid-components-0.5.4.tar.gz \
     --title "FreeRAID v0.5.4" \
     --notes "Fix samba user creation on setup"
   ```

Devices will pick up the update on next `check-update` poll.

> **Note**: The tarball is what gets distributed. The live USB image (squashfs) is NOT re-built on every release — the OS image stays the same and only the FreeRAID components (CLI + web UI) are updated in-place.

---

## USB Creation Process

**Script**: `bash scripts/create-usb.sh /dev/sdX [unraid-backup.zip]`

This writes a bootable FreeRAID USB. Requires pre-built artifacts from `build/` (see [Image Build Process](#image-build-process)).

### Full Process

1. **Unmount** all existing partitions on the target device

2. **Partition** as FAT32 MBR:
   ```bash
   parted -s /dev/sdX mklabel msdos
   parted -s /dev/sdX mkpart primary fat32 1MiB 100%
   mkfs.vfat -F 32 -n FREERAID /dev/sdX1
   ```
   The `FREERAID` label is how the live system finds the config partition at boot.

3. **Mount** USB partition to temp dir

4. **Install GRUB2 EFI** (UEFI boot):
   - Creates `/EFI/BOOT/BOOTX64.EFI`
   - Uses GRUB's `$cmdpath` to auto-detect the boot device
   - Boot menu entries:
     - `FreeRAID v0.5.3` → `boot=live quiet loglevel=3`
     - `FreeRAID v0.5.3 (verbose)` → `boot=live loglevel=7`
     - `Boot from local disk` → exits GRUB

5. **Install Syslinux** (legacy BIOS boot):
   - Writes MBR boot code
   - Copies `libutil.c32`, `libcom32.c32`, `menu.c32`
   - Menu-driven boot selector

6. **Copy live image files**:
   ```
   build/vmlinuz        → /vmlinuz
   build/initrd.gz      → /initrd.gz
   build/rootfs.squashfs → /live/filesystem.squashfs
   ```

7. **Set up config partition**:
   ```
   /config/
   /config/compose/
   /config/freeraid.conf.json   (default config)
   ```
   If an Unraid backup ZIP was provided:
   ```
   /config/unraid-backup.zip
   ```
   A first-boot systemd service detects this file and auto-runs the importer.

8. **Finalize**: sync, unmount, done.

### Boot Flow

- **UEFI**: GRUB2 → loads vmlinuz + initrd.gz → live-boot mounts squashfs as root
- **BIOS**: Syslinux → loads vmlinuz + initrd.gz → same
- `live-boot` detects the partition with label `FREERAID` and bind-mounts it:
  - USB config partition → `/mnt/freeraid-usb`
  - `/mnt/freeraid-usb/config` → `/boot/config`
- All FreeRAID config, compose files, and Samba databases persist here across reboots

---

## Image Build Process

**Script**: `bash scripts/build-image.sh`

Produces `build/vmlinuz`, `build/initrd.gz`, `build/rootfs.squashfs`. Only needs to be re-run when you want to change the base OS image. Regular FreeRAID updates do NOT require rebuilding the image.

### Steps

1. **Debootstrap** Debian 12 minimal rootfs into `build/rootfs/`

2. **Install packages in chroot**:
   - Storage: `xfsprogs btrfs-progs e2fsprogs snapraid mergerfs`
   - Sharing: `samba wsdd avahi-daemon nfs-kernel-server`
   - Docker: `docker.io docker-compose-plugin`
   - UI: `cockpit`
   - Monitoring: `smartmontools hdparm msmtp`
   - Virtualization: `qemu-kvm libvirt virtinst`
   - ZFS (from backports)
   - Live boot: `live-boot live-boot-initramfs-tools`
   - NIC firmware: `firmware-linux firmware-realtek` etc.

3. **Install FreeRAID** into the chroot:
   - `core/freeraid` → `/usr/local/bin/freeraid`
   - `importer/unraid-import.py` → `/usr/local/bin/freeraid-import`
   - `web/freeraid/` → `/usr/share/cockpit/freeraid/`
   - Branding CSS + login HTML → `/usr/share/cockpit/branding/default/`

4. **Configure the live system** in chroot:
   - Hostname: `freeraid`, root password: `freeraid`
   - Samba: root user `freeraid` (pdbedit/smbpasswd)
   - SSH: allow root password login
   - Cockpit: empty `disallowed-users` (allow root login)
   - Network: systemd-networkd with DHCP on wired interfaces
   - Docker: vfs storage driver (works on overlayfs live system)
   - Systemd services enabled:
     - `freeraid-array.service` (start array on boot)
     - `freeraid-sync.timer` (daily 03:00)
     - `freeraid-scrub.timer` (Sunday 04:00)
     - `freeraid-mover.timer` (daily 02:00)
     - `freeraid-docker-update.timer` (daily 04:00)
     - Config mount service (mounts USB config partition → `/boot/config`)
     - First-boot importer (detects `/boot/config/unraid-backup.zip`)

5. **Extract initrd** from chroot (includes live-boot hooks) → `build/initrd.gz`

6. **Build squashfs** from chroot:
   ```bash
   mksquashfs build/rootfs build/rootfs.squashfs -comp xz
   ```
   Excludes `/boot/` (kernel copied separately). Takes a while.

7. **Copy kernel**:
   ```bash
   cp build/rootfs/boot/vmlinuz-* build/vmlinuz
   ```

---

## Install on Existing Debian

**Script**: `bash scripts/install.sh`

Alternative to the live USB — installs FreeRAID onto an already-running Debian 12 system.

### Steps

1. Detect architecture (amd64, arm64, armhf)
2. Add Debian backports (for ZFS)
3. Install all required packages (same list as image build)
4. Install FreeRAID CLI to `/usr/local/bin/freeraid`
5. Create directories: `/boot/config/`, `/var/log/freeraid/`, `/mnt/user/`, etc.
6. Write default `freeraid.conf.json` to `/boot/config/` (skip if exists)
7. Install and enable systemd services (array, sync, scrub, mover, docker-update)
8. Install Cockpit plugin to `/usr/share/cockpit/freeraid/`
9. Configure Cockpit for root login
10. Scan for Unraid USB, suggest `freeraid-import` if found

---

## Plugin System

### Available Plugins (`plugins/index.json`)

| Name | Category | Description |
|---|---|---|
| scrutiny | monitoring | SMART health monitoring with historical tracking |
| netdata | monitoring | Real-time CPU/RAM/network/disk dashboard |
| filebrowser | files | Web-based file manager for the array |
| wireguard | network | WireGuard VPN server with QR code client config |
| duplicati | backup | Encrypted cloud backups to S3, B2, Google Drive |

### Plugin CLI

```bash
freeraid plugin-available          # list from index.json
freeraid plugin-install scrutiny   # download + run install.sh
freeraid plugin-list               # show installed
freeraid plugin-remove scrutiny
freeraid plugin-update scrutiny
```

Each plugin has an `install_url` pointing to its `install.sh` on GitHub.

---

## Unraid Importer

**Script**: `importer/unraid-import.py`

Converts an Unraid config backup to FreeRAID format.

### What It Reads

| Unraid file | What it imports |
|---|---|
| `disk.cfg` | Parity, data disks, cache drives |
| `network.cfg` + `ident.cfg` | Hostname, DHCP/static IP, DNS |
| `shares/*.cfg` | SMB security, NFS config, cache mode, include/exclude disk lists |
| `plugins/dockerMan/templates-user/*.xml` | Docker app templates → docker-compose.yml |

### Usage

```bash
# From extracted ZIP
python3 unraid-import.py /path/to/unraid/config \
  --out freeraid.conf.json \
  --compose-dir ./compose

# Auto-mount Unraid USB
python3 unraid-import.py /dev/sdb \
  --out freeraid.conf.json
```

### Output

- `freeraid.conf.json` — complete config with imported disks, network, shares
- `compose/*.docker-compose.yml` — one file per imported Docker app
- Console summary: disk count, share count, app count

> Note: Disk assignments import device names (e.g. `/dev/sdb`) not UUIDs. If the new system has different device ordering, manual re-mapping is needed.

---

## VM Dev Environment

Used for local testing without real hardware.

### Setup

```bash
# Create VM with 7 virtual disks
bash vm/create-vm.sh

# Set up TAP networking so VM gets a real LAN IP
bash vm/setup-vm-network.sh

# Start VM
bash vm/start-vm.sh
```

VM gets IP `192.168.1.150` (configured in `vm/vm-netplan.yaml`).

Access:
- SSH: `ssh root@192.168.1.150` (password: `freeraid`)
- Web UI: `https://192.168.1.150:9090`

### Tear Down

```bash
bash vm/teardown-vm-network.sh
```

### Virtual Disk Layout

| Purpose | Size |
|---|---|
| OS disk | 20 GB |
| Data disk × 3 | 8 GB each |
| Parity disk | 8 GB |
| Cache disk | 8 GB |
| Extra disk | 4 GB |

---

## Implemented Features (v0.5.3)

### Storage
- Array start/stop, turbo-write mode
- Parity sync/scrub/diff (SnapRAID)
- Multi-disk pool (mergerfs)
- Multiple no-parity pools
- File balancer (rebalances full vs empty disks)
- Cache mover (cache → array on schedule)
- UUID-based drive tracking (survives device renumbering)

### Drive Management
- Full SMART data (health, temp, attributes, self-tests)
- Drive pre-clear (SMART → zero fill → SMART)
- Drive replacement with parity recovery (background, pollable)
- Per-disk spindown idle timeout
- Temperature threshold alerts

### Shares
- Samba SMB with per-user permissions (public/secure/private)
- Per-share dedicated Samba passwords
- Share encryption (gocryptfs)
- NFS export configuration
- Unraid config import (ZIP uploader in web UI)

### Docker / Apps
- 3000+ app browser (Unraid Community Applications)
- Port conflict detection
- Bridge / Host / macvlan network modes
- Per-container auto-update
- xterm.js in-browser container terminals
- Docker macvlan networks with static IP

### Monitoring
- Per-disk SMART health + temperature
- CPU/RAM/network sparkline graphs
- Per-disk I/O stats (KB/s)
- System log viewer (FreeRAID/syslog/kernel/Samba)

### Users
- Add/delete/rename Samba users
- Per-user Samba enable/disable
- Per-user and per-share password management
- Anonymous guest access toggle

### Network
- Hostname configuration
- DHCP or static IP
- Network discovery (Avahi + WSDD)
- Tailscale VPN integration

### Notifications
- Email (msmtp) and webhook (Discord/Slack)
- Per-event toggles
- Drive temperature threshold alerts

### Virtualization
- KVM/QEMU VM create/start/stop/delete
- VNC access per VM
- ISO management

### ZFS
- Pool create/destroy/scrub/import
- Dataset create/destroy
- Snapshot create/delete/rollback
- ZFS property management

### System
- First-boot setup wizard
- Custom branded login page
- In-place updates via GitHub releases (web UI + CLI)
- Plugin install/remove/update
- UPS/NUT battery monitoring
