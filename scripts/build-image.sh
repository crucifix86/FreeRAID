#!/usr/bin/env bash
# FreeRAID Live Image Builder
# Builds a bootable live OS image that runs entirely from USB in RAM.
# Output goes to build/ — then use create-usb.sh to write to a USB drive.
#
# Usage: sudo bash scripts/build-image.sh
#
# Requires: debootstrap squashfs-tools busybox-static
#   apt-get install -y debootstrap squashfs-tools busybox-static

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$REPO_DIR/build"
ROOTFS="$BUILD_DIR/rootfs"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $*"; }
die()   { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
step()  { echo -e "\n${BOLD}[$1]${NC} $2"; }

[[ "$(id -u)" -eq 0 ]] || die "Run as root: sudo $0"

for tool in debootstrap mksquashfs cpio gzip; do
    command -v "$tool" &>/dev/null || \
        die "Missing: $tool — run: apt-get install -y debootstrap squashfs-tools busybox-static"
done

FREERAID_VERSION=$(cat "$REPO_DIR/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "0.0.0")

echo -e "${BOLD}"
echo "  ███████╗██████╗ ███████╗███████╗██████╗  █████╗ ██╗██████╗ "
echo "  ██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██║██╔══██╗"
echo "  █████╗  ██████╔╝█████╗  █████╗  ██████╔╝███████║██║██║  ██║"
echo "  ██╔══╝  ██╔══██╗██╔══╝  ██╔══╝  ██╔══██╗██╔══██║██║██║  ██║"
echo "  ██║     ██║  ██║███████╗███████╗██║  ██║██║  ██║██║██████╔╝"
echo "  ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═════╝ v${FREERAID_VERSION}"
echo -e "${NC}  Live Image Builder"
echo ""

mkdir -p "$BUILD_DIR"

# ── Cleanup on error ──────────────────────────────────────────────────────────

cleanup() {
    for m in proc sys dev/pts dev run; do
        umount -lf "$ROOTFS/$m" 2>/dev/null || true
    done
}
trap cleanup EXIT

# ── Step 1: Debootstrap minimal Debian 12 ────────────────────────────────────

step "1/6" "Bootstrapping Debian 12 (bookworm) minimal rootfs"

# Default: always start from a fresh debootstrap. Stale rootfs trees silently
# lose files like /etc/shadow, /root, and /etc/ssh host keys, which produces a
# broken squashfs that kernel-panics at init. Opt in to reuse with
# FREERAID_REUSE_ROOTFS=1 only when you know the tree is clean.
if [ -d "$ROOTFS/usr" ] && [ "${FREERAID_REUSE_ROOTFS:-0}" = "1" ]; then
    warn "FREERAID_REUSE_ROOTFS=1 set — reusing existing $ROOTFS (skipping debootstrap)"
else
    if [ -d "$ROOTFS/usr" ]; then
        info "Removing stale $ROOTFS (set FREERAID_REUSE_ROOTFS=1 to keep)"
        # Unmount anything still bound in the old tree before rm, or we'll
        # trash the host.
        for m in proc sys dev/pts dev run; do
            umount -lf "$ROOTFS/$m" 2>/dev/null || true
        done
        rm -rf "$ROOTFS"
    fi
    # Minimal include — just enough to boot and run apt in chroot.
    # Everything else installed via apt-get in step 2 (proper dep resolution).
    debootstrap \
        --arch=amd64 \
        --include=systemd,systemd-sysv,udev,kmod,dbus,\
iproute2,curl,wget,ca-certificates,openssh-server,sudo,\
linux-image-amd64,busybox,initramfs-tools \
        bookworm \
        "$ROOTFS" \
        http://deb.debian.org/debian
    info "Base rootfs created"
fi

# ── Bind mounts for chroot ────────────────────────────────────────────────────

mount --bind /proc    "$ROOTFS/proc"
mount --bind /sys     "$ROOTFS/sys"
mount --bind /dev     "$ROOTFS/dev"
mount --bind /dev/pts "$ROOTFS/dev/pts"
mount -t tmpfs tmpfs  "$ROOTFS/run"

# ── Step 2: Install packages inside rootfs ───────────────────────────────────

step "2/6" "Installing packages inside rootfs"

# resolv.conf may be a symlink in chroot (systemd-resolved) — remove and copy real file
rm -f "$ROOTFS/etc/resolv.conf"
cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf" 2>/dev/null || \
    echo "nameserver 8.8.8.8" > "$ROOTFS/etc/resolv.conf"

chroot "$ROOTFS" bash -s <<'CHROOT'
export DEBIAN_FRONTEND=noninteractive
# Host PATH carries into chroot and may lack /usr/sbin; force the Debian default
# so chpasswd, smbpasswd, systemctl, etc. resolve.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Enable contrib + non-free-firmware for NIC firmware
sed -i 's|^deb http://deb.debian.org/debian bookworm main$|deb http://deb.debian.org/debian bookworm main contrib non-free-firmware|' /etc/apt/sources.list

# Add backports (for ZFS)
echo "deb http://deb.debian.org/debian bookworm-backports main contrib non-free" \
    > /etc/apt/sources.list.d/backports.list

apt-get update -qq

# Core utilities and storage
apt-get install -y -qq \
    jq python3 unzip parted util-linux \
    xfsprogs btrfs-progs e2fsprogs fuse3 \
    hdparm smartmontools snapraid \
    iputils-ping dnsutils

# Sharing
apt-get install -y -qq \
    samba smbclient wsdd avahi-daemon nfs-kernel-server

# Notifications + UPS
apt-get install -y -qq msmtp nut nut-client

# Encryption
apt-get install -y -qq gocryptfs

# NIC firmware (Intel, Realtek, Broadcom, etc.)
apt-get install -y -qq firmware-linux firmware-realtek firmware-iwlwifi \
    firmware-bnx2 firmware-atheros 2>/dev/null || true

# MergerFS — detect arch and download correct deb
ARCH=$(dpkg --print-architecture)
MERGERFS_VER="2.40.2"
case "$ARCH" in
    amd64) MERGERFS_ARCH="amd64" ;;
    arm64) MERGERFS_ARCH="arm64" ;;
    armhf) MERGERFS_ARCH="armhf" ;;
    *)     MERGERFS_ARCH="$ARCH" ;;
