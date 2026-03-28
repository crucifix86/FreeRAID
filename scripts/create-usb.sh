#!/usr/bin/env bash
# FreeRAID USB Writer
# Writes the pre-built FreeRAID live image to a USB drive.
# Supports both UEFI (GRUB2) and legacy BIOS (syslinux) boot.
#
# Usage:
#   sudo bash scripts/create-usb.sh /dev/sdX
#   sudo bash scripts/create-usb.sh /dev/sdX /path/to/unraid-backup.zip
#
# Build the image first:
#   sudo bash scripts/build-image.sh
#
# Requires: grub-efi-amd64-bin syslinux dosfstools parted
#   apt-get install -y grub-efi-amd64-bin syslinux dosfstools parted

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

for tool in mkfs.vfat parted; do
    command -v "$tool" &>/dev/null || \
        die "Missing: $tool — run: apt-get install -y dosfstools parted"
done

# Check for GRUB EFI tools
HAVE_GRUB=false
if command -v grub-mkimage &>/dev/null && [ -d /usr/lib/grub/x86_64-efi ]; then
    HAVE_GRUB=true
fi

# Check for syslinux BIOS tools
HAVE_SYSLINUX=false
if command -v syslinux &>/dev/null && [ -f /usr/lib/syslinux/mbr/mbr.bin ]; then
    HAVE_SYSLINUX=true
fi

$HAVE_GRUB || $HAVE_SYSLINUX || \
    die "No bootloader tools found. Run: apt-get install -y grub-efi-amd64-bin syslinux dosfstools"

