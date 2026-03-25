#!/usr/bin/env bash
# FreeRAID USB Creator
# Creates a bootable installer USB that auto-installs FreeRAID on your server.
#
# Usage:
#   sudo bash scripts/create-usb.sh /dev/sdX
#   sudo bash scripts/create-usb.sh /dev/sdX /path/to/unraid-backup.zip
#
# The USB will:
#   - Boot on any x86_64 server (BIOS or UEFI) via syslinux
#   - Auto-install Debian 12 + FreeRAID to the server's boot disk
#   - Set up freeraid / freeraid as the admin login
#   - Import your Unraid config if you provide a backup zip
#   - Bring up the Cockpit web UI at http://<server-ip>:9090
#
# Requires: syslinux, dosfstools, parted, curl, cpio, gzip

set -euo pipefail

USB_DEV="${1:-}"
UNRAID_ZIP="${2:-}"
LABEL="FREERAID"
FREERAID_GITHUB="https://raw.githubusercontent.com/crucifix86/FreeRAID/main"

# Debian 12 netboot files (no ISO needed — downloads packages over network)
NETBOOT_BASE="https://deb.debian.org/debian/dists/bookworm/main/installer-amd64/current/images/netboot/debian-installer/amd64"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
die()   { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}[$1]${NC} $2"; }

# ── Preflight checks ──────────────────────────────────────────────────────────

