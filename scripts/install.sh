#!/usr/bin/env bash
# FreeRAID installer — run this on a fresh Debian 12 system
#
# Usage (as root, from repo directory):
#   sudo bash scripts/install.sh
#
# Or one-liner from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/crucifix86/FreeRAID/main/scripts/install.sh | bash

set -euo pipefail

# Locate repo — works whether run from clone or piped via curl | bash
_SELF="${BASH_SOURCE[0]:-}"
if [ -n "$_SELF" ] && [ -f "$_SELF" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$_SELF")" && pwd)"
    REPO_DIR="$(dirname "$SCRIPT_DIR")"
else
    # Being piped via stdin — clone the repo to /tmp/FreeRAID
    echo "==> Cloning FreeRAID repo to /tmp/FreeRAID..."
    apt-get install -y git -qq 2>/dev/null || true
    rm -rf /tmp/FreeRAID
    git clone --depth=1 https://github.com/crucifix86/FreeRAID /tmp/FreeRAID
    exec bash /tmp/FreeRAID/scripts/install.sh
fi

CONFIG_DIR="/boot/config"
INSTALL_DIR="/usr/local/lib/freeraid"
LOG_DIR="/var/log/freeraid"
COCKPIT_PLUGIN_DIR="/usr/share/cockpit/freeraid"
COCKPIT_BRANDING_DIR="/usr/share/cockpit/branding/default"

# Read version from repo
FREERAID_VERSION="$(cat "$REPO_DIR/VERSION" 2>/dev/null | tr -d '[:space:]' || echo '0.0.0')"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'; BOLD='\033[1m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
die()   { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}[$1]${NC} $2"; }

[ "$(id -u)" -eq 0 ] || die "Must run as root"

echo -e "${BOLD}"
echo "  ███████╗██████╗ ███████╗███████╗██████╗  █████╗ ██╗██████╗ "
echo "  ██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██║██╔══██╗"
echo "  █████╗  ██████╔╝█████╗  █████╗  ██████╔╝███████║██║██║  ██║"
echo "  ██╔══╝  ██╔══██╗██╔══╝  ██╔══╝  ██╔══██╗██╔══██║██║██║  ██║"
echo "  ██║     ██║  ██║███████╗███████╗██║  ██║██║  ██║██║██████╔╝"
echo "  ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═════╝ v${FREERAID_VERSION}"
echo -e "${NC}"
echo "  Open source NAS OS — no accounts, no subscriptions, no BS."
echo ""

# ── Step 1: Packages ──────────────────────────────────────────────────────────
step "1/7" "Installing packages"

# Detect architecture for arch-specific downloads
ARCH="$(dpkg --print-architecture)"   # amd64, arm64, armhf, etc.

apt-get update -qq

# Add backports repo (needed for zfsutils-linux on Bookworm)
if ! grep -r 'bookworm-backports' /etc/apt/sources.list /etc/apt/sources.list.d/ &>/dev/null; then
    info "Adding Debian Bookworm backports..."
    echo "deb http://deb.debian.org/debian bookworm-backports main contrib non-free" \
        > /etc/apt/sources.list.d/backports.list
    apt-get update -qq
fi

# mergerfs — download latest deb directly (not in Debian repos)
if ! command -v mergerfs &>/dev/null; then
    info "Installing mergerfs..."
    MERGERFS_VER="2.40.2"
    # Map dpkg arch to mergerfs release naming
    case "$ARCH" in
        amd64)  MERGERFS_ARCH="amd64" ;;
        arm64)  MERGERFS_ARCH="arm64" ;;
        armhf)  MERGERFS_ARCH="armhf" ;;
        *)      MERGERFS_ARCH="$ARCH" ;;
    esac
    MERGERFS_DEB="mergerfs_${MERGERFS_VER}.debian-bookworm_${MERGERFS_ARCH}.deb"
    MERGERFS_URL="https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VER}/${MERGERFS_DEB}"
    apt-get install -y fuse3 -qq
    wget -q --show-progress "$MERGERFS_URL" -O /tmp/mergerfs.deb \
        || { warn "mergerfs download failed — trying generic fuse-based fallback"; true; }
    [ -f /tmp/mergerfs.deb ] && dpkg -i /tmp/mergerfs.deb && rm /tmp/mergerfs.deb
    info "mergerfs installed."
fi