FREERAID_VER=$(cat "$REPO_DIR/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "?")
ROOTFS_SIZE=$(du -sh "$BUILD_DIR/rootfs.squashfs" | cut -f1)
USB_SIZE_BYTES=$(lsblk -bno SIZE "$USB_DEV" | head -1)
USB_SIZE_GB=$(( USB_SIZE_BYTES / 1024 / 1024 / 1024 ))

if [[ $USB_SIZE_GB -gt 256 ]]; then
    warn "$USB_DEV is ${USB_SIZE_GB}GB — are you sure this is a USB drive?"
    read -rp "Type YES to continue: " ans
    [[ "$ans" == "YES" ]] || { echo "Aborted."; exit 1; }
fi

echo ""
echo -e "${BOLD}FreeRAID USB Writer v${FREERAID_VER}${NC}"
echo ""
echo -e "  Target device  : ${BOLD}${USB_DEV}${NC} (${USB_SIZE_GB}GB)"
echo -e "  OS image       : ${ROOTFS_SIZE}"
echo -e "  Unraid backup  : ${UNRAID_ZIP:-none}"
echo -e "  UEFI boot      : $( $HAVE_GRUB && echo 'GRUB2 EFI' || echo 'not available' )"
echo -e "  BIOS boot      : $( $HAVE_SYSLINUX && echo 'syslinux MBR' || echo 'not available' )"
echo ""
echo -e "${RED}  !! ALL DATA ON $USB_DEV WILL BE ERASED !!${NC}"
echo ""
read -rp "  Type YES to write the FreeRAID USB: " confirm
[[ "$confirm" == "YES" ]] || { echo "Aborted."; exit 1; }

# ── Unmount ───────────────────────────────────────────────────────────────────

step "1/5" "Unmounting $USB_DEV"
for part in "${USB_DEV}"*[0-9]; do
    umount "$part" 2>/dev/null && info "Unmounted $part" || true
done
sleep 1

# ── Partition ─────────────────────────────────────────────────────────────────

step "2/5" "Partitioning (FAT32, MBR, bootable)"

# Single FAT32 partition — works for both BIOS and UEFI
parted -s "$USB_DEV" mklabel msdos
parted -s "$USB_DEV" mkpart primary fat32 1MiB 100%
parted -s "$USB_DEV" set 1 boot on

# Figure out partition name (sdb→sdb1, nvme0n1→nvme0n1p1, mmcblk0→mmcblk0p1)
if [[ "$USB_DEV" =~ (nvme|mmcblk) ]]; then
    PART="${USB_DEV}p1"
else
    PART="${USB_DEV}1"
fi

sleep 1
partprobe "$USB_DEV" 2>/dev/null || true
sleep 1

mkfs.vfat -F 32 -n "$LABEL" "$PART"
info "Partition: $PART (FAT32, label: $LABEL)"

# ── Mount USB ─────────────────────────────────────────────────────────────────

MNT=$(mktemp -d /tmp/freeraid-usb-XXXXXX)
trap "umount '$MNT' 2>/dev/null || true; rmdir '$MNT' 2>/dev/null || true" EXIT
mount "$PART" "$MNT"

# ── Bootloader ────────────────────────────────────────────────────────────────

step "3/5" "Installing bootloaders"

# ── GRUB2 EFI (works on all modern UEFI systems including mini PCs) ──────────
if $HAVE_GRUB; then
    mkdir -p "$MNT/EFI/BOOT"

    # Embed a minimal config that searches for the FREERAID label at boot.
    # This means GRUB finds the USB regardless of which disk slot it's in.
    local GRUB_EMBED
    GRUB_EMBED=$(mktemp /tmp/grub-embed-XXXXXX.cfg)
    cat > "$GRUB_EMBED" <<'EMBEDEOF'
search --no-floppy --label --set=root FREERAID
set prefix=($root)/EFI/BOOT
configfile ($root)/EFI/BOOT/grub.cfg
EMBEDEOF

    # Build standalone GRUB EFI image with all needed modules embedded.
    # --prefix is overridden by the embedded config's set prefix= line.
    grub-mkimage \
        --format=x86_64-efi \
        --output="$MNT/EFI/BOOT/BOOTX64.EFI" \
        --config="$GRUB_EMBED" \
        --prefix='/EFI/BOOT' \
        boot linux normal configfile \
        part_msdos part_gpt fat \
        echo ls cat search search_label \
        2>/dev/null || warn "grub-mkimage failed — EFI boot may not work"
    rm -f "$GRUB_EMBED"

    cat > "$MNT/EFI/BOOT/grub.cfg" <<GRUBEOF
set default=0
set timeout=5
set gfxpayload=keep

# Find the FREERAID partition by label regardless of disk order
search --no-floppy --label --set=root FREERAID

menuentry "FreeRAID v${FREERAID_VER}" {
    search --no-floppy --label --set=root FREERAID
    linux  (\$root)/vmlinuz quiet loglevel=3
    initrd (\$root)/initrd.gz
}

menuentry "FreeRAID v${FREERAID_VER} (verbose)" {
    search --no-floppy --label --set=root FREERAID
    linux  (\$root)/vmlinuz loglevel=7
    initrd (\$root)/initrd.gz
}

menuentry "Boot from local disk" {
    exit
}
GRUBEOF

    info "GRUB2 EFI bootloader installed → EFI/BOOT/BOOTX64.EFI"
else
    warn "grub-efi-amd64-bin not found — UEFI boot unavailable"
    warn "Install with: apt-get install -y grub-efi-amd64-bin"
fi

# ── Syslinux (BIOS/legacy MBR fallback) ──────────────────────────────────────
if $HAVE_SYSLINUX; then
    dd if=/usr/lib/syslinux/mbr/mbr.bin of="$USB_DEV" bs=440 count=1 conv=notrunc 2>/dev/null
    syslinux --install "$PART" 2>/dev/null || true

    mkdir -p "$MNT/syslinux"
    BIOS_MODS="/usr/lib/syslinux/modules/bios"
    for f in menu.c32 libutil.c32 libcom32.c32; do
        [ -f "$BIOS_MODS/$f" ] && cp "$BIOS_MODS/$f" "$MNT/syslinux/" || true
    done

    cat > "$MNT/syslinux/syslinux.cfg" <<SYSEOF
default menu.c32
menu title FreeRAID v${FREERAID_VER}
prompt 0
timeout 50

label freeraid
  menu label FreeRAID v${FREERAID_VER}
  menu default
  kernel /vmlinuz
  append initrd=/initrd.gz quiet loglevel=3

label freeraid-verbose
  menu label FreeRAID v${FREERAID_VER} (verbose boot)
  kernel /vmlinuz
  append initrd=/initrd.gz loglevel=7

label local
  menu label Boot from local disk
  localboot 0x80
SYSEOF

    # syslinux also looks for config at root
    cp "$MNT/syslinux/syslinux.cfg" "$MNT/syslinux.cfg"
    info "Syslinux BIOS MBR installed"
else
    warn "syslinux not found — legacy BIOS boot unavailable (UEFI only)"
fi

# ── Copy live image ───────────────────────────────────────────────────────────

step "4/5" "Copying live image to USB"

info "vmlinuz..."
cp "$BUILD_DIR/vmlinuz" "$MNT/vmlinuz"

info "initrd.gz ($(du -sh "$BUILD_DIR/initrd.gz" | cut -f1))..."
cp "$BUILD_DIR/initrd.gz" "$MNT/initrd.gz"

info "rootfs.squashfs ($(du -sh "$BUILD_DIR/rootfs.squashfs" | cut -f1)) — please wait..."
cp "$BUILD_DIR/rootfs.squashfs" "$MNT/rootfs.squashfs"

# ── Config directory ──────────────────────────────────────────────────────────

step "5/5" "Setting up persistent config directory"

mkdir -p "$MNT/config"

if [ -n "$UNRAID_ZIP" ] && [ -f "$UNRAID_ZIP" ]; then
    cp "$UNRAID_ZIP" "$MNT/config/unraid-backup.zip"
    info "Unraid backup → config/unraid-backup.zip (will import on first boot)"
fi

# Write default config if none present
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
echo "  No installation needed — boots directly into FreeRAID."
echo ""
echo "  Web UI: https://<server-ip>:9090"
echo "  Login:  root / freeraid  (change password after first login)"
echo ""
echo "  Config persists to USB: config/ directory on this drive."
echo "  Array data stays on your data drives."
echo ""
if $HAVE_GRUB; then
    echo "  UEFI boot: GRUB2 EFI (recommended for modern hardware)"
fi
if $HAVE_SYSLINUX; then
    echo "  BIOS boot: syslinux MBR (legacy/older hardware)"
fi
echo ""
