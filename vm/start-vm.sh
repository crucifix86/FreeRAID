#!/usr/bin/env bash
# Start the FreeRAID test VM (after initial install)

VM_DIR="$(cd "$(dirname "$0")" && pwd)/disks"
VM_NAME="freeraid-test"

VM_IP=192.168.1.150
TAP=vmtap0

# Check TAP is set up
if ! ip link show "$TAP" &>/dev/null; then
    echo "ERROR: TAP interface $TAP not found."
    echo "Run first:  sudo $(dirname "$0")/setup-vm-network.sh"
    echo ""
    echo "Falling back to NAT (Cockpit: http://localhost:9090, SSH: ssh root@localhost -p 2222)"
    NETDEV="-netdev user,id=net0,hostfwd=tcp::8080-:80,hostfwd=tcp::9090-:9090,hostfwd=tcp::2222-:22"
else
    echo "==> Using TAP networking ($TAP)"
    NETDEV="-netdev tap,id=net0,ifname=$TAP,script=no,downscript=no"
    VM_IP_MSG="$VM_IP"
fi

echo "==> Starting FreeRAID VM"
if [ -n "$VM_IP_MSG" ]; then
    echo "    Web UI: http://$VM_IP:9090"
    echo "    SSH:    ssh root@$VM_IP"
else
    echo "    Web UI: http://localhost:9090"
    echo "    SSH:    ssh root@localhost -p 2222"
fi
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
    $NETDEV \
    -device virtio-net-pci,netdev=net0 \
    -vga virtio \
    -display gtk \
    -rtc base=localtime \
    2>/dev/null
