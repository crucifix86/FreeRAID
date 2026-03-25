#!/usr/bin/env bash
# FreeRAID USB Writer
# Writes the pre-built FreeRAID live image to a USB drive.
# The USB boots FreeRAID directly — no installation, no screen needed.
#
# Usage:
#   sudo bash scripts/create-usb.sh /dev/sdX
#   sudo bash scripts/create-usb.sh /dev/sdX /path/to/unraid-backup.zip
#
# Build the image first:
#   sudo bash scripts/build-image.sh
#
# Requires: syslinux dosfstools parted

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$REPO_DIR/build"

USB_DEV="${1:-}"
UNRAID_ZIP="${2:-}"
LABEL="FREERAID"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
die()   { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}[$1]${NC} $2"; }

# ── Preflight ─────────────────────────────────────────────────────────────────

[[ -z "$USB_DEV" ]] && { echo "Usage: sudo $0 /dev/sdX [unraid-backup.zip]"; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die "Run as root: sudo $0 $*"
[[ -b "$USB_DEV" ]] || die "Not a block device: $USB_DEV"

for f in vmlinuz initrd.gz rootfs.squashfs; do
    [ -f "$BUILD_DIR/$f" ] || die "Missing $BUILD_DIR/$f — run: sudo bash scripts/build-image.sh"
done

for tool in syslinux mkfs.vfat parted; do
    command -v "$tool" &>/dev/null || \
        die "Missing: $tool — run: apt-get install -y syslinux dosfstools parted"
done

ROOTFS_SIZE=$(du -sh "$BUILD_DIR/rootfs.squashfs" | cut -f1)
USB_SIZE_BYTES=$(lsblk -bno SIZE "$USB_DEV" | head -1)
USB_SIZE_GB=$(( USB_SIZE_BYTES / 1024 / 1024 / 1024 ))

if [[ $USB_SIZE_GB -gt 256 ]]; then
    warn "$USB_DEV is ${USB_SIZE_GB}GB — are you sure this is a USB drive?"
    read -rp "Type YES to continue: " ans
    [[ "$ans" == "YES" ]] || { echo "Aborted."; exit 1; }
fi

echo ""
echo -e "${BOLD}FreeRAID USB Writer${NC}"
echo -e "  Target device  : ${BOLD}$USB_DEV${NC} (${USB_SIZE_GB}GB)"
echo -e "  OS image       : $ROOTFS_SIZE"
echo -e "  Unraid backup  : ${UNRAID_ZIP:-none}"
echo ""
echo -e "${RED}  !! ALL DATA ON $USB_DEV WILL BE ERASED !!${NC}"
echo ""
read -rp "  Type YES to write the FreeRAID USB: " confirm
[[ "$confirm" == "YES" ]] || { echo "Aborted."; exit 1; }

# ── Unmount ───────────────────────────────────────────────────────────────────

step "1/5" "Unmounting $USB_DEV"
for part in "${USB_DEV}"*[0-9]; do
    if mountpoint -q "$part" 2>/dev/null || mount | grep -q "^${part} "; then
        umount "$part" && info "Unmounted $part"
    fi
done

# ── Partition ─────────────────────────────────────────────────────────────────

step "2/5" "Partitioning (FAT32, MBR, bootable)"

parted -s "$USB_DEV" mklabel msdos
parted -s "$USB_DEV" mkpart primary fat32 1MiB 100%
parted -s "$USB_DEV" set 1 boot on

if [[ "$USB_DEV" =~ [0-9]$ ]]; then PART="${USB_DEV}p1"
else PART="${USB_DEV}1"; fi

sleep 1; partprobe "$USB_DEV" 2>/dev/null || true; sleep 1
mkfs.vfat -F 32 -n "$LABEL" "$PART"
info "Partition: $PART (FAT32, label: $LABEL)"

# ── Bootloader ────────────────────────────────────────────────────────────────

step "3/5" "Installing syslinux (BIOS + EFI)"

dd if=/usr/lib/syslinux/mbr/mbr.bin of="$USB_DEV" bs=440 count=1 conv=notrunc 2>/dev/null
syslinux --install "$PART"
info "Syslinux BIOS MBR installed"

MNT=$(mktemp -d /tmp/freeraid-usb-XXXXXX)
trap "umount '$MNT' 2>/dev/null || true; rmdir '$MNT' 2>/dev/null || true" EXIT
mount "$PART" "$MNT"

mkdir -p "$MNT/syslinux" "$MNT/EFI/boot"

BIOS_MODS="/usr/lib/syslinux/modules/bios"
EFI64_MODS="/usr/lib/syslinux/modules/efi64"

for f in menu.c32 libutil.c32 libcom32.c32 mboot.c32; do
    [ -f "$BIOS_MODS/$f"  ] && cp "$BIOS_MODS/$f"  "$MNT/syslinux/"
    [ -f "$EFI64_MODS/$f" ] && cp "$EFI64_MODS/$f" "$MNT/EFI/boot/"
done
cp /usr/lib/syslinux/mbr/mbr.bin "$MNT/syslinux/"

# EFI bootloader — ldlinux.e64 IS the syslinux EFI application
if [ -f "$EFI64_MODS/ldlinux.e64" ]; then
    cp "$EFI64_MODS/ldlinux.e64" "$MNT/EFI/boot/bootx64.efi"
    cp "$EFI64_MODS/ldlinux.e64" "$MNT/EFI/boot/ldlinux.e64"
    info "Syslinux EFI bootloader installed"
fi

# EFI syslinux.cfg
cat > "$MNT/EFI/boot/syslinux.cfg" <<'EOF'
include /syslinux/syslinux.cfg
EOF

# Main syslinux menu — mirrors Unraid's structure
FREERAID_VER=$(cat "$REPO_DIR/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "?")
cat > "$MNT/syslinux/syslinux.cfg" <<SYSEOF
default menu.c32
menu title FreeRAID v${FREERAID_VER}
prompt 0
timeout 50

label FreeRAID OS
  menu default
  kernel /vmlinuz
  append initrd=/initrd.gz

label FreeRAID OS (verbose boot)
  kernel /vmlinuz
  append initrd=/initrd.gz loglevel=7

label Boot from local disk
  localboot 0x80
SYSEOF

cp "$MNT/syslinux/syslinux.cfg" "$MNT/syslinux.cfg"
info "syslinux.cfg written"

# ── Copy live image ───────────────────────────────────────────────────────────

step "4/5" "Copying live image"

info "vmlinuz..."
cp "$BUILD_DIR/vmlinuz"  "$MNT/vmlinuz"

info "initrd.gz ($(du -sh "$BUILD_DIR/initrd.gz" | cut -f1))..."
cp "$BUILD_DIR/initrd.gz" "$MNT/initrd.gz"

info "rootfs.squashfs ($(du -sh "$BUILD_DIR/rootfs.squashfs" | cut -f1)) — this takes a moment..."
cp "$BUILD_DIR/rootfs.squashfs" "$MNT/rootfs.squashfs"

# ── Config directory (persistent, like Unraid) ────────────────────────────────

step "5/5" "Setting up config directory"

mkdir -p "$MNT/config"

if [ -n "$UNRAID_ZIP" ] && [ -f "$UNRAID_ZIP" ]; then
    cp "$UNRAID_ZIP" "$MNT/config/unraid-backup.zip"
    info "Unraid backup copied → config/unraid-backup.zip"
    info "FreeRAID will import your shares and Docker apps on first boot"
fi

# Write a default FreeRAID config if none exists
if [ ! -f "$MNT/config/freeraid.conf.json" ]; then
    cp "$REPO_DIR/core/freeraid.conf.json" "$MNT/config/freeraid.conf.json"
    info "Default config written to config/freeraid.conf.json"
fi

# ── Finalize ──────────────────────────────────────────────────────────────────

sync
df -h "$MNT" | tail -1 | awk '{printf "\n  USB used: %s of %s\n", $3, $2}'
umount "$MNT"
trap - EXIT
rmdir "$MNT" 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}FreeRAID USB ready!${NC}"
echo ""
echo "  Plug into your server and power on."
echo "  No installation — boots directly into FreeRAID."
echo "  BIOS and UEFI servers both supported."
echo ""
echo "  Access the web UI from any browser:"
echo "    https://<server-ip>:9090"
echo "    Login: freeraid / freeraid"
echo ""
if [ -n "$UNRAID_ZIP" ] && [ -f "$UNRAID_ZIP" ]; then
    echo "  Your Unraid config will be imported automatically on first boot."
    echo ""
fi
echo "  Config persists to USB: config/ on this drive"
echo "  Array data stays on your data drives"
echo ""
