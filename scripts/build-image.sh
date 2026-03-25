#!/usr/bin/env bash
# FreeRAID Live Image Builder
# Builds a bootable live OS image that runs entirely from USB in RAM.
# Output goes to build/ — then use create-usb.sh to write to a USB drive.
#
# Usage: sudo bash scripts/build-image.sh
#
# Requires: debootstrap mksquashfs busybox-static cpio gzip
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

echo -e "${BOLD}"
echo "  ███████╗██████╗ ███████╗███████╗██████╗  █████╗ ██╗██████╗ "
echo "  ██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██║██╔══██╗"
echo "  █████╗  ██████╔╝█████╗  █████╗  ██████╔╝███████║██║██║  ██║"
echo "  ██╔══╝  ██╔══██╗██╔══╝  ██╔══╝  ██╔══██╗██╔══██║██║██║  ██║"
echo "  ██║     ██║  ██║███████╗███████╗██║  ██║██║  ██║██║██████╔╝"
echo "  ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═════╝"
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
    debootstrap \
        --arch=amd64 \
        --include=systemd,systemd-sysv,udev,kmod,iproute2,iputils-ping,\
dnsutils,curl,wget,ca-certificates,openssh-server,sudo,\
jq,xfsprogs,btrfs-progs,e2fsprogs,parted,hdparm,smartmontools,\
samba,nfs-kernel-server,unzip,python3,\
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

# Copy resolv.conf for network access
cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf"

chroot "$ROOTFS" bash -s <<'CHROOT'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq

# Snapraid
apt-get install -y -qq snapraid || {
    # Not in main repos on all mirrors — try contrib
    echo "deb http://deb.debian.org/debian bookworm contrib" >> /etc/apt/sources.list
    apt-get update -qq
    apt-get install -y -qq snapraid || echo "WARN: snapraid not installed, install manually"
}

# MergerFS (download latest deb)
MERGERFS_VER="2.40.2"
MERGERFS_DEB="mergerfs_${MERGERFS_VER}.debian-bookworm_amd64.deb"
MERGERFS_URL="https://github.com/trapexit/mergerfs/releases/download/${MERGERFS_VER}/${MERGERFS_DEB}"
apt-get install -y -qq fuse
curl -fsSL "$MERGERFS_URL" -o /tmp/mergerfs.deb
dpkg -i /tmp/mergerfs.deb
rm /tmp/mergerfs.deb

# Docker
curl -fsSL https://get.docker.com | sh
apt-get install -y -qq docker-compose-plugin

# Cockpit
apt-get install -y -qq cockpit cockpit-networkmanager cockpit-storaged 2>/dev/null || \
    apt-get install -y -qq cockpit

