#!/usr/bin/env bash
# FreeRAID post-boot validation — run on POUGHKEEPSIE after booting the new
# USB. Captures the data we need for #15 (nmdctl schema) AND verifies the
# 15 in-tree fixes landed. Output is a single file you can scp back for
# review.
#
# Usage (on POUGHKEEPSIE):
#   bash post-boot-validate.sh
#   scp /tmp/freeraid-validation-*.txt build-host:~/
#
# Idempotent — safe to re-run.

set +e   # we want every section to run even if some fail
OUT="/tmp/freeraid-validation-$(date +%Y%m%d-%H%M%S).txt"

section() {
    echo ""                                              | tee -a "$OUT"
    echo "═══════════════════════════════════════════════"| tee -a "$OUT"
    echo "  $1"                                           | tee -a "$OUT"
    echo "═══════════════════════════════════════════════"| tee -a "$OUT"
}
run() {
    echo "" | tee -a "$OUT"
    echo "$ $*" | tee -a "$OUT"
    eval "$*" 2>&1 | tee -a "$OUT"
}

{
echo "FreeRAID post-boot validation"
echo "Host:        $(hostname)"
echo "Date:        $(date -Iseconds)"
echo "Kernel:      $(uname -r)"
echo "Uptime:      $(uptime -p)"
echo "FreeRAID ver: $(cat /etc/freeraid/VERSION 2>/dev/null || echo '?')"
} | tee "$OUT"

section "#10 — hostname"
run hostname
run cat /etc/hostname
run "jq -r .system.hostname /boot/config/freeraid.conf.json"

section "#25 — mDNS hostname (check avahi is announcing the right name)"
run "systemctl is-active avahi-daemon"
run "ps -C avahi-daemon -o cmd= | head -1"
run "journalctl -u freeraid-set-hostname --no-pager | tail -20"

section "#11 + #24 — networkd config (only one .network, no stale)"
run "ls -la /etc/systemd/network/"
run "cat /etc/systemd/network/20-wired.network 2>/dev/null"
run "networkctl status"

section "#14 — firstboot journal (no silent runs)"
run "journalctl -u freeraid-firstboot.service --no-pager | tail -40"

section "#23 — cockpit-wsinstance TasksMax drop-in"
run "ls -la /etc/systemd/system/cockpit-wsinstance-https@.service.d/"
run "cat /etc/systemd/system/cockpit-wsinstance-https@.service.d/freeraid.conf 2>/dev/null"

section "#21 + #13 — cache + pool mounts"
run "mount | grep -E '/mnt/(cache|disk|user|pool)' | sort"
run "mountpoint /mnt/cache"
run "mountpoint /mnt/user"
run "df -h /mnt/cache /mnt/user 2>/dev/null"

section "#18 — docker daemon.json (data-root on cache, not vfs/overlay tmpfs)"
run "cat /etc/docker/daemon.json"
run "docker info --format 'driver={{.Driver}} root={{.DockerRootDir}}'"
run "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}' | head -20"

section "#12 + #15 — NonRAID parity status (CRITICAL: capture full JSON for #15)"
run "lsmod | grep -E 'nonraid|md_nonraid'"
run "nmdctl status"
run "nmdctl status -o json"
nmdctl status -o json > /tmp/nmdctl-poughkeepsie.json 2>/dev/null
echo "" | tee -a "$OUT"
echo "→ Full JSON also saved to /tmp/nmdctl-poughkeepsie.json (use this for #15 schema)" | tee -a "$OUT"
run "freeraid status"

section "Parity functioning — write test"
echo "→ Writing a small test file to /mnt/user and confirming nmdctl write counters advance" | tee -a "$OUT"
run "nmdctl status -o json 2>/dev/null | jq '.disks[]? | {slot, name, reads, writes}' 2>/dev/null"
TEST_FILE="/mnt/user/freeraid-validation-$(date +%s).txt"
run "echo 'parity test' > $TEST_FILE && sync && ls -la $TEST_FILE"
sleep 2
run "nmdctl status -o json 2>/dev/null | jq '.disks[]? | {slot, name, reads, writes}' 2>/dev/null"
echo "→ Compare reads/writes before vs after — parity slot should show non-zero writes" | tee -a "$OUT"

section "#17 — importer GPU runtime translation (check imported compose files)"
run "ls /etc/freeraid/compose/"
run "grep -l 'runtime: nvidia\\|\"runtime\": \"nvidia\"' /etc/freeraid/compose/*.yml 2>/dev/null"
run "grep -A2 'runtime' /etc/freeraid/compose/plex*.yml 2>/dev/null | head -10"
run "grep -A2 'runtime' /etc/freeraid/compose/jellyfin*.yml 2>/dev/null | head -10"

section "#8 — nvidia-install (no false ERROR, completed steps)"
run "journalctl -u freeraid-nvidia.service --no-pager | tail -30"
run "ls -la /boot/config/.nvidia-enabled 2>/dev/null"
run "command -v nvidia-ctk && nvidia-ctk --version"
run "nvidia-smi 2>&1 | head -10"

section "#9 — NVIDIA backend (drivers-list + parameterized install)"
run "freeraid nvidia-status"
run "freeraid nvidia-drivers-list"
run "type cmd_nvidia_disable 2>/dev/null; grep -c 'nvidia-disable)' /usr/local/bin/freeraid"

section "#20 — uncompressed squashfs"
run "mount | grep squashfs"
run "file /run/live/medium/live/filesystem.squashfs 2>/dev/null || file /lib/live/mount/medium/live/filesystem.squashfs 2>/dev/null"
run "unsquashfs -s /run/live/medium/live/filesystem.squashfs 2>/dev/null | head -10 || unsquashfs -s /lib/live/mount/medium/live/filesystem.squashfs 2>/dev/null | head -10"

section "Boot-time service status"
run "systemctl is-active freeraid-config-mount freeraid-set-hostname freeraid-firstboot freeraid-array freeraid-nvidia avahi-daemon docker cockpit.socket"
run "systemctl --failed --no-pager"

section "Summary"
echo "→ Validation saved to: $OUT" | tee -a "$OUT"
echo "→ #15 NonRAID schema:  /tmp/nmdctl-poughkeepsie.json" | tee -a "$OUT"
echo "→ scp /tmp/freeraid-validation-*.txt /tmp/nmdctl-poughkeepsie.json off the box for review" | tee -a "$OUT"
