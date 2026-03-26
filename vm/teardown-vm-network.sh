#!/usr/bin/env bash
# Tear down the VM TAP interface. Run after stopping the VM.

TAP=vmtap0
VM_IP=192.168.1.150
HOST_IF=wlo1

iptables -D FORWARD -i "$TAP" -o "$HOST_IF" -j ACCEPT 2>/dev/null || true
iptables -D FORWARD -i "$HOST_IF" -o "$TAP" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
iptables -t nat -D POSTROUTING -s "$VM_IP"/32 -o "$HOST_IF" -j MASQUERADE 2>/dev/null || true

ip route del "$VM_IP"/32 dev "$TAP" 2>/dev/null || true
ip link set "$TAP" down 2>/dev/null || true
ip tuntap del dev "$TAP" mode tap 2>/dev/null || true

echo "==> $TAP removed"
