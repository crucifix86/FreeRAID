#!/usr/bin/env bash
# FreeRAID USB Hot-Update
# Replaces vmlinuz / initrd.gz / live/filesystem.squashfs on an existing
# FREERAID USB without touching the partition table, bootloader, or the
# /config persistence dir. Ships uncommitted-but-built changes to a running
# install with one cycle instead of a full re-burn (#22).
#
# Workflow:
#   sudo bash scripts/build-image.sh           # produce fresh build/ artifacts
#   sudo bash scripts/update-running-usb.sh /dev/sdX
#   # unplug, plug into FreeRAID box, reboot — changes live
#
# DO NOT run this against the USB you booted *this* host from. The USB must
# be the FreeRAID install media for the *target* machine (e.g. POUGHKEEPSIE),
# not the build host's own boot device.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="${FREERAID_BUILD_DIR:-$REPO_DIR/build}"
LABEL="FREERAID"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
die()   { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

USB_DEV="${1:-}"
[ -z "$USB_DEV" ] && { echo "Usage: sudo $0 /dev/sdX"; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Run as root: sudo $0 $*"
[ -b "$USB_DEV" ]    || die "Not a block device: $USB_DEV"

for f in vmlinuz initrd.gz rootfs.squashfs; do
    [ -f "$BUILD_DIR/$f" ] || die "Missing $BUILD_DIR/$f — run: sudo bash scripts/build-image.sh first"
done

# Find the FREERAID partition. create-usb.sh always lays out partition 1 as
# FAT32 labelled FREERAID; bail if we can't find it (probably wrong device).
PART="${USB_DEV}1"
[ -b "$PART" ] || PART="${USB_DEV}p1"   # /dev/nvme0n1p1 style
[ -b "$PART" ] || die "No partition 1 on $USB_DEV — is this actually a FreeRAID USB?"

ACTUAL_LABEL=$(blkid -o value -s LABEL "$PART" 2>/dev/null || true)
[ "$ACTUAL_LABEL" = "$LABEL" ] || die "Partition label is '$ACTUAL_LABEL', expected '$LABEL'. Refusing to write to a USB that wasn't created by create-usb.sh."

# Refuse to write to the USB this host booted from. Crude but catches the
# foot-gun: if /boot or / lives on USB_DEV, abort.
for mnt in / /boot /run/initramfs; do
    src=$(findmnt -n -o SOURCE "$mnt" 2>/dev/null | head -1 || true)
    [ -z "$src" ] && continue
    case "$src" in
        "$USB_DEV"*|"$PART"*) die "$mnt is on $src — won't overwrite the host's own boot media. Run from a different machine.";;
    esac
done

MNT=$(mktemp -d /tmp/freeraid-hotupdate-XXXXXX)
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT

info "Mounting $PART → $MNT"
mount "$PART" "$MNT"

# Sanity: the partition we're about to write to should look like a FreeRAID
# install (has live/ and config/). If not, this is probably a freshly-created
# blank USB that needs create-usb.sh instead.
[ -d "$MNT/live" ] && [ -d "$MNT/config" ] || \
    die "Partition doesn't look like a FreeRAID install (missing live/ or config/). Use create-usb.sh for a fresh USB."

# Backup current artifacts in case the new ones are bad (one-deep rotation).
for f in vmlinuz initrd.gz live/filesystem.squashfs; do
    if [ -f "$MNT/$f" ]; then
        cp -a "$MNT/$f" "$MNT/$f.prev"
    fi
done

info "Updating vmlinuz ($(du -sh "$BUILD_DIR/vmlinuz" | cut -f1))..."
cp "$BUILD_DIR/vmlinuz" "$MNT/vmlinuz"

info "Updating initrd.gz ($(du -sh "$BUILD_DIR/initrd.gz" | cut -f1))..."
cp "$BUILD_DIR/initrd.gz" "$MNT/initrd.gz"

info "Updating live/filesystem.squashfs ($(du -sh "$BUILD_DIR/rootfs.squashfs" | cut -f1))..."
cp "$BUILD_DIR/rootfs.squashfs" "$MNT/live/filesystem.squashfs"

sync

# Show what's preserved so the user can sanity-check config wasn't touched.
echo ""
info "Preserved (untouched):"
ls -la "$MNT/config/" 2>/dev/null | head -10
echo ""

info "Update complete. Unplug, move to target machine, reboot."
info "Rollback: rename *.prev files back if the new image fails to boot."
