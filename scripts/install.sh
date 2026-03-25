#!/usr/bin/env bash
# FreeRAID installer — run this inside a fresh Debian 12 install
# Sets up all dependencies, installs freeraid CLI, and configures services.
#
# Usage (as root):
#   curl -fsSL https://raw.githubusercontent.com/yourname/freeraid/main/scripts/install.sh | bash
# OR copy this repo and run:
#   sudo bash /path/to/freeraid/scripts/install.sh

set -euo pipefail

FREERAID_VERSION="0.1.0"
INSTALL_DIR="/usr/local/lib/freeraid"
CONFIG_DIR="/boot/config"
LOG_DIR="/var/log/freeraid"

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

# ── Step 1: Packages ─────────────────────────────────────────────────────────────
step "1/6" "Installing packages"

apt-get update -qq

# Add mergerfs repo (latest build)
DEBIAN_CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
MERGERFS_DEB="mergerfs_2.40.2.debian-bookworm_amd64.deb"
MERGERFS_URL="https://github.com/trapexit/mergerfs/releases/download/2.40.2/${MERGERFS_DEB}"

if ! command -v mergerfs &>/dev/null; then
    info "Downloading mergerfs..."
    apt-get install -y fuse -qq
    cd /tmp
    wget -q --show-progress "$MERGERFS_URL" -O mergerfs.deb
    dpkg -i mergerfs.deb
    rm mergerfs.deb
fi

apt-get install -y \
    snapraid \
    jq \
    xfsprogs \
    btrfs-progs \
    e2fsprogs \
    samba \
    nfs-kernel-server \
    docker.io \
    docker-compose-plugin \
    cockpit \
    python3 \
    python3-pip \
    smartmontools \
    unzip \
    hdparm \
    lsblk \
    2>&1 | grep -E '(Setting up|already|Error|WARNING)' || true

info "Packages installed."

# ── Step 2: FreeRAID CLI ─────────────────────────────────────────────────────────
step "2/6" "Installing FreeRAID CLI"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/core/freeraid" "$INSTALL_DIR/freeraid"
chmod +x "$INSTALL_DIR/freeraid"
ln -sf "$INSTALL_DIR/freeraid" /usr/local/bin/freeraid

cp "$REPO_DIR/importer/unraid-import.py" "$INSTALL_DIR/unraid-import"
chmod +x "$INSTALL_DIR/unraid-import"
ln -sf "$INSTALL_DIR/unraid-import" /usr/local/bin/freeraid-import

info "CLI installed at /usr/local/bin/freeraid"

# ── Step 3: Config directory ─────────────────────────────────────────────────────
step "3/6" "Setting up config directory"

mkdir -p "$CONFIG_DIR"
mkdir -p "$LOG_DIR"
mkdir -p /etc/freeraid/compose

# Copy compose files (skip existing — these are user data)
if [ -d "$REPO_DIR/compose" ]; then
    for f in "$REPO_DIR/compose/"*.docker-compose.yml; do
        [ -f "$f" ] || continue
        dest="/etc/freeraid/compose/$(basename "$f")"
        [ -f "$dest" ] || cp "$f" "$dest"
    done
    info "Compose files staged in /etc/freeraid/compose/"
fi

if [ ! -f "$CONFIG_DIR/freeraid.conf.json" ]; then
    cp "$REPO_DIR/core/freeraid.conf.json" "$CONFIG_DIR/freeraid.conf.json"
    info "Default config written to $CONFIG_DIR/freeraid.conf.json"
else
    warn "Config already exists at $CONFIG_DIR/freeraid.conf.json — not overwriting"
fi

# ── Step 4: Systemd services ──────────────────────────────────────────────────────
step "4/6" "Installing systemd services"

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
Description=FreeRAID SnapRAID daily sync

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

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
Description=FreeRAID SnapRAID weekly scrub

[Timer]
OnCalendar=Sun *-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable freeraid-array.service
systemctl enable freeraid-sync.timer
systemctl enable freeraid-scrub.timer

info "Systemd services installed and enabled."

# ── Step 5: Cockpit ──────────────────────────────────────────────────────────────
step "5/6" "Configuring Cockpit web UI"

systemctl enable --now cockpit.socket

# Allow root login via cockpit for initial setup
if [ -f /etc/cockpit/disallowed-users ]; then
    sed -i '/^root$/d' /etc/cockpit/disallowed-users
fi

# Get local IP
LOCAL_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || echo "localhost")

info "Cockpit available at: https://${LOCAL_IP}:9090"

# ── Step 6: Check for Unraid USB ─────────────────────────────────────────────────
step "6/6" "Checking for Unraid config to import"

# Look for Unraid signature on other USB drives
UNRAID_FOUND=false
for dev in /dev/sd[a-z]; do
    [ -b "$dev" ] || continue
    LABEL=$(lsblk -no LABEL "${dev}1" 2>/dev/null || true)
    if echo "$LABEL" | grep -qi "unraid\|UNRAID"; then
        echo ""
        warn "Unraid USB detected: ${dev}1 (label: $LABEL)"
        echo "  Import your config with:"
        echo "    freeraid-import ${dev} --out $CONFIG_DIR/freeraid.conf.json"
        UNRAID_FOUND=true
    fi
done

if ! $UNRAID_FOUND; then
    info "No Unraid USB detected. Using default config."
fi

# ── Done ──────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}FreeRAID installed successfully!${NC}"
echo ""
echo "  Next steps:"
echo "    1. Edit your array config:   nano $CONFIG_DIR/freeraid.conf.json"
echo "    2. Start the array:          freeraid start"
echo "    3. Web UI:                   https://${LOCAL_IP}:9090"
echo ""
echo "  Or if migrating from Unraid:   freeraid-import /dev/sdX --out $CONFIG_DIR/freeraid.conf.json"
echo ""
