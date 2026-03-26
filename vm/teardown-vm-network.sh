#!/usr/bin/env bash
# Tear down the VM TAP interface. Run after stopping the VM.

TAP=vmtap0
VM_IP=192.168.1.150

ip route del "$VM_IP"/32 dev "$TAP" 2>/dev/null || true
ip link set "$TAP" down 2>/dev/null || true
ip tuntap del dev "$TAP" mode tap 2>/dev/null || true

echo "==> $TAP removed"