PACKAGES=(
    # Core storage
    snapraid
    xfsprogs
    btrfs-progs
    e2fsprogs
    fuse3
    # Sharing
    samba
    wsdd
    avahi-daemon
    nfs-kernel-server
    # Docker
    docker.io
    docker-compose-plugin
    # Web UI
    cockpit
    # Monitoring / SMART
    smartmontools
    hdparm
    # Notifications
    msmtp
    curl
    # UPS
    nut
    nut-client
    # Encryption
    gocryptfs
    # Virtualization
    qemu-kvm
    libvirt-daemon-system
    virtinst
    # Utilities
    jq
    python3
    unzip
    wget
    util-linux
)

apt-get install -y "${PACKAGES[@]}" 2>&1 | grep -E '(Setting up|already|Error|WARNING)' || true

# ZFS — from backports (kernel module may need a reboot to activate)
if ! command -v zpool &>/dev/null; then
    info "Installing ZFS from backports..."
    apt-get install -y -t bookworm-backports zfsutils-linux 2>&1 \
        | grep -E '(Setting up|already|Error|WARNING)' || true
fi

info "Packages installed."

# ── Step 2: FreeRAID CLI ──────────────────────────────────────────────────────
step "2/7" "Installing FreeRAID CLI"

mkdir -p "$INSTALL_DIR"

cp "$REPO_DIR/core/freeraid" "$INSTALL_DIR/freeraid"
chmod +x "$INSTALL_DIR/freeraid"
ln -sf "$INSTALL_DIR/freeraid" /usr/local/bin/freeraid

if [ -f "$REPO_DIR/importer/unraid-import.py" ]; then
    cp "$REPO_DIR/importer/unraid-import.py" "$INSTALL_DIR/unraid-import"
    chmod +x "$INSTALL_DIR/unraid-import"
    ln -sf "$INSTALL_DIR/unraid-import" /usr/local/bin/freeraid-import
fi

# Write version file
echo "$FREERAID_VERSION" > /etc/freeraid/VERSION 2>/dev/null || {
    mkdir -p /etc/freeraid
    echo "$FREERAID_VERSION" > /etc/freeraid/VERSION
}

info "CLI installed: $(freeraid version 2>/dev/null || echo v${FREERAID_VERSION})"

# ── Step 3: Config & directories ─────────────────────────────────────────────
step "3/7" "Setting up config and directories"

mkdir -p "$CONFIG_DIR"
mkdir -p "$LOG_DIR"
mkdir -p /etc/freeraid/compose
mkdir -p /etc/freeraid/plugins
mkdir -p /var/run/freeraid
mkdir -p /var/lib/freeraid/vms
mkdir -p /mnt/user
mkdir -p /mnt/user/isos
mkdir -p /mnt/zfs

# Default config — only write if not already present (preserve existing config on reinstall)
if [ ! -f "$CONFIG_DIR/freeraid.conf.json" ]; then
    cp "$REPO_DIR/core/freeraid.conf.json" "$CONFIG_DIR/freeraid.conf.json"
    info "Default config written to $CONFIG_DIR/freeraid.conf.json"
else
    warn "Config already exists at $CONFIG_DIR/freeraid.conf.json — not overwriting"
fi

# Seed sample compose files (skip existing user files)
if [ -d "$REPO_DIR/compose" ]; then
    for f in "$REPO_DIR/compose/"*.docker-compose.yml; do
        [ -f "$f" ] || continue
        dest="/etc/freeraid/compose/$(basename "$f")"
        [ -f "$dest" ] || cp "$f" "$dest"
    done
fi

info "Directories and config ready."

# ── Step 4: Systemd services ──────────────────────────────────────────────────
step "4/7" "Installing systemd services"

# Array start/stop
cat > /etc/systemd/system/freeraid-array.service <<'EOF'
[Unit]
Description=FreeRAID Array
After=network.target local-fs.target
DefaultDependencies=no

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/freeraid start
ExecStop=/usr/local/bin/freeraid stop
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF

# SnapRAID sync
cat > /etc/systemd/system/freeraid-sync.service <<'EOF'
[Unit]
Description=FreeRAID SnapRAID Sync
After=freeraid-array.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid sync
EOF

cat > /etc/systemd/system/freeraid-sync.timer <<'EOF'
[Unit]
Description=FreeRAID nightly SnapRAID sync

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# SnapRAID scrub
cat > /etc/systemd/system/freeraid-scrub.service <<'EOF'
[Unit]
Description=FreeRAID SnapRAID Weekly Scrub
After=freeraid-array.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid scrub
EOF

cat > /etc/systemd/system/freeraid-scrub.timer <<'EOF'
[Unit]
Description=FreeRAID weekly SnapRAID scrub

