#!/usr/bin/env bash
# Build the FreeRAID GUI installer as a single-file standalone binary.
#
# Requires (one-time):
#   sudo apt install python3-tk python3-pip
#   pip install --user pyinstaller
#
# Output:
#   dist/freeraid-installer  (single-file binary, ~20 MB)
#
# The produced binary bundles create-usb.sh and the default config template.
# It does NOT bundle the OS image (vmlinuz/initrd.gz/rootfs.squashfs) — the
# user picks an image folder at runtime. Once the hosted download is live,
# this script will also embed a default image URL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

command -v pyinstaller >/dev/null 2>&1 || {
    echo "pyinstaller not found. Install with: pip install --user pyinstaller" >&2
    exit 1
}

cd "$REPO_DIR"

pyinstaller \
    --onefile \
    --name freeraid-installer \
    --add-data "scripts/create-usb.sh:." \
    --add-data "core/freeraid.conf.json:." \
    --noconfirm \
    --clean \
    scripts/installer.py

echo
echo "Built: $REPO_DIR/dist/freeraid-installer"
echo "Run as:  sudo ./dist/freeraid-installer"