esac
if ! command -v mergerfs &>/dev/null; then
    MERGERFS_DEB="mergerfs_${MERGERFS_VER}.debian-bookworm_${MERGERFS_ARCH}.deb"
    MERGERFS_URL="https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VER}/${MERGERFS_DEB}"
    curl -fsSL "$MERGERFS_URL" -o /tmp/mergerfs.deb \
        && dpkg -i /tmp/mergerfs.deb \
        && rm /tmp/mergerfs.deb \
        || echo "WARN: mergerfs download failed — install manually after boot"
fi

# ZFS from backports
apt-get install -y -t bookworm-backports zfsutils-linux 2>/dev/null || \
    echo "WARN: ZFS install failed — may need reboot for kernel modules"

# NonRAID — Unraid-compatible realtime parity (qvr/nonraid).
# Builds md-nonraid + nonraid6_pq as out-of-tree modules. Coexists with stock
# md/raid6_pq. nmdctl reads Unraid's super.dat directly:
#   cp /boot/config/super.dat /nonraid.dat
#   nmdctl import   # validates without committing
#   nmdctl start    # commits
#
# Build directly with `make modules` against the target kernel headers rather
# than the upstream .deb path — the upstream debian/* has a version mismatch
# (deb 1.0.0-1 vs dkms.conf PACKAGE_VERSION=1.3.2) that makes dpkg install
# fail, and tools/debian/rules dh_installsystemd reports a missing-unit error
# during build. Direct build sidesteps both bugs.
if ! command -v nmdctl &>/dev/null; then
    apt-get install -y -qq build-essential git
    NRBUILD=$(mktemp -d -t nonraid-XXXXXX)
    if git clone --depth 1 -b main \
        https://github.com/qvr/nonraid.git "$NRBUILD/nonraid" 2>&1 | tail -3; then
        KVER=$(ls /lib/modules/ 2>/dev/null | sort -V | tail -1)
        if [ -n "$KVER" ] && [ -d "/lib/modules/$KVER/build" ]; then
            (cd "$NRBUILD/nonraid" && \
                make -C "/lib/modules/$KVER/build" M=$(pwd) modules CONFIG_UBSAN=n 2>&1 | tail -5)
            if [ -f "$NRBUILD/nonraid/md_nonraid/md-nonraid.ko" ] && \
               [ -f "$NRBUILD/nonraid/raid6/nonraid6_pq.ko" ]; then
                DEST="/lib/modules/$KVER/extra/nonraid"
                mkdir -p "$DEST"
                cp "$NRBUILD/nonraid/md_nonraid/md-nonraid.ko" "$DEST/"
                cp "$NRBUILD/nonraid/raid6/nonraid6_pq.ko" "$DEST/"
                depmod -a "$KVER"
                # nmdctl CLI + systemd units + udev rules verbatim from tools/
                cp "$NRBUILD/nonraid/tools/nmdctl" /usr/bin/nmdctl
                chmod +x /usr/bin/nmdctl
                [ -d "$NRBUILD/nonraid/tools/systemd" ] && \
                    cp "$NRBUILD/nonraid/tools/systemd"/*.service \
                       "$NRBUILD/nonraid/tools/systemd"/*.timer \
                       /etc/systemd/system/ 2>/dev/null || true
                [ -f "$NRBUILD/nonraid/tools/systemd/nonraid.default" ] && \
                    cp "$NRBUILD/nonraid/tools/systemd/nonraid.default" /etc/default/nonraid
                [ -d "$NRBUILD/nonraid/tools/udev" ] && \
                    cp "$NRBUILD/nonraid/tools/udev"/*.rules /etc/udev/rules.d/ 2>/dev/null || true
                echo "FreeRAID: NonRAID installed (kernel $KVER, nmdctl + modules + units)"
            else
                echo "WARN: NonRAID module build did not produce expected .ko files"
            fi
        else
            echo "WARN: NonRAID skipped — no kernel headers found"
        fi
    else
        echo "WARN: NonRAID clone failed — realtime parity unavailable"
    fi
    rm -rf "$NRBUILD"
fi

# Docker
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
fi
apt-get install -y -qq docker-compose-plugin 2>/dev/null || true

# Cockpit
apt-get install -y -qq cockpit 2>/dev/null || true

# Cockpit's `cockpit-networkmanager` recommends pull NetworkManager + ifupdown
# into the image. That gives us THREE managers fighting for the interface
# (systemd-networkd vs NetworkManager vs ifupdown's networking.service), so any
# static IP we apply via networkd gets reverted as soon as NM brings its own
# DHCP up. FreeRAID has its own Network UI — we don't need Cockpit's NM tab.
# Purge the NM stack and mask its services so systemd-networkd is the sole
# owner of network configuration.
apt-get purge -y -qq cockpit-networkmanager network-manager modemmanager \
    ifupdown 2>/dev/null || true
apt-get autoremove -y -qq 2>/dev/null || true
systemctl mask NetworkManager.service NetworkManager-wait-online.service \
    NetworkManager-dispatcher.service networking.service 2>/dev/null || true

# systemd-resolved for DNS
apt-get install -y -qq systemd-resolved 2>/dev/null || true

# systemd-resolved's postinst replaces /etc/resolv.conf with a symlink to
# /run/systemd/resolve/stub-resolv.conf, which doesn't exist in a chroot.
# That kills DNS for any apt-get install after it. Restore a real file before
# the live-boot fetch (which the script treats as fatal).
rm -f /etc/resolv.conf
cp /proc/net/route /dev/null 2>/dev/null  # touch to ensure /proc is mounted
echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 1.1.1.1" >> /etc/resolv.conf

# Live boot — handles USB enumeration, squashfs mount, and overlayfs.
# CRITICAL: if this fails the squashfs kernel-panics at init ("can't open
# /scripts/live"). Do NOT swallow errors here.
apt-get install -y -qq live-boot live-boot-initramfs-tools || {
    echo "FATAL: live-boot install failed — image will not boot. Aborting." >&2
    exit 1
}

# Regenerate initrd with live-boot hooks included
KVER=$(ls /boot/vmlinuz-* 2>/dev/null | sort -V | tail -1 | sed 's|/boot/vmlinuz-||')
[ -n "$KVER" ] && update-initramfs -u -k "$KVER" 2>/dev/null || true

apt-get clean
rm -rf /var/lib/apt/lists/*
CHROOT

info "Packages installed"

# ── Step 3: Install FreeRAID ─────────────────────────────────────────────────

step "3/6" "Installing FreeRAID"

INSTALL_DIR="$ROOTFS/usr/local/lib/freeraid"
mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/core/freeraid"             "$INSTALL_DIR/freeraid"
cp "$REPO_DIR/importer/unraid-import.py" "$INSTALL_DIR/unraid-import"
chmod +x "$INSTALL_DIR/freeraid" "$INSTALL_DIR/unraid-import"
ln -sf /usr/local/lib/freeraid/freeraid      "$ROOTFS/usr/local/bin/freeraid"
ln -sf /usr/local/lib/freeraid/freeraid      "$ROOTFS/usr/bin/freeraid"
ln -sf /usr/local/lib/freeraid/unraid-import "$ROOTFS/usr/local/bin/freeraid-import"

# Cockpit plugin
COCKPIT_DIR="$ROOTFS/usr/share/cockpit/freeraid"
mkdir -p "$COCKPIT_DIR"
cp "$REPO_DIR/web/freeraid/manifest.json" \
   "$REPO_DIR/web/freeraid/index.html" \
   "$REPO_DIR/web/freeraid/freeraid.css" \
   "$REPO_DIR/web/freeraid/freeraid.js" \
   "$REPO_DIR/web/freeraid/terminal.html" \
   "$REPO_DIR/web/freeraid/xterm.js" \
   "$REPO_DIR/web/freeraid/xterm.css" \
   "$REPO_DIR/web/freeraid/xterm-addon-fit.js" \
   "$COCKPIT_DIR/"

# Branding — hide Cockpit chrome
# Install to both default/ and debian/ since Cockpit prefers OS-specific branding
for BRANDING_DIR in "$ROOTFS/usr/share/cockpit/branding/default" "$ROOTFS/usr/share/cockpit/branding/debian"; do
    mkdir -p "$BRANDING_DIR"
    cp "$REPO_DIR/web/branding.css" "$BRANDING_DIR/branding.css"
    cp "$REPO_DIR/web/login.html"   "$BRANDING_DIR/login.html"
done

# Avahi SMB advertisement
mkdir -p "$ROOTFS/etc/avahi/services"
cat > "$ROOTFS/etc/avahi/services/smb.service" <<'EOF'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service>
    <type>_smb._tcp</type>
    <port>445</port>
  </service>
</service-group>
EOF

# wsdd config
echo 'WSDD_PARAMS="-w WORKGROUP"' > "$ROOTFS/etc/default/wsdd"

# Version file
mkdir -p "$ROOTFS/etc/freeraid"
echo "$FREERAID_VERSION" > "$ROOTFS/etc/freeraid/VERSION"

# Compose files — point to /boot/config/compose (persists to USB FAT32)
# /etc/freeraid/compose is a symlink so installed containers survive reboots
mkdir -p "$ROOTFS/etc/freeraid/plugins"
ln -sf /boot/config/compose "$ROOTFS/etc/freeraid/compose"

# VM and ZFS directories
mkdir -p "$ROOTFS/var/lib/freeraid/vms"
mkdir -p "$ROOTFS/mnt/user/isos"
mkdir -p "$ROOTFS/mnt/zfs"

# First-boot importer
cat > "$INSTALL_DIR/freeraid-firstboot" <<'FIRSTBOOT'
#!/bin/bash
BACKUP="/boot/config/unraid-backup.zip"
FLAG="/boot/config/.unraid-imported"
SKIP_PARITY_MARKER="/boot/config/.skip-parity"
COMPOSE_DIR="/etc/freeraid/compose"

[ -f "$BACKUP" ] || exit 0
[ -f "$FLAG"   ] && exit 0

IMPORT_ARGS=()
if [ -f "$SKIP_PARITY_MARKER" ]; then
    IMPORT_ARGS+=(--skip-parity)
    echo "FreeRAID: skip-parity marker found — Unraid parity will be left intact"
fi

echo "FreeRAID: importing Unraid backup..."
TMPDIR=$(mktemp -d /tmp/freeraid-firstboot-XXXXXX)
trap "rm -rf '$TMPDIR'" EXIT
unzip -q "$BACKUP" -d "$TMPDIR" 2>/dev/null || true

CONFDIR=$(find "$TMPDIR" \( -name "disk.cfg" -o -name "ident.cfg" \) 2>/dev/null \
    | head -1 | xargs dirname 2>/dev/null || echo "")
[ -z "$CONFDIR" ] && CONFDIR=$(find "$TMPDIR" -type d -name "config" | head -1 || echo "")
[ -z "$CONFDIR" ] && { echo "FreeRAID: could not find config in backup"; exit 1; }

mkdir -p "$COMPOSE_DIR"
python3 /usr/local/lib/freeraid/unraid-import \
    "$CONFDIR" \
    --out /boot/config/freeraid.conf.json \
    --compose-dir "$COMPOSE_DIR" \
    "${IMPORT_ARGS[@]}" \
    && date -Iseconds > "$FLAG" \
    && echo "FreeRAID: import complete." \
    || echo "FreeRAID: import had errors — check /boot/config/freeraid.conf.json"

# Apply imported network (static IP / DHCP / DNS) so the machine comes up
# on the address the user expects — but ONLY when this is a true cutover.
# The .skip-parity marker means the user is test-booting alongside a live
# Unraid box; stealing its static IP at first boot would knock the source
# system off the LAN. Failure is non-fatal: stale DHCP is better than no
# network.
if [ -f "$FLAG" ] && [ ! -f "$SKIP_PARITY_MARKER" ]; then
    /usr/local/bin/freeraid network-apply-config 2>&1 | logger -t freeraid-firstboot || true
elif [ -f "$SKIP_PARITY_MARKER" ]; then
    echo "FreeRAID: skip-parity active — leaving network on DHCP (imported static IP stays in config for future cutover; run 'freeraid network-apply-config' when ready)"
fi

# Carry over user customizations as inert side-files for review (do not
# execute — paths are Unraid-specific and may break). The web UI surfaces
# these as "imported, needs review" so the user can port them deliberately.
for src in go arr-indexer-fix.sh qbt-port-sync.sh; do
    if [ -f "$CONFDIR/$src" ]; then
        cp "$CONFDIR/$src" "/boot/config/imported-from-unraid-${src}" 2>/dev/null || true
    fi
done

# Carry over SSH host keys + authorized_keys so existing clients don't get a
# "host key changed" warning on first connect to the rebuilt box. Live USB
# wipes /etc/ssh/ on every boot, so we restore from /boot/config on each
# start in addition to this first-time copy.
if [ -d "$CONFDIR/ssh" ]; then
    mkdir -p /boot/config/ssh
    cp -a "$CONFDIR/ssh"/. /boot/config/ssh/ 2>/dev/null || true
fi
# Custom SSL cert (Let's Encrypt / MyServers). Preserved for future
# cockpit-reverse-proxy wiring.
if [ -d "$CONFDIR/ssl" ]; then
    mkdir -p /boot/config/ssl
    cp -a "$CONFDIR/ssl"/. /boot/config/ssl/ 2>/dev/null || true
fi
# Per-disk SMART alert attributes — not consumed by FreeRAID yet but
# preserved so we can wire them when we expose SMART thresholds in the UI.
[ -f "$CONFDIR/smart-one.cfg" ] && cp "$CONFDIR/smart-one.cfg" /boot/config/imported-smart-one.cfg

# Apply restored SSH host keys live so the running sshd uses them.
if [ -d /boot/config/ssh ] && [ -n "$(ls /boot/config/ssh/ssh_host_*_key 2>/dev/null)" ]; then
    cp -a /boot/config/ssh/ssh_host_*_key  /etc/ssh/ 2>/dev/null || true
    cp -a /boot/config/ssh/ssh_host_*_key.pub /etc/ssh/ 2>/dev/null || true
    chmod 600 /etc/ssh/ssh_host_*_key 2>/dev/null || true
    chmod 644 /etc/ssh/ssh_host_*_key.pub 2>/dev/null || true
    systemctl reload ssh 2>/dev/null || true
fi
if [ -f /boot/config/ssh/authorized_keys ]; then
    mkdir -p /root/.ssh && chmod 700 /root/.ssh
    cp /boot/config/ssh/authorized_keys /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
fi
FIRSTBOOT
chmod +x "$INSTALL_DIR/freeraid-firstboot"
ln -sf /usr/local/lib/freeraid/freeraid-firstboot "$ROOTFS/usr/local/bin/freeraid-firstboot"

info "FreeRAID installed into rootfs"

# ── Step 4: Configure the live system ────────────────────────────────────────

step "4/6" "Configuring live system"

chroot "$ROOTFS" bash -s <<CHROOT
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Hostname
echo "freeraid" > /etc/hostname
echo "127.0.1.1  freeraid" >> /etc/hosts

# Root password: freeraid (user changes at first login)
echo "root:freeraid" | chpasswd

# Samba user for root (same default password)
# pdbedit works without a running daemon; smbpasswd -a needs the DB initialized first
pdbedit -a -u root -t <<< $'freeraid\nfreeraid' 2>/dev/null || \
    (printf 'freeraid\nfreeraid\n' | smbpasswd -a -s root 2>/dev/null) || true
smbpasswd -e root 2>/dev/null || true

# SSH — allow root password login
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/freeraid.conf <<'SSHCONF'
PermitRootLogin yes
PasswordAuthentication yes
SSHCONF

# Cockpit PAM — minimal config for live/USB systems
# Default Debian cockpit PAM has pam_selinux (no-op but can fail) and
# pam_env reading /etc/default/locale which doesn't exist on live systems.
cat > /etc/pam.d/cockpit <<'PAMEOF'
#%PAM-1.0
auth       required     pam_unix.so
auth       required     pam_listfile.so item=user sense=deny file=/etc/cockpit/disallowed-users onerr=succeed
account    required     pam_unix.so
account    required     pam_nologin.so
session    optional     pam_loginuid.so
session    required     pam_unix.so
session    optional     pam_env.so
PAMEOF

# Cockpit — allow root, clear disallowed-users
mkdir -p /etc/cockpit
cat > /etc/cockpit/cockpit.conf <<'CONF'
[WebService]
LoginTitle = FreeRAID
CONF
# Empty disallowed-users so root can log in
> /etc/cockpit/disallowed-users

# MOTD at SSH login
cat > /etc/profile.d/freeraid-motd.sh <<'MOTD'
IP=\$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print \$7; exit}' || hostname -I | awk '{print \$1}')
echo ""
echo "  FreeRAID \$(cat /etc/freeraid/VERSION 2>/dev/null)"
echo "  Web UI : https://\${IP}:9090"
echo "  Login  : root / freeraid"
echo ""
MOTD

# Network: DHCP on all wired interfaces
mkdir -p /etc/systemd/network
cat > /etc/systemd/network/20-wired.network <<'NET'
[Match]
Name=en* eth*

[Network]
DHCP=yes
MulticastDNS=yes

[DHCPv4]
RouteMetric=10
NET

# Systemd services
systemctl enable systemd-networkd 2>/dev/null || true
systemctl enable systemd-resolved 2>/dev/null || true
systemctl enable ssh              2>/dev/null || true
systemctl enable cockpit.socket   2>/dev/null || true
systemctl enable docker           2>/dev/null || true

# Docker storage driver: vfs works on live overlayfs root (before array starts).
# freeraid array-start automatically switches to overlay2 on first data disk.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'DOCKEREOF'
{
  "storage-driver": "vfs"
}
DOCKEREOF
systemctl enable avahi-daemon     2>/dev/null || true

# FreeRAID array service
cat > /etc/systemd/system/freeraid-array.service <<'SVC'
[Unit]
Description=FreeRAID Array
After=network.target local-fs.target
DefaultDependencies=no

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/freeraid start
ExecStartPost=/usr/local/bin/freeraid shares-apply
ExecStop=/usr/local/bin/freeraid stop
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
SVC

cat > /etc/systemd/system/freeraid-sync.service <<'SVC'
[Unit]
Description=FreeRAID SnapRAID Sync
After=freeraid-array.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid sync
SVC

cat > /etc/systemd/system/freeraid-sync.timer <<'SVC'
[Unit]
Description=FreeRAID nightly SnapRAID sync
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
SVC

cat > /etc/systemd/system/freeraid-scrub.service <<'SVC'
[Unit]
Description=FreeRAID SnapRAID Scrub
After=freeraid-array.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid scrub
SVC

cat > /etc/systemd/system/freeraid-scrub.timer <<'SVC'
[Unit]
Description=FreeRAID weekly SnapRAID scrub
[Timer]
OnCalendar=Sun *-*-* 04:00:00
Persistent=true
[Install]
WantedBy=timers.target
SVC

cat > /etc/systemd/system/freeraid-mover.service <<'SVC'
[Unit]
Description=FreeRAID Cache Mover
After=freeraid-array.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid cache-move
SVC

cat > /etc/systemd/system/freeraid-mover.timer <<'SVC'
[Unit]
Description=FreeRAID nightly cache mover
[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
[Install]
WantedBy=timers.target
SVC

cat > /etc/systemd/system/freeraid-docker-update.service <<'SVC'
[Unit]
Description=FreeRAID Docker Auto-Update
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid docker-update-all
SVC

cat > /etc/systemd/system/freeraid-docker-update.timer <<'SVC'
[Unit]
Description=FreeRAID nightly Docker auto-update
[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
[Install]
WantedBy=timers.target
SVC

cat > /etc/systemd/system/freeraid-firstboot.service <<'SVC'
[Unit]
Description=FreeRAID First Boot Import
# CRITICAL: must run AFTER freeraid-config-mount, otherwise the
# ConditionPathExists below is evaluated before /boot/config is bound from
# the USB and silently fails — leaving the imported backup zip on the USB
# unprocessed forever. systemd evaluates Conditions at activation; once a
# condition fails the unit is marked skipped and won't retry on its own.
After=freeraid-config-mount.service local-fs.target
Requires=freeraid-config-mount.service
Before=freeraid-array.service
ConditionPathExists=/boot/config/unraid-backup.zip
ConditionPathExists=!/boot/config/.unraid-imported
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/freeraid-firstboot
StandardOutput=journal+console
StandardError=journal+console
[Install]
WantedBy=multi-user.target
SVC

# Re-install NVIDIA support on every boot when the user has opted in.
# Live-boot wipes the root overlay each boot, so installs don't persist.
cat > /etc/systemd/system/freeraid-nvidia.service <<'SVC'
[Unit]
Description=FreeRAID NVIDIA driver + container-toolkit installer
After=network-online.target local-fs.target
Wants=network-online.target
Before=docker.service
ConditionPathExists=/boot/config/.nvidia-enabled
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/freeraid nvidia-install
StandardOutput=journal+console
StandardError=journal+console
[Install]
WantedBy=multi-user.target
SVC

systemctl enable freeraid-array.service        2>/dev/null || true
systemctl enable freeraid-sync.timer           2>/dev/null || true
systemctl enable freeraid-scrub.timer          2>/dev/null || true
systemctl enable freeraid-mover.timer          2>/dev/null || true
systemctl enable freeraid-docker-update.timer  2>/dev/null || true
systemctl enable freeraid-firstboot.service    2>/dev/null || true
systemctl enable freeraid-nvidia.service       2>/dev/null || true

# Mount config/ from USB flash drive to /boot/config (persistent config)
# With toram, live-boot copies squashfs to RAM and releases the USB device.
# We then mount the USB partition (by FREERAID label) rw at /boot/config.
cat > /etc/systemd/system/freeraid-config-mount.service <<'SVC'
[Unit]
Description=FreeRAID persistent config mount (USB rw)
DefaultDependencies=no
After=live-boot.service local-fs.target
Before=freeraid-array.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c '\
    mkdir -p /mnt/freeraid-usb /boot/config; \
    DEV=\$(blkid -L FREERAID 2>/dev/null || findfs LABEL=FREERAID 2>/dev/null || echo ""); \
    if [ -n "\$DEV" ]; then \
        mount -o rw,uid=0,gid=0 "\$DEV" /mnt/freeraid-usb && \
        mkdir -p /mnt/freeraid-usb/config /mnt/freeraid-usb/config/compose && \
        mount --bind /mnt/freeraid-usb/config /boot/config || \
        mount --bind /run/live/medium/config /boot/config || true; \
    else \
        mount --bind /run/live/medium/config /boot/config || true; \
    fi; \
    mkdir -p /boot/config /boot/config/compose /boot/config/samba; \
    mkdir -p /var/lib/samba; \
    ln -sf /boot/config/samba/passdb.tdb /var/lib/samba/passdb.tdb 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
SVC
systemctl enable freeraid-config-mount.service 2>/dev/null || true

CHROOT

info "Live system configured"

# ── Step 5: Copy Debian initrd (live-boot hooks included) ─────────────────────

step "5/6" "Copying Debian initrd (with live-boot)"

KVER=$(ls "$ROOTFS/boot/vmlinuz-"* 2>/dev/null | sort -V | tail -1 | sed "s|$ROOTFS/boot/vmlinuz-||")
[ -n "$KVER" ] || die "No kernel found in $ROOTFS/boot/"

DEBIAN_INITRD="$ROOTFS/boot/initrd.img-$KVER"
[ -f "$DEBIAN_INITRD" ] || die "Debian initrd not found: $DEBIAN_INITRD"

cp "$DEBIAN_INITRD" "$BUILD_DIR/initrd.gz"
info "initrd.gz: $(du -sh "$BUILD_DIR/initrd.gz" | cut -f1) (Debian initrd with live-boot)"

# ── Unmount chroot before squashfs ────────────────────────────────────────────

umount -lf "$ROOTFS/proc"    2>/dev/null || true
umount -lf "$ROOTFS/sys"     2>/dev/null || true
umount -lf "$ROOTFS/dev/pts" 2>/dev/null || true
umount -lf "$ROOTFS/dev"     2>/dev/null || true
umount -lf "$ROOTFS/run"     2>/dev/null || true
trap - EXIT

# ── Step 6: Build squashfs + copy kernel ─────────────────────────────────────

step "6/6" "Building squashfs and copying kernel"

KERNEL=$(ls "$ROOTFS/boot/vmlinuz-"* 2>/dev/null | tail -1)
[ -f "$KERNEL" ] || die "No kernel found in $ROOTFS/boot/"
cp "$KERNEL" "$BUILD_DIR/vmlinuz"
info "Kernel: $(basename $KERNEL)"

info "Building rootfs.squashfs (this takes a few minutes)..."
rm -f "$BUILD_DIR/rootfs.squashfs"
mksquashfs "$ROOTFS" "$BUILD_DIR/rootfs.squashfs" \
    -comp xz \
    -e "$ROOTFS/boot" \
    -noappend \
    -quiet \
    2>/dev/null
# Ensure empty mount-point dirs exist in squashfs (live-boot needs them)
# proc/sys/run/tmp are empty after chroot unmount — mksquashfs above includes them

info "rootfs.squashfs: $(du -sh "$BUILD_DIR/rootfs.squashfs" | cut -f1)"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}Build complete!${NC}"
echo ""
echo "  Artifacts in $BUILD_DIR:"
ls -lh "$BUILD_DIR/"
echo ""
echo "  Write to USB:"
echo "    sudo bash scripts/create-usb.sh /dev/sdX"
echo "    sudo bash scripts/create-usb.sh /dev/sdX /path/to/unraid-backup.zip"
echo ""