[Timer]
OnCalendar=Sun *-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Cache mover
cat > /etc/systemd/system/freeraid-mover.service <<'EOF'
[Unit]
Description=FreeRAID Cache Mover
After=freeraid-array.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid cache-move
EOF

cat > /etc/systemd/system/freeraid-mover.timer <<'EOF'
[Unit]
Description=FreeRAID nightly cache mover

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# Docker auto-update
cat > /etc/systemd/system/freeraid-docker-update.service <<'EOF'
[Unit]
Description=FreeRAID Docker Container Auto-Update
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid docker-update-all
EOF

cat > /etc/systemd/system/freeraid-docker-update.timer <<'EOF'
[Unit]
Description=FreeRAID nightly Docker container auto-update

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable freeraid-array.service
systemctl enable freeraid-sync.timer
systemctl enable freeraid-scrub.timer
systemctl enable freeraid-mover.timer
systemctl enable freeraid-docker-update.timer

# Enable libvirt for VM manager (start it now too if available)
if systemctl list-unit-files libvirtd.service &>/dev/null 2>&1 | grep -q libvirtd; then
    systemctl enable --now libvirtd 2>/dev/null || true
fi

info "Systemd services installed and enabled."

# ── Step 5: Web UI (Cockpit plugin + branding) ────────────────────────────────
step "5/7" "Installing web UI"

# Install cockpit plugin
mkdir -p "$COCKPIT_PLUGIN_DIR"
cp "$REPO_DIR/web/freeraid/"* "$COCKPIT_PLUGIN_DIR/"
chmod -R 644 "$COCKPIT_PLUGIN_DIR/"*

# Install branding (hides Cockpit chrome, custom login page)
mkdir -p "$COCKPIT_BRANDING_DIR"
cp "$REPO_DIR/web/branding.css"  "$COCKPIT_BRANDING_DIR/branding.css"
cp "$REPO_DIR/web/login.html"    "$COCKPIT_BRANDING_DIR/login.html"

info "Web UI installed at $COCKPIT_PLUGIN_DIR"

# ── Step 6: Cockpit configuration ─────────────────────────────────────────────
step "6/7" "Configuring Cockpit"

systemctl enable --now cockpit.socket

# Allow root login and ensure all sudo users keep their access
# Cockpit reinstall resets disallowed-users — fix it every time
mkdir -p /etc/cockpit
cat > /etc/cockpit/disallowed-users <<'EOF'
# List of users which are not allowed to login to Cockpit
# FreeRAID: all users with sudo access should be able to login
EOF
info "Cockpit login: all sudo users permitted."

# Ensure every user currently in the sudo group stays in sudo after reinstall
# (package reinstall can't change /etc/group, but just to be explicit)
for sudouser in $(getent group sudo | cut -d: -f4 | tr ',' ' '); do
    usermod -aG sudo "$sudouser" 2>/dev/null || true
done

# Set cockpit login password to match system root password by default
# (Nothing to do — Cockpit uses PAM, so root's system password works)

LOCAL_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || hostname -I | awk '{print $1}')
info "Cockpit ready at: https://${LOCAL_IP}:9090"

# ── Step 7: Check for Unraid USB ──────────────────────────────────────────────
step "7/7" "Checking for Unraid config to import"

UNRAID_FOUND=false
for dev in /dev/sd[a-z]; do
    [ -b "$dev" ] || continue
    LABEL=$(lsblk -no LABEL "${dev}1" 2>/dev/null || true)
    if echo "$LABEL" | grep -qi "unraid\|UNRAID"; then
        warn "Unraid USB detected: ${dev}1 (label: $LABEL)"
        echo "    Import your config with:"
        echo "      freeraid-import ${dev} --out $CONFIG_DIR/freeraid.conf.json"
        UNRAID_FOUND=true
    fi
done
$UNRAID_FOUND || info "No Unraid USB detected. Starting fresh."

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║   FreeRAID v${FREERAID_VERSION} installed successfully!             ║${NC}"
echo -e "${GREEN}${BOLD}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Web UI:   https://${LOCAL_IP}:9090"
echo "  Login:    root / (your root password)"
echo ""
echo "  The first-boot setup wizard will guide you through:"
echo "    • Hostname and network"
echo "    • Assigning drives to array, parity, cache"
echo "    • Optional Unraid config import"
echo "    • Starting the array"
echo ""
# Warn if ZFS kernel module not yet loaded (common on first install)
if ! lsmod | grep -q zfs 2>/dev/null; then
    warn "ZFS kernel module not loaded — a reboot may be required before creating ZFS pools."
fi
