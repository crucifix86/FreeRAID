# Known Bugs

Captured from the 2026-05-29/30 overnight POUGHKEEPSIE deployment session.
Numbering matches the session's task IDs; renumber freely when promoting to
GitHub issues.

---

## Persistence / boot-time state

### 10 — Imported hostname not reapplied on every boot
Importer writes `.system.hostname` to `freeraid.conf.json` but firstboot is
gated by `.unraid-imported` so it only fires once. On reboot the live overlay
wipes `/etc/hostname` and the box reverts to the build-time default `freeraid`.
**Fix**: enforce hostname at every array start (top of `cmd_start`, before the
parity_method dispatch): `freeraid set-hostname $(jq -r .system.hostname $CONFIG_FILE)`.

### 18 — cmd_start_nonraid doesn't configure docker data-root / storage-driver
`build-image.sh` writes `/etc/docker/daemon.json` with `storage-driver: vfs` at
image-build time (no array disk yet). The snapraid `cmd_start` switches Docker
to overlay2 at `/mnt/disk1/appdata/docker` once the array is up. NonRAID's path
never got the equivalent — Docker stayed on vfs against `/var/lib/docker` (the
live overlay), pulls filled overlay → ENOSPC. Worked around manually with:
`jq ". + {\"data-root\":\"/mnt/cache/appdata/docker\", \"storage-driver\":\"overlay2\"}" /etc/docker/daemon.json`.
**Fix**: cmd_start_nonraid should write daemon.json + `systemctl restart docker`
after the cache is mounted. Honor `docker.cfg`'s DOCKER_IMAGE_FILE if importer
detected an existing `/mnt/cache/system/docker/docker.img` (commit `740ab1f`
pattern for snapraid path).

### 21 — cmd_start_nonraid cache mount race vs NVMe by-id ready
On POUGHKEEPSIE boot 2, freeraid-array.service fired cmd_start_nonraid before
`/dev/disk/by-id/nvme-WD_BLACK_SN770_2TB_25143A802996-part1` was ready. Cache
mount silently skipped, mergerfs came up as disk1:disk2:disk3 (no cache), no
appdata bind, docker containers had nothing. Recovery: manual mount + remount
mergerfs.
**Fix**: cmd_start_nonraid should `udevadm settle` before the `[ -b $cache_dev ]`
check, OR retry with backoff (5× at 1s). NVMe enumeration via udev can lag SATA
significantly on AMD platforms with many PCIe devices.

---

## Image build / distribution

### 20 — Switch image build off squashfs+toram to cpio→tmpfs (Unraid pattern)
Current: Debian live-boot with xz-compressed `filesystem.squashfs` + `toram`.
Pages decompress on every read from the in-RAM squashfs. A single bit-flip in
non-ECC RAM corrupts a compressed block → decompression CRC fails → kernel
returns -EIO. Hit tonight when `/usr/bin/containerd` became unreadable
mid-session and the entire docker stack collapsed (`md5sum: Input/output error`).
Unraid avoids this by extracting its gzipped cpio root (`bzroot`) to plain
tmpfs at boot — once extracted, files are uncompressed plain bytes, bit-flips
at worst give weird content (not an error).
**Fix**: rebuild as `cpio.gz` like Unraid; initramfs extracts directly to / on
tmpfs; drop live-boot dependency. Cost: ~1-2× RAM at boot for uncompressed
image. Major `scripts/build-image.sh` refactor.

### 22 — Every committed fix requires re-squashfs + re-burn USB to land
Workflow gap that cost most of tonight. Live-patch via scp dies on next reboot
(rootfs is on the live overlay tmpfs). Every commit AFTER the user's burned
USB needs to be re-baked or it's invisible to the running system. Tonight:
8c0caa5, efe001e, a6e3c5c, fa14274, 7e12df1, 444988f — all of these reverted on
reboot because the squashfs on the USB was from build7 (before them).
**Fix**: pick one — (a) document the "commit → re-squash → re-burn" loop in
CONTRIBUTING; (b) `scripts/update-running-usb.sh` that takes a live USB device
+ the local rootfs and rewrites just `/live/filesystem.squashfs` in-place;
(c) `/boot/config/updates/` dir that gets unpacked over the live rootfs on
every boot (Unraid plugin pattern). (c) is the closest to Unraid's UX.

