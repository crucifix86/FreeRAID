# FreeRAID

A free, open-source NAS operating system that boots from a USB drive. No installation to internal disk required — plug it in, power on, and manage your array from a web browser.

Inspired by Unraid. Built on Debian 12 + Cockpit + SnapRAID + mergerfs.

> ⚠️ **Public Beta — expect bugs.** FreeRAID is in active development. Core functionality works (SnapRAID pool, shares, Docker, Unraid import, USB boot), but you'll hit rough edges. Things may break, require manual intervention, or need a reboot. Please [file issues](https://github.com/crucifix86/FreeRAID/issues) when something surprises you — your feedback drives the roadmap.

**→ Get the installer, images, and screenshots at [getfreeraid.com](https://getfreeraid.com)**

---

## Install (the easy way)

### 1. Get the installer

Grab the pre-built GUI installer from the official site:

**→ [https://getfreeraid.com/download/](https://getfreeraid.com/download/)**

Linux x86-64, single file, no dependencies. (Windows and macOS installers are planned.)

### 2. Run it

```bash
chmod +x freeraid-installer
sudo ./freeraid-installer
```

### 3. Use it

- Pick a USB drive from the list
- (Optional) Select your Unraid flash-backup zip to carry over shares, disks, and containers
- (Optional) Tick **Skip parity sync** to preserve Unraid's parity for a safe test boot
- Click **Write USB**

The installer always downloads the latest image from getfreeraid.com, so you can't end up with a stale one.

> 🧪 **The GUI installer is still under testing.** If it fails, copy the output panel and [open an issue](https://github.com/crucifix86/FreeRAID/issues).

---

## Screenshots

| | |
|---|---|
| ![Login](docs/screenshots/01-login.png) | ![Dashboard](docs/screenshots/02-dashboard.png) |
| **Themed login page** | **Dashboard — array status, parity schedule, cache mover** |
| ![Shares](docs/screenshots/03-shares.png) | ![Settings](docs/screenshots/04-settings.png) |
| **Shares — SMB/NFS per-share, Unraid config drop-in import** | **Settings — updates, notifications, alerts** |

---

## Features

- **Boots from USB** — OS lives on the USB stick alongside your persistent config
- **Web UI** — full management interface via browser (no monitor needed)
- **SnapRAID + mergerfs** — scheduled parity protection (up to 6 parity disks) and unified storage pool
- **Docker** — install and manage containers through the UI
- **Samba + NFS** — network shares for Windows, Mac, and Linux
- **Unraid import** — migrate existing Unraid configs, shares, and docker containers [¹](#unraid-import-notes)
- **Safe test boot** — skip-parity mode leaves your Unraid parity untouched so you can swap USBs freely
- **UEFI + BIOS** — boots on modern and legacy hardware

---

## Requirements

- x86-64 PC or server
- 4 GB+ RAM
- USB drive (8 GB+) for the boot drive
- One or more storage drives for your array

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

## Building from source

Most users should grab the installer from [getfreeraid.com](https://getfreeraid.com/download/). Building is only needed if you're hacking on FreeRAID itself.

```bash
# Debian/Ubuntu host
sudo apt-get install -y debootstrap squashfs-tools busybox-static \
    grub-efi-amd64-bin syslinux dosfstools parted

# Live image (~15-20 min)
sudo bash scripts/build-image.sh

# GUI installer binary
sudo apt install -y python3-tk python3-pip
pip install --user pyinstaller
bash scripts/build-installer.sh        # → dist/freeraid-installer
```

---

## Project Structure

```
core/           freeraid CLI (main management script)
web/            Cockpit web UI plugin
scripts/        build-image.sh, build-installer.sh, create-usb.sh, installer.py
importer/       Unraid config importer
compose/        Default Docker compose templates
docs/           Architecture and development notes
```

---

## Unraid Import Notes

<a id="unraid-import-notes"></a>

The Unraid importer reads your flash-backup zip offline, which means it picks up **every docker container template Unraid has on record** — not just the ones currently running. Unraid keeps XML templates in `/boot/config/plugins/dockerMan/templates-user/` for every container you've ever installed, even after you delete the container. So if you've been on Unraid for years, expect to see dozens of historical apps listed after import.

**Before you make your flash backup**, it's worth a quick cleanup on Unraid:

1. Go to **Docker → Add Container**, open the template dropdown ("User templates")
2. Remove templates you don't use anymore (trash icon next to each)
3. Then make your flash backup and run the FreeRAID installer

Containers that aren't running are imported as **stopped** on FreeRAID — they don't consume resources, they just clutter the Docker tab. You can also just delete them from FreeRAID's UI after first boot.

### Set the IP before starting containers

Your imported Unraid config includes the old static IP of your Unraid box, but on the first FreeRAID boot the machine will typically come up on **DHCP** instead. Many Unraid container templates have the old IP baked into their `WebUI` URLs and some apps (Plex `customConnections`, `\*arr` app URLs, etc.) depend on it.

**Before you start the containers**, go to **Settings → Network** and set a static IP that matches what your Unraid used to have. Then start containers from the Docker tab. Everything will come back up at the same URLs it had before.

---

## Feedback

Bugs, feature requests, and rough edges: [open an issue](https://github.com/crucifix86/FreeRAID/issues).

---

## License

FreeRAID is free for personal and non-commercial use. See [LICENSE](LICENSE) for details.