[[ -z "$USB_DEV" ]] && { echo "Usage: sudo $0 /dev/sdX [unraid-backup.zip]"; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die "Run as root: sudo $0 $*"
[[ -b "$USB_DEV" ]] || die "Not a block device: $USB_DEV"

for tool in syslinux mkfs.vfat parted curl cpio gzip; do
    command -v "$tool" &>/dev/null || die "Required tool missing: $tool — run: apt-get install -y syslinux dosfstools parted curl"
done

# Warn if USB seems too large to actually be a USB
USB_SIZE_BYTES=$(lsblk -bno SIZE "$USB_DEV" | head -1)
USB_SIZE_GB=$(( USB_SIZE_BYTES / 1024 / 1024 / 1024 ))
if [[ $USB_SIZE_GB -gt 128 ]]; then
    warn "$USB_DEV is ${USB_SIZE_GB}GB — that seems large for a USB drive."
    read -rp "Are you sure this is the right device? Type YES to continue: " ans
    [[ "$ans" == "YES" ]] || { echo "Aborted."; exit 1; }
fi

USB_LABEL=$(lsblk -no LABEL "$USB_DEV" 2>/dev/null | head -1 || true)
echo ""
echo -e "${BOLD}FreeRAID USB Creator${NC}"
echo -e "  Target device : ${BOLD}$USB_DEV${NC} (${USB_SIZE_GB}GB, current label: ${USB_LABEL:-none})"
echo -e "  Unraid backup : ${UNRAID_ZIP:-none}"
echo ""
echo -e "${RED}  !! ALL DATA ON $USB_DEV WILL BE ERASED !!${NC}"
echo ""
read -rp "  Type YES to create the FreeRAID USB: " confirm
[[ "$confirm" == "YES" ]] || { echo "Aborted."; exit 1; }

# ── Unmount anything on the device ───────────────────────────────────────────

step "1/7" "Unmounting $USB_DEV"
for part in "${USB_DEV}"*; do
    if mount | grep -q "^${part} "; then
        umount "$part" && info "Unmounted $part"
    fi
done

# ── Partition ─────────────────────────────────────────────────────────────────

step "2/7" "Partitioning $USB_DEV as FAT32 (MBR)"

parted -s "$USB_DEV" mklabel msdos
parted -s "$USB_DEV" mkpart primary fat32 1MiB 100%
parted -s "$USB_DEV" set 1 boot on

# Figure out partition device name (handles /dev/sda1 vs /dev/mmcblk0p1 etc)
if [[ "$USB_DEV" =~ [0-9]$ ]]; then
    PART="${USB_DEV}p1"
else
    PART="${USB_DEV}1"
fi

sleep 1
partprobe "$USB_DEV" 2>/dev/null || true
sleep 1

mkfs.vfat -F 32 -n "$LABEL" "$PART"
info "Partition created: $PART (FAT32, label: $LABEL)"

# ── Install syslinux MBR (BIOS boot) ─────────────────────────────────────────

step "3/7" "Installing syslinux bootloader"

# Write MBR
dd if=/usr/lib/syslinux/mbr/mbr.bin of="$USB_DEV" bs=440 count=1 conv=notrunc 2>/dev/null
info "MBR written"

# Install syslinux to the partition
syslinux --install "$PART"
info "Syslinux installed to $PART"

# ── Mount and populate ────────────────────────────────────────────────────────

step "4/7" "Populating USB"

MNT=$(mktemp -d /tmp/freeraid-usb-XXXXXX)
trap "umount '$MNT' 2>/dev/null || true; rm -rf '$MNT'" EXIT

mount "$PART" "$MNT"

# ── Syslinux files ────────────────────────────────────────────────────────────

mkdir -p "$MNT/syslinux" "$MNT/EFI/boot"

SYSLINUX_BIOS="/usr/lib/syslinux/modules/bios"
SYSLINUX_EFI64="/usr/lib/syslinux/modules/efi64"

# BIOS modules
for f in menu.c32 libutil.c32 mboot.c32 libcom32.c32; do
    [ -f "$SYSLINUX_BIOS/$f" ] && cp "$SYSLINUX_BIOS/$f" "$MNT/syslinux/"
done
cp /usr/lib/syslinux/mbr/mbr.bin "$MNT/syslinux/"

# EFI64 modules (ldlinux.e64 is the EFI bootloader application)
for f in ldlinux.e64 menu.c32 libutil.c32 mboot.c32 libcom32.c32; do
    [ -f "$SYSLINUX_EFI64/$f" ] && cp "$SYSLINUX_EFI64/$f" "$MNT/EFI/boot/"
done
# EFI requires the bootloader to be named bootx64.efi
cp "$SYSLINUX_EFI64/ldlinux.e64" "$MNT/EFI/boot/bootx64.efi"

# EFI syslinux.cfg just includes the main one
cat > "$MNT/EFI/boot/syslinux.cfg" <<'EOF'
include /syslinux/syslinux.cfg
EOF

info "Syslinux BIOS + EFI64 files copied"

# ── Download Debian 12 netboot kernel + initrd ────────────────────────────────

step "5/7" "Downloading Debian 12 installer kernel + initrd"

info "Fetching vmlinuz..."
curl -fsSL --progress-bar "${NETBOOT_BASE}/vmlinuz" -o "$MNT/vmlinuz"

info "Fetching initrd.gz..."
curl -fsSL --progress-bar "${NETBOOT_BASE}/initrd.gz" -o /tmp/freeraid-initrd-orig.gz

# ── Build preseed + first-boot script, embed in initrd ───────────────────────

step "6/7" "Building preseed and embedding in initrd"

INITRD_WORK=$(mktemp -d /tmp/freeraid-initrd-XXXXXX)
trap "umount '$MNT' 2>/dev/null || true; rm -rf '$MNT' '$INITRD_WORK'" EXIT

# Extract initrd
cd "$INITRD_WORK"
gzip -dc /tmp/freeraid-initrd-orig.gz | cpio -id --quiet

# ── Write preseed.cfg into initrd root ───────────────────────────────────────

cat > "$INITRD_WORK/preseed.cfg" <<'PRESEED'
# FreeRAID Auto-Install Preseed
# Fully unattended Debian 12 + FreeRAID installer

d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us
d-i keyboard-configuration/layoutcode string us

# Network — DHCP, wait up to 60s
d-i netcfg/choose_interface select auto
d-i netcfg/dhcp_timeout string 60
d-i netcfg/get_hostname string freeraid
d-i netcfg/get_domain string local
d-i netcfg/wireless_wep string

# Mirror
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string
d-i mirror/suite string bookworm

# Clock
d-i clock-setup/utc boolean true
d-i time/zone string US/Eastern
d-i clock-setup/ntp boolean true

# Disk — auto partition, install to smallest disk that isn't the USB
# The early_command selects the right target disk and sets it for partman.
d-i partman/early_command string \
    USB_DEV=$(blkid -L FREERAID 2>/dev/null | sed 's/[0-9]*$//'); \
    TARGET=$(lsblk -dno NAME,SIZE,TYPE | awk '$3=="disk"' | \
             grep -v "$(basename $USB_DEV)" | \
             sort -k2 -h | head -1 | awk '{print "/dev/"$1}'); \
    [ -z "$TARGET" ] && TARGET=$(lsblk -dno NAME,TYPE | awk '$2=="disk"' | \
             grep -v "$(basename $USB_DEV)" | head -1 | awk '{print "/dev/"$1}'); \
    debconf-set partman-auto/disk "$TARGET"; \
    debconf-set grub-installer/bootdev "$TARGET"

d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-auto-lvm/guided_size string max
d-i partman/default_filesystem string ext4
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i partman-md/confirm boolean true
d-i partman-lvm/confirm boolean true
d-i partman-lvm/confirm_nooverwrite boolean true

# Root + freeraid user
d-i passwd/root-login boolean true
d-i passwd/root-password password freeraid
d-i passwd/root-password-again password freeraid
d-i passwd/make-user boolean true
d-i passwd/user-fullname string FreeRAID Admin
d-i passwd/username string freeraid
d-i passwd/user-password password freeraid
d-i passwd/user-password-again password freeraid
d-i passwd/user-default-groups string sudo

# Minimal install + tools needed for FreeRAID installer
tasksel tasksel/first multiselect standard
d-i pkgsel/include string curl wget git openssh-server sudo
d-i pkgsel/upgrade select full-upgrade
popularity-contest popularity-contest/participate boolean false

# GRUB bootloader to the target disk
d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default
d-i grub-installer/force-efi-extra-removable boolean true

# Finish
d-i finish-install/keep-consoles boolean false
d-i finish-install/reboot_in_progress note

# Post-install: write first-boot service then hand off
d-i preseed/late_command string \
    USBD=$(blkid -L FREERAID 2>/dev/null || echo ""); \
    ZIPFILE=""; \
    if [ -n "$USBD" ]; then \
        mkdir -p /mnt/frusb && mount "$USBD" /mnt/frusb 2>/dev/null || true; \
        [ -f /mnt/frusb/config/unraid-backup.zip ] && \
            cp /mnt/frusb/config/unraid-backup.zip /target/root/unraid-backup.zip && \
            ZIPFILE="/root/unraid-backup.zip"; \
        umount /mnt/frusb 2>/dev/null || true; \
    fi; \
    mkdir -p /target/etc/freeraid; \
    echo "$ZIPFILE" > /target/etc/freeraid/pending-import; \
    cp /freeraid-firstboot-install.sh /target/usr/local/bin/freeraid-firstboot; \
    chmod +x /target/usr/local/bin/freeraid-firstboot; \
    cat > /target/etc/systemd/system/freeraid-firstboot.service <<'SVCEOF'
[Unit]
Description=FreeRAID First-Boot Setup
After=network-online.target
Wants=network-online.target
ConditionPathExists=/etc/freeraid/pending-import

[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid-firstboot
RemainAfterExit=yes
StandardOutput=journal+console

[Install]
WantedBy=multi-user.target
SVCEOF
    in-target systemctl enable freeraid-firstboot.service; \
    in-target bash -c 'echo "freeraid ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/freeraid'
PRESEED

info "Preseed written"

# ── Write first-boot setup script into initrd ─────────────────────────────────

cat > "$INITRD_WORK/freeraid-firstboot-install.sh" <<'FBEOF'
#!/usr/bin/env bash
# This script is embedded in the initrd and extracted to the installed system
# by the late_command above.

set -euo pipefail
LOG=/var/log/freeraid-firstboot.log
exec > >(tee -a "$LOG") 2>&1

echo "[$(date)] FreeRAID first-boot setup starting..."

# Wait for DNS
for i in $(seq 1 30); do
    host deb.debian.org &>/dev/null && break
    echo "Waiting for network... ($i/30)"
    sleep 2
done

# Run FreeRAID installer
echo "==> Downloading FreeRAID installer..."
curl -fsSL https://raw.githubusercontent.com/crucifix86/FreeRAID/main/scripts/install.sh \
    -o /tmp/freeraid-install.sh
bash /tmp/freeraid-install.sh

# Import Unraid config if one was found on the USB
PENDING=$(cat /etc/freeraid/pending-import 2>/dev/null || echo "")
if [ -n "$PENDING" ] && [ -f "$PENDING" ]; then
    echo "==> Importing Unraid backup: $PENDING"
    TMPDIR=$(mktemp -d /tmp/unraid-import-XXXXXX)
    unzip -q "$PENDING" -d "$TMPDIR" 2>/dev/null || true
    CONFDIR=$(find "$TMPDIR" -name "disk.cfg" -o -name "ident.cfg" 2>/dev/null \
              | head -1 | xargs dirname 2>/dev/null || echo "")
    if [ -z "$CONFDIR" ]; then
        CONFDIR=$(find "$TMPDIR" -type d -name "config" | head -1 || echo "")
    fi
    if [ -n "$CONFDIR" ] && [ -d "$CONFDIR" ]; then
        freeraid shares-import "$CONFDIR" && echo "==> Shares imported"
        # Copy compose files from docker templates
        if [ -d "$CONFDIR/plugins/dockerMan/templates-user" ]; then
            python3 /usr/local/bin/freeraid-import "$CONFDIR" \
                --out /boot/config/freeraid.conf.json 2>/dev/null || true
            echo "==> Docker templates processed"
        fi
    else
        echo "WARN: Could not find config/ directory in Unraid backup"
    fi
    rm -rf "$TMPDIR"
fi

# Show access info on console login screen
LOCAL_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || echo "unknown")
cat > /etc/issue <<ISSUE

  ███████╗██████╗ ███████╗███████╗██████╗  █████╗ ██╗██████╗
  ██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██║██╔══██╗
  █████╗  ██████╔╝█████╗  █████╗  ██████╔╝███████║██║██║  ██║
  ██╔══╝  ██╔══██╗██╔══╝  ██╔══╝  ██╔══██╗██╔══██║██║██║  ██║
  ██║     ██║  ██║███████╗███████╗██║  ██║██║  ██║██║██████╔╝
  ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═════╝

  Web UI  :  https://${LOCAL_IP}:9090
  Login   :  freeraid / freeraid

ISSUE

# Disable this service — won't run again
rm -f /etc/freeraid/pending-import
systemctl disable freeraid-firstboot.service
echo "[$(date)] FreeRAID first-boot setup complete."
FBEOF

chmod +x "$INITRD_WORK/freeraid-firstboot-install.sh"

# ── Repack initrd ─────────────────────────────────────────────────────────────

info "Repacking initrd with preseed embedded..."
cd "$INITRD_WORK"
find . | cpio -o --format=newc --quiet | gzip -9 > "$MNT/initrd.gz"
cd /

info "Initrd built ($(du -sh "$MNT/initrd.gz" | cut -f1))"

# ── Write syslinux.cfg ────────────────────────────────────────────────────────

cat > "$MNT/syslinux/syslinux.cfg" <<'SYSEOF'
default menu.c32
menu title FreeRAID Installer
prompt 0
timeout 50

label FreeRAID Install
  menu default
  kernel /vmlinuz
  append initrd=/initrd.gz auto=true priority=critical quiet

label FreeRAID Install (verbose)
  kernel /vmlinuz
  append initrd=/initrd.gz auto=true priority=critical

label Boot from local disk
  localboot 0x80
SYSEOF

# Root-level syslinux.cfg (for BIOS MBR boot)
cp "$MNT/syslinux/syslinux.cfg" "$MNT/syslinux.cfg"

info "syslinux.cfg written"

# ── Copy Unraid backup zip if provided ────────────────────────────────────────

if [ -n "$UNRAID_ZIP" ]; then
    if [ -f "$UNRAID_ZIP" ]; then
        mkdir -p "$MNT/config"
        cp "$UNRAID_ZIP" "$MNT/config/unraid-backup.zip"
        info "Unraid backup copied → config/unraid-backup.zip"
    else
        warn "Unraid backup not found: $UNRAID_ZIP — skipping"
    fi
else
    # Create empty config dir to match Unraid USB structure
    mkdir -p "$MNT/config"
fi

# ── Finalize ──────────────────────────────────────────────────────────────────

step "7/7" "Finalizing"

# Show what's on the USB
df -h "$MNT" | tail -1 | awk '{printf "  Used: %s / %s\n", $3, $2}'
echo ""
ls -lh "$MNT/"

umount "$MNT"
sync
trap - EXIT
rm -rf "$MNT" "$INITRD_WORK" /tmp/freeraid-initrd-orig.gz 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}FreeRAID USB ready!${NC}"
echo ""
echo "  Plug into your server and boot."
echo "  The installer will run automatically (~10 min, requires internet)."
echo ""
echo "  After install:"
echo "    Web UI  : https://<server-ip>:9090"
echo "    Login   : freeraid / freeraid"
echo ""
if [ -n "$UNRAID_ZIP" ] && [ -f "$UNRAID_ZIP" ]; then
    echo "  Your Unraid config will be imported automatically on first boot."
    echo ""
fi
