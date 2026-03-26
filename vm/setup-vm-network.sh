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

echo "==> Adding iptables rules for VM internet access"
# Forward traffic between TAP and WiFi
iptables -C FORWARD -i "$TAP" -o "$HOST_IF" -j ACCEPT 2>/dev/null || \
    iptables -A FORWARD -i "$TAP" -o "$HOST_IF" -j ACCEPT
iptables -C FORWARD -i "$HOST_IF" -o "$TAP" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
    iptables -A FORWARD -i "$HOST_IF" -o "$TAP" -m state --state RELATED,ESTABLISHED -j ACCEPT
# NAT so the VM's traffic exits via the host's IP
iptables -t nat -C POSTROUTING -s "$VM_IP"/32 -o "$HOST_IF" -j MASQUERADE 2>/dev/null || \
    iptables -t nat -A POSTROUTING -s "$VM_IP"/32 -o "$HOST_IF" -j MASQUERADE

echo "==> Restarting avahi-daemon so it picks up $TAP for mDNS discovery"
systemctl restart avahi-daemon 2>/dev/null || true

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
