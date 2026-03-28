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

if [ -d "$ROOTFS/usr" ]; then
    warn "Rootfs already exists at $ROOTFS — skipping debootstrap"
    warn "Delete $ROOTFS to rebuild from scratch"
else
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
    samba wsdd avahi-daemon nfs-kernel-server

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
        || warn "mergerfs download failed — install manually after boot"
fi

# ZFS from backports
apt-get install -y -t bookworm-backports zfsutils-linux 2>/dev/null || \
    warn "ZFS install failed — may need reboot for kernel modules"

# Docker
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
fi
apt-get install -y -qq docker-compose-plugin 2>/dev/null || true

# Cockpit
apt-get install -y -qq cockpit 2>/dev/null || true

# Virtualization
apt-get install -y -qq qemu-kvm libvirt-daemon-system virtinst 2>/dev/null || true

# systemd-resolved for DNS
apt-get install -y -qq systemd-resolved 2>/dev/null || true

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
ln -sf "$INSTALL_DIR/freeraid"      "$ROOTFS/usr/local/bin/freeraid"
ln -sf "$INSTALL_DIR/unraid-import" "$ROOTFS/usr/local/bin/freeraid-import"

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
BRANDING_DIR="$ROOTFS/usr/share/cockpit/branding/default"
mkdir -p "$BRANDING_DIR"
cp "$REPO_DIR/web/branding.css" "$BRANDING_DIR/branding.css"
cp "$REPO_DIR/web/login.html"   "$BRANDING_DIR/login.html"

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

# Compose files
mkdir -p "$ROOTFS/etc/freeraid/compose" "$ROOTFS/etc/freeraid/plugins"
cp "$REPO_DIR/compose/"*.docker-compose.yml "$ROOTFS/etc/freeraid/compose/" 2>/dev/null || true

# VM and ZFS directories
mkdir -p "$ROOTFS/var/lib/freeraid/vms"
mkdir -p "$ROOTFS/mnt/user/isos"
mkdir -p "$ROOTFS/mnt/zfs"

# First-boot importer
cat > "$INSTALL_DIR/freeraid-firstboot" <<'FIRSTBOOT'
#!/bin/bash
BACKUP="/boot/config/unraid-backup.zip"
FLAG="/boot/config/.unraid-imported"
COMPOSE_DIR="/etc/freeraid/compose"

[ -f "$BACKUP" ] || exit 0
[ -f "$FLAG"   ] && exit 0

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
    && date -Iseconds > "$FLAG" \
    && echo "FreeRAID: import complete." \
    || echo "FreeRAID: import had errors — check /boot/config/freeraid.conf.json"
FIRSTBOOT
chmod +x "$INSTALL_DIR/freeraid-firstboot"
ln -sf "$INSTALL_DIR/freeraid-firstboot" "$ROOTFS/usr/local/bin/freeraid-firstboot"

info "FreeRAID installed into rootfs"

# ── Step 4: Configure the live system ────────────────────────────────────────

step "4/6" "Configuring live system"

chroot "$ROOTFS" bash -s <<CHROOT
# Hostname
echo "freeraid" > /etc/hostname
echo "127.0.1.1  freeraid" >> /etc/hosts

# Root password: freeraid (user changes at first login)
echo "root:freeraid" | chpasswd

# Cockpit — allow root, clear disallowed-users
mkdir -p /etc/cockpit
cat > /etc/cockpit/cockpit.conf <<'CONF'
[WebService]
LoginTitle = FreeRAID
Origins = *
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
systemctl enable avahi-daemon     2>/dev/null || true
systemctl enable libvirtd         2>/dev/null || true

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
After=local-fs.target
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

systemctl enable freeraid-array.service        2>/dev/null || true
systemctl enable freeraid-sync.timer           2>/dev/null || true
systemctl enable freeraid-scrub.timer          2>/dev/null || true
systemctl enable freeraid-mover.timer          2>/dev/null || true
systemctl enable freeraid-docker-update.timer  2>/dev/null || true
systemctl enable freeraid-firstboot.service    2>/dev/null || true

CHROOT

info "Live system configured"

# ── Step 5: Build custom initrd ───────────────────────────────────────────────

step "5/6" "Building custom initrd (live boot)"

INITRD_DIR=$(mktemp -d /tmp/freeraid-initrd-XXXXXX)
mkdir -p "$INITRD_DIR"/{bin,sbin,lib,lib64,lib/x86_64-linux-gnu,dev,proc,sys,run,mnt/usb,mnt/squash,mnt/overlay,newroot}

# Busybox
BUSYBOX_BIN=$(find /usr/lib/busybox /usr/bin -name "busybox*" -type f 2>/dev/null | head -1)
[ -z "$BUSYBOX_BIN" ] && BUSYBOX_BIN=$(which busybox 2>/dev/null)
[ -z "$BUSYBOX_BIN" ] && die "busybox not found — install busybox-static"
cp "$BUSYBOX_BIN" "$INITRD_DIR/bin/busybox"
chmod +x "$INITRD_DIR/bin/busybox"

