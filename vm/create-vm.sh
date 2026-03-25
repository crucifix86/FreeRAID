#!/usr/bin/env bash
# FreeRAID VM setup - creates a test environment with:
#   1x boot/config disk (4GB)  - simulates the USB drive
#   4x data disks (8GB each)   - array drives
#   1x parity disk (8GB)       - parity drive
#   1x cache disk (4GB)        - SSD cache
# All disks are sparse qcow2 images (take no real space until written)

set -e

VM_DIR="$(cd "$(dirname "$0")" && pwd)/disks"
VM_NAME="freeraid-test"
ISO_URL="https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.10.0-amd64-netinst.iso"
ISO_PATH="$(dirname "$0")/debian-12-netinst.iso"

mkdir -p "$VM_DIR"

echo "==> Creating disk images..."
# Boot/config disk (simulates USB drive - stores OS + config)
qemu-img create -f qcow2 "$VM_DIR/boot.qcow2"   4G  -q
# Data drives
qemu-img create -f qcow2 "$VM_DIR/disk1.qcow2"  8G  -q
qemu-img create -f qcow2 "$VM_DIR/disk2.qcow2"  8G  -q
qemu-img create -f qcow2 "$VM_DIR/disk3.qcow2"  8G  -q
qemu-img create -f qcow2 "$VM_DIR/disk4.qcow2"  8G  -q
# Parity drive (must be >= largest data drive)
qemu-img create -f qcow2 "$VM_DIR/parity.qcow2" 8G  -q
# Cache drive
qemu-img create -f qcow2 "$VM_DIR/cache.qcow2"  4G  -q

echo "==> Disk images created in $VM_DIR"
ls -lh "$VM_DIR/"

# Check for ISO
if [ ! -f "$ISO_PATH" ]; then
    echo ""
    echo "==> Debian ISO not found. Downloading..."
    echo "    $ISO_URL"
    wget -q --show-progress -O "$ISO_PATH" "$ISO_URL" || {
        echo ""
        echo "Download failed. Grab it manually:"
        echo "  wget -O '$ISO_PATH' '$ISO_URL'"
        exit 1
    }
fi

echo ""
echo "==> Launching VM installer..."
echo "    During install: use the boot disk (sda) as install target"
echo "    Other disks will appear as sdb-sdg - leave them unformatted"
echo ""

qemu-system-x86_64 \
    -name "$VM_NAME" \
    -enable-kvm \
    -m 4096 \
    -smp 4 \
    -cpu host \
    -drive file="$VM_DIR/boot.qcow2",format=qcow2,if=virtio,index=0 \
    -drive file="$VM_DIR/disk1.qcow2",format=qcow2,if=virtio,index=1 \
    -drive file="$VM_DIR/disk2.qcow2",format=qcow2,if=virtio,index=2 \
    -drive file="$VM_DIR/disk3.qcow2",format=qcow2,if=virtio,index=3 \
    -drive file="$VM_DIR/disk4.qcow2",format=qcow2,if=virtio,index=4 \
    -drive file="$VM_DIR/parity.qcow2",format=qcow2,if=virtio,index=5 \
    -drive file="$VM_DIR/cache.qcow2",format=qcow2,if=virtio,index=6 \
    -cdrom "$ISO_PATH" \
    -boot order=dc \
    -netdev user,id=net0,hostfwd=tcp::8080-:80,hostfwd=tcp::9090-:9090,hostfwd=tcp::2222-:22 \
    -device virtio-net-pci,netdev=net0 \
    -vga virtio \
    -display gtk \
    -rtc base=localtime \
    2>/dev/null