---

## Network

### 11 — `cmd_network_set` writes to dead `/etc/network/interfaces` path
After `d00a70b` purged ifupdown, the existing UI Network panel command writes
to a file nothing reads and tries to call `ifup`/`ifdown` which don't exist.
UI's "Apply" silently no-ops.
**Fix**: rewrite cmd_network_set to call cmd_network_apply_config, or write
20-wired.network directly.

### 24 — cmd_network_apply_config doesn't clean stale `.network` files before writing
On POUGHKEEPSIE: the SAME boot got two writes — pre-`8c0caa5` CLI wrote
`Name=eth0` (wrong), then patched CLI wrote `Name=enp34s0`. networkd processed
both, dropped DHCP lease on enp34s0 ("Unmanaging interface"), tried to set up
static on non-existent eth0 → box went off the network. Required IPv6
link-local SSH recovery.
**Fix**: explicit `rm -f /etc/systemd/network/20-wired.network` at start of
cmd_network_apply_config, then write fresh — never accumulate parallel
configs.

### 14 — Firstboot logger-piped network-apply produced no journal output
During QEMU testing (qemu12 boot, before NM purge), firstboot's
`/usr/local/bin/freeraid network-apply-config 2>&1 | logger -t freeraid-firstboot`
ran but produced zero `journalctl -t freeraid-firstboot` entries. Manual
invocation of the same command worked and emitted info() lines. Cause never
identified — possibly pipefail interaction, possibly NM-reload race that
killed the process before flush. Worked around by gating the call on
`! -f .skip-parity`. Re-investigate now that NM is purged.

### 25 — Stale mDNS hostnames (freeraid-2/-40/-263/-269) confuse find-the-box
Every FreeRAID test boot on the LAN registers a new mDNS hostname. avahi-browse
output becomes ~20 lines of stale entries with no way to tell which is the
current box. Imported hostname (POUGHKEEPSIE) isn't applied until after
firstboot, so during the find-the-box window it's still `freeraid-N`.
**Fix**: bake imported hostname into the initial mDNS announce, and/or use a
fixed Device Info host so the entry stays consistent across boots.

---

## Status / dashboard

### 12 — "Last parity sync: never" misleading under NonRAID
`cmd_status_json` reads last_sync from `journalctl -u freeraid-sync` (SnapRAID
nightly timer). NonRAID does parity continuously — no sync event. Shows "Last
parity sync: never" for a NonRAID array → users think parity isn't working.
**Fix**: for parity_method=nonraid, omit the field, replace with "Realtime
(NonRAID)", or pull last array-check time from nmdctl status.

### 15 — nmdctl single-parity reports DEGRADED (Invalid: 1, Disabled: 1)
On a single-parity Unraid array, nmdctl status shows Array Health = DEGRADED
with `Invalid: 1, Disabled: 1` — almost certainly the empty Q-parity (slot 29)
being counted. Single-parity is the common case, not degraded. `freeraid
status` doesn't surface this today so it's invisible, but worth: (a) confirm
Invalid+Disabled is the empty Q slot, (b) decide suppress vs pass-through,
(c) if passed through, distinguish "single-parity by design" from "second
parity failed."

### 23 — Cockpit-wsinstance cgroup TasksMax safety against any hung tool
Tonight's cascade: smartctl on the NonRAID parity disk hangs in kernel
D-state (uninterruptible). Cockpit fires a dashboard status query every
refresh. Each spawns a smartctl. They pile in cockpit-wsinstance-https@
*.service's cgroup. Hits pids.max (~512 default) → cgroup rejects new forks →
Cockpit can't spawn cockpit-bridge → TLS handshake stalls → entire web UI dies.
Fixed the underlying smartctl call in `fa14274`, but the cgroup-cascade
dynamic is its own bug.
**Fix**: drop `/etc/systemd/system/cockpit-wsinstance-https@.service.d/freeraid.conf`
with `[Service] TasksMax=4096`. Also worth: have cmd_status_json emit a
"skipping <N> hung subprocesses" warning instead of blocking.