for cmd in sh ash mount umount mkdir mknod modprobe insmod sleep \
           blkid switch_root echo cat ls grep awk sed find; do
    ln -sf busybox "$INITRD_DIR/bin/$cmd" 2>/dev/null || true
done
ln -sf ../bin/sh "$INITRD_DIR/sbin/init" 2>/dev/null || true

# Real blkid for reliable label lookups
if [ -f /sbin/blkid ]; then
    cp /sbin/blkid "$INITRD_DIR/sbin/blkid"
    ldd /sbin/blkid 2>/dev/null | awk '/=>/{print $3}' | while read lib; do
        [ -f "$lib" ] && cp "$lib" "$INITRD_DIR/lib/x86_64-linux-gnu/" 2>/dev/null || true
    done
    for lib in libblkid.so.1 libmount.so.1 libuuid.so.1 libc.so.6; do
        find /lib /usr/lib -name "$lib" 2>/dev/null | head -1 | \
            xargs -I{} cp {} "$INITRD_DIR/lib/x86_64-linux-gnu/" 2>/dev/null || true
    done
    find /lib64 /usr/lib64 /lib -name "ld-linux-x86-64.so.2" 2>/dev/null | head -1 | \
        xargs -I{} cp {} "$INITRD_DIR/lib64/" 2>/dev/null || true
fi

cat > "$INITRD_DIR/init" <<'INIT'
#!/bin/sh
export PATH=/bin:/sbin

mount -t devtmpfs devtmpfs /dev  2>/dev/null || true
mount -t proc     proc     /proc
mount -t sysfs    sysfs    /sys
mount -t tmpfs    tmpfs    /run

echo ""
echo "  FreeRAID — starting..."
echo ""

modprobe squashfs  2>/dev/null || true
modprobe overlay   2>/dev/null || true
modprobe vfat      2>/dev/null || true
modprobe usb_storage 2>/dev/null || true
modprobe uas       2>/dev/null || true
modprobe mmc_block 2>/dev/null || true

# Find FREERAID USB by label (up to 30s)
USB_PART=""
for i in $(seq 1 30); do
    USB_PART=$(blkid -L FREERAID 2>/dev/null || /sbin/blkid -L FREERAID 2>/dev/null || true)
    [ -n "$USB_PART" ] && break
    echo "  Waiting for FREERAID drive... ($i)"
    sleep 1
done

if [ -z "$USB_PART" ]; then
    echo ""
    echo "  ERROR: FREERAID drive not found!"
    echo "  Make sure the FreeRAID USB is plugged in and labeled FREERAID."
    echo ""
    exec /bin/sh
fi

echo "  Found: $USB_PART"

# Mount USB read-write (config/ must be writable)
mount -t vfat -o rw,noatime "$USB_PART" /mnt/usb || {
    echo "  ERROR: Failed to mount $USB_PART"
    exec /bin/sh
}

# Mount squashfs OS image
mount -t squashfs -o ro,loop /mnt/usb/rootfs.squashfs /mnt/squash || {
    echo "  ERROR: Failed to mount rootfs.squashfs"
    exec /bin/sh
}

# Overlay: squashfs (ro) + tmpfs (rw writes, lost on reboot)
mount -t tmpfs -o size=1g tmpfs /mnt/overlay
mkdir -p /mnt/overlay/upper /mnt/overlay/work
mount -t overlay overlay \
    -o lowerdir=/mnt/squash,upperdir=/mnt/overlay/upper,workdir=/mnt/overlay/work \
    /newroot

# Config directory — bind USB config/ to /boot/config (PERSISTENT across reboots)
mkdir -p /mnt/usb/config /newroot/boot/config
mount --bind /mnt/usb/config /newroot/boot/config

# Move essential mounts into newroot
mkdir -p /newroot/proc /newroot/sys /newroot/dev /newroot/run
mount --move /proc /newroot/proc
mount --move /sys  /newroot/sys
mount --move /dev  /newroot/dev
mount --move /run  /newroot/run

echo "  Booting FreeRAID..."
echo ""
exec switch_root /newroot /sbin/init
INIT

chmod +x "$INITRD_DIR/init"

info "Packing initrd..."
( cd "$INITRD_DIR"; find . | cpio -o --format=newc --quiet | gzip -9 ) > "$BUILD_DIR/initrd.gz"
rm -rf "$INITRD_DIR"
info "initrd.gz: $(du -sh "$BUILD_DIR/initrd.gz" | cut -f1)"

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
    -e "$ROOTFS/proc" \
    -e "$ROOTFS/sys" \
    -e "$ROOTFS/dev" \
    -e "$ROOTFS/run" \
    -e "$ROOTFS/tmp" \
    -noappend \
    -quiet \
    2>/dev/null

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
