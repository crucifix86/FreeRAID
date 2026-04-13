# FreeRAID

A free, open-source NAS operating system that runs entirely from a USB drive. No installation required — plug it in, power on, and manage your array from a web browser.

Inspired by Unraid. Built on Debian 12 + Cockpit + SnapRAID + mergerfs.

---

## Screenshots

| | |
|---|---|
| ![Login](docs/screenshots/01-login.png) | ![Dashboard](docs/screenshots/02-dashboard.png) |
| **Themed login page** | **Dashboard — array status, parity schedule, cache mover** |
| ![Shares](docs/screenshots/03-shares.png) | ![Settings](docs/screenshots/04-settings.png) |
| **Shares — SMB/NFS per-share, Unraid config drop-in import** | **Settings — one-click updates, email/webhook notifications** |

---

## Features

- **Runs from USB** — boots into RAM, USB is only used for persistent config
- **Web UI** — full management interface via browser (no monitor needed)
- **SnapRAID + mergerfs** — parity protection and unified storage pool
- **Docker** — install and manage containers through the UI
- **Samba + NFS** — network shares for Windows, Mac, and Linux
- **Unraid import** — migrate existing Unraid configs and shares
- **UEFI + BIOS** — boots on modern and legacy hardware

---

## Requirements

- x86-64 PC or server (mini PCs like N95, N100 work great)
- 4GB+ RAM (8GB+ recommended — OS runs in RAM)
- USB drive (8GB+) for the boot drive
- One or more storage drives for your array

---

## Building

On a Debian/Ubuntu system:

```bash
# Install build dependencies
sudo apt-get install -y debootstrap squashfs-tools busybox-static \
    grub-efi-amd64-bin syslinux dosfstools parted

# Build the live image (takes 15-20 minutes)
sudo bash scripts/build-image.sh
```

Output goes to `build/`: `vmlinuz`, `initrd.gz`, `rootfs.squashfs`

---

## Creating a USB Drive

```bash
# Write to USB (replace /dev/sdX with your USB device)
sudo bash scripts/create-usb.sh /dev/sdX

# Optionally import an existing Unraid backup
sudo bash scripts/create-usb.sh /dev/sdX /path/to/unraid-backup.zip
```

---

## First Boot

1. Plug the USB into your server and power on
2. Open a browser and go to `https://<server-ip>:9090`
3. Log in with `root` / `freeraid`
4. Follow the setup wizard to assign drives and start the array

Config is saved to the USB drive — your settings survive reboots. Array data lives on your storage drives.

---

## Updating

From the FreeRAID web UI, go to Settings and click **Check for Updates**. Updates apply in-place without touching your array data or config.

---

## Project Structure

```
core/           freeraid CLI (main management script)
web/            Cockpit web UI plugin
scripts/        build-image.sh, create-usb.sh
importer/       Unraid config importer
compose/        Default Docker compose templates
docs/           Architecture and development notes
```

---

## License

FreeRAID is free for personal and non-commercial use. See [LICENSE](LICENSE) for details.