---

## Containers / Docker

### 16 — Importer pulls all Unraid templates including removed/stale containers
`unraid-import.py` walks `plugins/dockerMan/templates-user/*.xml` and converts
every template regardless of whether the container is currently installed on
Unraid. Stale containers users had to manually delete (firefox, openvpn-client,
sillytavern, ollama tonight).
**Fix**: cross-reference Unraid's running docker state (parse
`plugins/dockerMan/userprefs.cfg` or read `docker.img` containers/json offline)
so importer only ships templates that map to active containers. Alternative:
mtime-based stale detection + UI flag.

### 17 — Importer doesn't translate Unraid template `--runtime=nvidia` / GPU env
Unraid encodes GPU access via the template's `ExtraParams` field
(`--runtime=nvidia --gpus=all`) and Variable nodes for
`NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`. Importer reads
Repository/Network/Privileged/Port/Path/Variable but skips ExtraParams —
runtime + GPU env vars don't land in compose. Result: Plex/Jellyfin imported
from Unraid lose GPU access until we manually re-add. Bundle with #9.

### 19 — `freeraid docker-start` doesn't recreate on compose-file changes
`cmd_docker_start` (commit `f062043`) uses `docker start <name>` when the
container exists, fast path. Falls back to `docker compose up -d` only for
new containers. Compose file edits (Edit panel, importer fixes) are silently
skipped on restart. Detect: compose mtime vs container CreatedAt; if newer,
force `--force-recreate`. Worked around tonight with raw `docker compose up -d
--force-recreate`.

### 13 — cmd_start_nonraid only mounts first cache disk; multi-pool ignored
`cmd_start_nonraid` reads `.array.cache[0]` only. Users with multiple cache
disks or extra named pools (`.pools[]`) get only their first cache mounted
under NonRAID. SnapRAID `cmd_start` already handles multiple via
`cfg_cache_disks` + walks `.pools[]` separately. Mirror that.

---

## NVIDIA

### 8 — cmd_nvidia_install dies on initramfs-tools postinst error
False-positive ERROR after nvidia-container-toolkit because dpkg returns
non-zero from initramfs-tools postinst (live overlay has no `/boot/vmlinuz-*`
to wrap). Actual nvidia + toolkit install succeeded; cmd_nvidia_install's
later steps (nvidia-ctk runtime configure, .nvidia-enabled marker, docker
restart) get skipped. Same pattern as the nvidia-driver block earlier — `||
true` after apt-get + check for the real success signal (`nvidia-ctk` binary
present) rather than dpkg's exit code.

### 9 — Add ich777-style NVIDIA driver plugin / UI
Replace the bare `freeraid nvidia-install` CLI with a proper picker matching
Unraid's ich777/nvidia-driver plugin: UI dropdown for driver version
(535 / 550 / 560 / latest LTS), shows current driver + container-toolkit
version, "Install Now" / "Update" / "Disable" buttons. Settings → Hardware
currently has an install option but no version control. Roadmap §9 only
covers existing binary install; the picker is the gap. Pair with #17.

---

## Tonight's session — context

Built on top of FreeRAID 0.5.4 with 13 commits (`65b1d83` → `fa14274`):
NonRAID realtime parity integration (Phases 1-4), build-host portability
(CachyOS), NM purge for single-network-manager static IPs, importer
completeness pass (array-syntax regex, timezone, disk.cfg, docker.cfg,
ssh/ssl/smart-one carry), and the cmd_status_json hardening against
smartctl D-state traps. Verified end-to-end on POUGHKEEPSIE: NonRAID
parity active on the original Unraid ST18000NM003D, 30T mergerfs pool,
all 16 imported shares, 10/11 containers running with Plex + Jellyfin
hardware-transcoding on the P2000. The work persists; the bugs above are
the follow-up list.
