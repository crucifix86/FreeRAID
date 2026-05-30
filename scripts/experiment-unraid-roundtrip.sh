#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# EXPERIMENTAL — not part of the normal build flow.
#
# Builds a FreeRAID USB pre-loaded with a config generated from a captured
# Unraid config directory, with --skip-parity so Unraid's parity disk is
# left untouched. Intended for a one-shot "does it boot?" test on real
# hardware; pop the Unraid USB back in afterwards and there should be no
# parity rebuild required.
#
# Expects:
#   - build/ artifacts already produced by scripts/build-image.sh
#   - A directory containing the Unraid /boot/config/ contents (tarball
#     extracted or rsynced — must have super.dat, share.cfg, pools/, etc.)
#
# Usage:
#   sudo bash scripts/experiment-unraid-roundtrip.sh \
#       /dev/sdX \
#       /path/to/unraid-config-dir \
#       "container1,container2,container3"
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

USB_DEV="${1:-}"
UNRAID_CFG="${2:-}"
RUNNING="${3:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
die()   { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

[[ -z "$USB_DEV" || -z "$UNRAID_CFG" ]] && {
    echo "Usage: sudo $0 /dev/sdX /path/to/unraid-config-dir \"running1,running2\""
    exit 1
}
[[ "$(id -u)" -eq 0 ]] || die "Run as root"
[[ -b "$USB_DEV" ]]    || die "Not a block device: $USB_DEV"
[[ -d "$UNRAID_CFG" ]] || die "Not a directory: $UNRAID_CFG"
[[ -f "$UNRAID_CFG/super.dat" ]] || die "No super.dat in $UNRAID_CFG — not an Unraid config"

echo -e "${BOLD}${YELLOW}"
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║  EXPERIMENTAL Unraid round-trip USB builder                  ║"
echo "  ║  --skip-parity is ON: Unraid parity disk stays untouched     ║"
echo "  ║  Array will run UNPROTECTED — do NOT write to it             ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

STAGE=$(mktemp -d /tmp/freeraid-experiment-XXXXXX)
trap "rm -rf '$STAGE'" EXIT

info "Generating freeraid.conf.json from $UNRAID_CFG (--skip-parity)"
python3 "$REPO_DIR/importer/unraid-import.py" \
    "$UNRAID_CFG" \
    --out "$STAGE/freeraid.conf.json" \
    --compose-dir "$STAGE/compose" \
    --skip-parity \
    ${RUNNING:+--only-running "$RUNNING"}

info "Writing USB via create-usb.sh"
bash "$SCRIPT_DIR/create-usb.sh" "$USB_DEV"

# Figure out the partition name (sdb1, nvme0n1p1, etc.)
if [[ "$USB_DEV" =~ (nvme|mmcblk) ]]; then
    PART="${USB_DEV}p1"
else
    PART="${USB_DEV}1"
fi

info "Re-mounting USB to inject pre-generated config"
MNT=$(mktemp -d /tmp/freeraid-inject-XXXXXX)
mount "$PART" "$MNT"

# Overwrite the default config the writer just dropped in
cp -v "$STAGE/freeraid.conf.json" "$MNT/config/freeraid.conf.json"

# Drop the compose files so first boot sees them
if [ -d "$STAGE/compose" ]; then
    mkdir -p "$MNT/config/compose"
    cp -v "$STAGE/compose/"*.yml "$MNT/config/compose/" 2>/dev/null || true
fi

# Mark this so freeraid-firstboot.service skips (we've already imported)
date -Iseconds > "$MNT/config/.unraid-imported"

sync
umount "$MNT"
rmdir "$MNT"

echo ""
echo -e "${GREEN}${BOLD}Experimental USB ready.${NC}"
echo ""
echo "  First boot will:"
echo "    • Mount cache (btrfs) and data disks (xfs) as-is — no reformat"
echo "    • NOT touch the Unraid parity disk"
echo "    • Bring up docker containers from baked compose files"
echo ""
echo "  To return to Unraid: swap the USB stick, power back on."
echo ""
