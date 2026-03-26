#!/usr/bin/env bash
# Set up TAP + proxy ARP so the VM gets its own IP on the local network.
# Run this BEFORE start-vm.sh (requires sudo).

TAP=vmtap0
VM_IP=192.168.1.150
HOST_IF=wlo1

set -e

echo "==> Creating TAP interface $TAP"
ip tuntap add dev "$TAP" mode tap user "$(logname 2>/dev/null || whoami)"
ip link set "$TAP" up

echo "==> Enabling IP forwarding"
echo 1 > /proc/sys/net/ipv4/ip_forward

echo "==> Enabling proxy ARP on $HOST_IF and $TAP"
echo 1 > /proc/sys/net/ipv4/conf/"$HOST_IF"/proxy_arp
echo 1 > /proc/sys/net/ipv4/conf/"$TAP"/proxy_arp

echo "==> Adding route: $VM_IP -> $TAP"
ip route add "$VM_IP"/32 dev "$TAP"

echo ""
echo "Network ready. VM should use:"
echo "  IP:      $VM_IP"
echo "  Netmask: 255.255.255.0"
echo "  Gateway: 192.168.1.1"
echo "  DNS:     192.168.1.1"
echo ""
echo "Inside the VM, run (once):"
echo "  ip addr add $VM_IP/24 dev ens3 && ip route add default via 192.168.1.1"
echo "Or apply the netplan config in vm/vm-netplan.yaml"