apt-get clean
rm -rf /var/lib/apt/lists/*
CHROOT

info "Packages installed"

# ── Step 3: Install FreeRAID ─────────────────────────────────────────────────

step "3/6" "Installing FreeRAID"

# Copy FreeRAID files into rootfs
INSTALL_DIR="$ROOTFS/usr/local/lib/freeraid"
mkdir -p "$INSTALL_DIR"
cp "$REPO_DIR/core/freeraid"            "$INSTALL_DIR/freeraid"
cp "$REPO_DIR/importer/unraid-import.py" "$INSTALL_DIR/unraid-import"
chmod +x "$INSTALL_DIR/freeraid" "$INSTALL_DIR/unraid-import"
ln -sf "$INSTALL_DIR/freeraid"    "$ROOTFS/usr/local/bin/freeraid"
ln -sf "$INSTALL_DIR/unraid-import" "$ROOTFS/usr/local/bin/freeraid-import"

# Cockpit plugin
mkdir -p "$ROOTFS/usr/share/cockpit/freeraid"
cp "$REPO_DIR/web/freeraid/manifest.json" \
   "$REPO_DIR/web/freeraid/index.html" \
   "$REPO_DIR/web/freeraid/freeraid.css" \
   "$REPO_DIR/web/freeraid/freeraid.js" \
   "$ROOTFS/usr/share/cockpit/freeraid/"

# VERSION
mkdir -p "$ROOTFS/etc/freeraid"
cp "$REPO_DIR/VERSION" "$ROOTFS/etc/freeraid/VERSION"

# Compose files dir
mkdir -p "$ROOTFS/etc/freeraid/compose"
cp "$REPO_DIR/compose/"*.docker-compose.yml "$ROOTFS/etc/freeraid/compose/" 2>/dev/null || true

info "FreeRAID installed into rootfs"

# ── Step 4: Configure the live system ────────────────────────────────────────

step "4/6" "Configuring live system"

FREERAID_VERSION=$(cat "$REPO_DIR/VERSION" | tr -d '[:space:]')

chroot "$ROOTFS" bash -s <<CHROOT
set -euo pipefail

# Hostname
echo "freeraid" > /etc/hostname
echo "127.0.1.1  freeraid" >> /etc/hosts

# freeraid user, password freeraid
useradd -m -s /bin/bash -G sudo,docker freeraid 2>/dev/null || true
echo "freeraid:freeraid" | chpasswd
echo "root:freeraid"     | chpasswd
echo "freeraid ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/freeraid

# Allow root cockpit login
mkdir -p /etc/cockpit
cat > /etc/cockpit/cockpit.conf <<'CONF'
[WebService]
LoginTitle = FreeRAID
Origins = *
ProtocolHeader = X-Forwarded-Proto

[Login]
# Allow freeraid user without pam restrictions
CONF
[ -f /etc/cockpit/disallowed-users ] && sed -i '/^root$/d' /etc/cockpit/disallowed-users || true

# Network: DHCP on all interfaces via networkd
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

systemctl enable systemd-networkd
systemctl enable systemd-resolved
systemctl enable ssh
systemctl enable cockpit.socket
systemctl enable docker

# FreeRAID array auto-start
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

cat > /etc/systemd/system/freeraid-sync.timer <<'SVC'
[Unit]
Description=FreeRAID SnapRAID daily sync

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
SVC

cat > /etc/systemd/system/freeraid-sync.service <<'SVC'
[Unit]
Description=FreeRAID SnapRAID Sync
After=freeraid-array.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/freeraid sync
SVC

systemctl enable freeraid-array.service
systemctl enable freeraid-sync.timer

# Default FreeRAID config — will be overwritten by USB config/ on boot
mkdir -p /boot/config
# (actual config/ comes from USB mount at boot time)

# Show IP and web UI URL at login
cat > /etc/profile.d/freeraid-motd.sh <<'MOTD'
if [ -f /run/freeraid-ip ]; then
    IP=\$(cat /run/freeraid-ip)
    echo ""
    echo "  FreeRAID v\$(cat /etc/freeraid/VERSION 2>/dev/null)"
    echo "  Web UI: https://\${IP}:9090"
    echo "  Login:  freeraid / freeraid"
    echo ""
fi
MOTD

# Service that writes IP to /run/freeraid-ip after network is up
cat > /etc/systemd/system/freeraid-announce.service <<'SVC'
[Unit]
Description=FreeRAID IP Announce
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'IP=\$(ip -4 route get 1.1.1.1 2>/dev/null | awk "{print \$7; exit}"); echo "\$IP" > /run/freeraid-ip; echo "FreeRAID ready: https://\$IP:9090"'

[Install]
WantedBy=multi-user.target
SVC
systemctl enable freeraid-announce.service

# Write login banner (updated on first boot when IP is known)
cat > /etc/issue <<'ISSUE'

  FreeRAID — Open source NAS OS
  Web UI: https://<server-ip>:9090   Login: freeraid / freeraid

ISSUE

CHROOT

info "Live system configured"

# ── Step 5: Create custom initrd ──────────────────────────────────────────────

step "5/6" "Building custom initrd (live boot)"

INITRD_DIR=$(mktemp -d /tmp/freeraid-initrd-XXXXXX)
mkdir -p "$INITRD_DIR"/{bin,sbin,lib,lib64,lib/x86_64-linux-gnu,dev,proc,sys,run,mnt/usb,mnt/squash,mnt/overlay,newroot}

# Busybox provides all the tools we need (sh, mount, blkid, switch_root, etc)
cp /usr/lib/busybox/busybox-x86_64 "$INITRD_DIR/bin/busybox" 2>/dev/null || \
    cp $(which busybox) "$INITRD_DIR/bin/busybox"
chmod +x "$INITRD_DIR/bin/busybox"

# Create busybox symlinks
for cmd in sh ash mount umount mkdir mknod modprobe insmod sleep \
           blkid switch_root echo cat ls grep awk sed; do
    ln -sf busybox "$INITRD_DIR/bin/$cmd" 2>/dev/null || true
done
ln -sf ../bin/busybox "$INITRD_DIR/sbin/init" 2>/dev/null || true

# Copy blkid (real binary — busybox blkid may not support -L)
if [ -f /sbin/blkid ]; then
    cp /sbin/blkid "$INITRD_DIR/sbin/blkid"
    # Copy its library deps
    ldd /sbin/blkid 2>/dev/null | awk '/=>/{print $3}' | while read lib; do
        [ -f "$lib" ] && cp "$lib" "$INITRD_DIR/lib/x86_64-linux-gnu/" 2>/dev/null || true
    done
    cp /lib/x86_64-linux-gnu/libblkid.so.1  "$INITRD_DIR/lib/x86_64-linux-gnu/" 2>/dev/null || true
    cp /lib/x86_64-linux-gnu/libmount.so.1  "$INITRD_DIR/lib/x86_64-linux-gnu/" 2>/dev/null || true
    cp /lib/x86_64-linux-gnu/libuuid.so.1   "$INITRD_DIR/lib/x86_64-linux-gnu/" 2>/dev/null || true
    cp /lib/x86_64-linux-gnu/libc.so.6      "$INITRD_DIR/lib/x86_64-linux-gnu/" 2>/dev/null || true
    ln -sf x86_64-linux-gnu/ld-linux-x86-64.so.2 "$INITRD_DIR/lib64/ld-linux-x86-64.so.2" 2>/dev/null || \
    cp /lib64/ld-linux-x86-64.so.2 "$INITRD_DIR/lib64/" 2>/dev/null || true
fi

# Write the init script
cat > "$INITRD_DIR/init" <<'INIT'
#!/bin/sh
export PATH=/bin:/sbin

# Basic mounts
mount -t devtmpfs devtmpfs /dev     2>/dev/null || \
    mknod /dev/null c 1 3 2>/dev/null || true
mount -t proc     proc     /proc
mount -t sysfs    sysfs    /sys
mount -t tmpfs    tmpfs    /run

echo ""
echo "  FreeRAID — starting..."
echo ""

# Load needed modules
modprobe squashfs  2>/dev/null || true
modprobe overlay   2>/dev/null || true
modprobe vfat      2>/dev/null || true
modprobe usb_storage 2>/dev/null || true
modprobe uas       2>/dev/null || true

# Wait for the FREERAID USB to appear (up to 30s)
USB_PART=""
for i in $(seq 1 30); do
    USB_PART=$(blkid -L FREERAID 2>/dev/null || /sbin/blkid -L FREERAID 2>/dev/null || true)
    [ -n "$USB_PART" ] && break
    echo "  Waiting for FREERAID USB... ($i)"
    sleep 1
done

if [ -z "$USB_PART" ]; then
    echo "ERROR: FREERAID USB drive not found!"
    echo "       Make sure the USB labeled FREERAID is plugged in."
    exec /bin/sh
fi

echo "  Found FREERAID USB: $USB_PART"

# Mount USB
mount -t vfat -o ro,noatime "$USB_PART" /mnt/usb
echo "  USB mounted"

# Mount squashfs (the live OS)
mount -t squashfs -o ro,loop /mnt/usb/rootfs.squashfs /mnt/squash
echo "  OS image mounted"

# Overlay: read-only squash + tmpfs for writes (changes lost on reboot)
mount -t tmpfs -o size=512m tmpfs /mnt/overlay
mkdir -p /mnt/overlay/upper /mnt/overlay/work
mount -t overlay overlay \
    -o lowerdir=/mnt/squash,upperdir=/mnt/overlay/upper,workdir=/mnt/overlay/work \
    /newroot
echo "  Overlay filesystem ready"

# Mount the USB config/ directory at /boot/config (PERSISTENT)
mkdir -p /newroot/boot/config /mnt/usb/config
mount -t vfat -o rw,noatime "$USB_PART" /mnt/usb-rw 2>/dev/null && \
    mount --bind /mnt/usb-rw/config /newroot/boot/config 2>/dev/null || {
    # Remount USB rw for config writes
    umount /mnt/usb 2>/dev/null || true
    mount -t vfat -o rw,noatime "$USB_PART" /mnt/usb
    mkdir -p /mnt/usb/config
    mount --bind /mnt/usb/config /newroot/boot/config
}
echo "  Config directory: /boot/config (persists to USB)"

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

# Package as initrd
info "Packing initrd..."
( cd "$INITRD_DIR"; find . | cpio -o --format=newc --quiet | gzip -9 ) > "$BUILD_DIR/initrd.gz"
rm -rf "$INITRD_DIR"
info "initrd.gz: $(du -sh "$BUILD_DIR/initrd.gz" | cut -f1)"

# ── Unmount chroot mounts before squashfs ─────────────────────────────────────

umount -lf "$ROOTFS/proc"    2>/dev/null || true
umount -lf "$ROOTFS/sys"     2>/dev/null || true
umount -lf "$ROOTFS/dev/pts" 2>/dev/null || true
umount -lf "$ROOTFS/dev"     2>/dev/null || true
umount -lf "$ROOTFS/run"     2>/dev/null || true
trap - EXIT

# ── Step 6: Build squashfs + copy kernel ─────────────────────────────────────

step "6/6" "Building squashfs and copying kernel"

# Copy the kernel out of the rootfs
KERNEL=$(ls "$ROOTFS/boot/vmlinuz-"* 2>/dev/null | head -1)
[ -f "$KERNEL" ] || die "No kernel found in $ROOTFS/boot/"
cp "$KERNEL" "$BUILD_DIR/vmlinuz"
info "Kernel: $(basename $KERNEL)"

# Build squashfs (exclude things that don't need to be in the image)
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
echo "  Build artifacts in $BUILD_DIR:"
ls -lh "$BUILD_DIR/"
echo ""
echo "  Now write to a USB drive:"
echo "    sudo bash scripts/create-usb.sh /dev/sdX"
echo "    sudo bash scripts/create-usb.sh /dev/sdX /path/to/unraid-backup.zip"
echo ""
