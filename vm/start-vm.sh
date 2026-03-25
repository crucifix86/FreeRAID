#!/usr/bin/env bash
# Start the FreeRAID test VM (after initial install)

VM_DIR="$(cd "$(dirname "$0")" && pwd)/disks"
VM_NAME="freeraid-test"

echo "==> Starting FreeRAID VM"
echo "    Web UI will be at: http://localhost:9090"
echo "    SSH:               ssh root@localhost -p 2222"
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
    -boot order=c \
    -netdev user,id=net0,hostfwd=tcp::8080-:80,hostfwd=tcp::9090-:9090,hostfwd=tcp::2222-:22 \
    -device virtio-net-pci,netdev=net0 \
    -vga virtio \
    -display gtk \
    -rtc base=localtime \
    2>/dev/null
