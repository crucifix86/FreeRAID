#!/usr/bin/env python3
"""
unraid-import.py — Import Unraid config from an existing USB drive/config folder
Converts Unraid's disk.cfg, share configs, and Docker templates to FreeRAID format.

Usage:
    python3 unraid-import.py /path/to/unraid/config  [--out freeraid.conf.json]
    python3 unraid-import.py /dev/sdX               [--out freeraid.conf.json]  (auto-mounts)
"""

import argparse
import json
import os
import re
import sys
import tempfile
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path


# ── Unraid config parsers ───────────────────────────────────────────────────────

def parse_cfg(path: Path) -> dict:
    """Parse Unraid's KEY="VALUE" or KEY[N]="VALUE" style .cfg files.

    Unraid uses array syntax for most of network.cfg / disk.cfg
    (IFNAME[0], IPADDR[0], BRNAME[0], …). The original regex only
    matched bareword keys so the entire network and per-disk config
    was silently dropped on import. We now collapse the first slot
    (`KEY[0]`) onto the bareword `KEY` — so call sites already doing
    `cfg.get('IFNAME')` start working — and keep higher slots as
    `KEY[1]`, `KEY[2]`, … for callers that want the rest."""
    result = {}
    if not path.exists():
        return result
    for line in path.read_text(errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        # Allow . in keys so per-disk fields like `diskSpindownDelay.1`
        # (used throughout disk.cfg) survive the parse.
        m = re.match(r'^([\w.]+)(?:\[(\d+)\])?="?([^"]*)"?$', line)
        if m:
            key, idx, val = m.group(1), m.group(2), m.group(3)
            if idx is None or idx == '0':
                result[key] = val
            else:
                result[f'{key}[{idx}]'] = val
    return result


def parse_super_dat(path: Path) -> list:
    """Parse Unraid's binary super.dat.
    Layout: 128-byte header, then 128-byte slot records.
    Per slot:
      +0x08 u32 slot number (0=parity, 1..=data)
      +0x0C u32 status (7 = DISK_OK, 0 = empty)
      +0x18..+0x58 disk id (null-terminated ascii, e.g. ST18000NM003D-3DL103_ZVTAZGL6)
    """
    if not path.exists():
        return []
    data = path.read_bytes()
    slots = []
    for off in range(0x80, len(data), 0x80):
        rec = data[off:off + 0x80]
        if len(rec) < 0x58:
            break
        slot_num = int.from_bytes(rec[0x08:0x0C], 'little')
        status   = int.from_bytes(rec[0x0C:0x10], 'little')
        disk_id  = rec[0x18:0x58].split(b'\x00', 1)[0].decode('ascii', errors='replace')
        if status == 7 and disk_id:
            slots.append({'slot': slot_num, 'status': status, 'disk_id': disk_id})
    return slots


def id_to_bypath(disk_id: str) -> str:
    """Best-effort /dev/disk/by-id/ path from Unraid's serial-style disk_id."""
    # NVMe ids in /dev/disk/by-id/ look like: nvme-<MODEL>_<SERIAL>
    # Unraid stores them in that exact form for NVMe, so we detect common vendor prefixes.
    nvme_markers = ('WD_BLACK', 'WDS', 'Samsung_SSD', 'SAMSUNG_', 'KINGSTON_',
                    'Sabrent', 'Crucial_', 'SPCC_', 'Seagate_FireCuda', 'nvme-')
    if any(disk_id.startswith(m) for m in nvme_markers):
        return f'/dev/disk/by-id/nvme-{disk_id}'
    return f'/dev/disk/by-id/ata-{disk_id}'


def import_cache_pools(config_dir: Path) -> list:
    """Read pools/*.cfg — each pool is one cache/extra pool with one or more disks."""
    pools_dir = config_dir / 'pools'
    if not pools_dir.exists():
        return []
    cache = []
    for cfg_file in sorted(pools_dir.glob('*.cfg')):
        p = parse_cfg(cfg_file)
        name = cfg_file.stem
        disk_id = p.get('diskId', '')
        if not disk_id:
            continue
        bypath = id_to_bypath(disk_id)
        cache.append({
            "slot": name,
            "device": f'{bypath}-part1',  # existing btrfs lives on partition 1
            "mountpoint": f'/mnt/{name}',
            "fstype": p.get('diskFsType', 'btrfs'),
            "label": name.capitalize(),
            "enabled": True,
            "serial": disk_id,
        })
    return cache


def import_disks(config_dir: Path) -> dict:
    """Build FreeRAID array config from Unraid's super.dat (array) + pools/ (cache)."""
    super_slots = parse_super_dat(config_dir / 'super.dat')

    parity = []
    disks = []

    for s in super_slots:
        bypath = id_to_bypath(s['disk_id'])
        if s['slot'] == 0:
            # Parity gets reformatted for snapraid — use whole-disk symlink, no -part1
            parity.append({
                "slot": "parity",
                "device": bypath,
                "mountpoint": "/mnt/parity",
                "fstype": "xfs",
                "label": "Parity",
                "serial": s['disk_id'],
            })
        else:
            n = s['slot']
            # Data disks keep their existing XFS on partition 1 (Unraid's layout)
            disks.append({
                "slot": f'disk{n}',
                "device": f'{bypath}-part1',
                "mountpoint": f'/mnt/disk{n}',
                "fstype": "xfs",
                "label": f'Disk {n}',
                "enabled": True,
                "serial": s['disk_id'],
            })

    cache = import_cache_pools(config_dir)
    return {"parity": parity, "disks": disks, "cache": cache}


def import_disk_settings(config_dir: Path) -> dict:
    """Read Unraid disk.cfg → per-disk + array-wide tuning.

    Returns {
        'default_fs_type': 'xfs',
        'spindown_default': 0,
        'shutdown_timeout': 90,
        'per_disk': { '<slot_int>': {'spindown': int, 'warning': str, 'critical': str, 'fstype': str} },
    }
    """
    d = parse_cfg(config_dir / 'disk.cfg')
    per_disk = {}
    # Unraid stores per-disk settings with .N suffix (diskSpindownDelay.0, ...).
    # parse_cfg keeps these as-is because we only collapse [N] not .N.
    for k, v in d.items():
        if '.' not in k:
            continue
        base, _, idx = k.rpartition('.')
        if not idx.isdigit():
            continue
        slot = int(idx)
        per_disk.setdefault(slot, {})
        if base == 'diskSpindownDelay':
            try: per_disk[slot]['spindown'] = int(v)
            except ValueError: pass
        elif base == 'diskWarning':
            per_disk[slot]['warning'] = v
        elif base == 'diskCritical':
            per_disk[slot]['critical'] = v
        elif base == 'diskFsType':
            per_disk[slot]['fstype'] = v
        elif base == 'diskComment' and v:
            per_disk[slot]['comment'] = v

    return {
        'default_fs_type': d.get('defaultFsType', 'xfs'),
        'spindown_default': int(d.get('spindownDelay', '0') or 0),
        'shutdown_timeout': int(d.get('shutdownTimeout', '90') or 90),
        'per_disk': per_disk,
    }


def import_docker_settings(config_dir: Path) -> dict:
    """Read Unraid docker.cfg → FreeRAID docker section.

    Honours the user's APP_CONFIG_PATH (commonly /mnt/user/appdata/ lowercase)
    instead of our previous hardcoded /mnt/user/Appdata/docker with capital A.
    docker.img path/size are recorded but unused — FreeRAID uses overlay2."""
    d = parse_cfg(config_dir / 'docker.cfg')
    app_path = (d.get('DOCKER_APP_CONFIG_PATH') or '/mnt/user/appdata/').rstrip('/')
    return {
        'enabled':      d.get('DOCKER_ENABLED', 'yes').lower() == 'yes',
        'data_root':    f'{app_path}/docker',
        'compose_dir':  f'{app_path}/compose',
        'log_rotation': d.get('DOCKER_LOG_ROTATION', 'yes').lower() == 'yes',
        'log_size':     d.get('DOCKER_LOG_SIZE', '50m'),
        'log_files':    int(d.get('DOCKER_LOG_FILES', '1') or 1),
        '_unraid_docker_img':      d.get('DOCKER_IMAGE_FILE', ''),
        '_unraid_docker_img_size': d.get('DOCKER_IMAGE_SIZE', ''),
    }


def import_network(config_dir: Path) -> dict:
    """Read Unraid network.cfg → FreeRAID network config."""
    net = parse_cfg(config_dir / 'network.cfg')

    return {
        "interface": net.get('IFNAME', 'eth0'),
        "dhcp": net.get('USE_DHCP', 'yes').lower() == 'yes',
        "ip":      net.get('IPADDR', ''),
        "netmask": net.get('NETMASK', ''),
        "gateway": net.get('GATEWAY', ''),
        "dns": [d for d in [net.get('DNS_SERVER1', ''), net.get('DNS_SERVER2', '')] if d],
        "bridge":  net.get('BRNAME', ''),
        "bond":    net.get('BONDNAME', ''),
        "bond_mode":  net.get('BONDING_MODE', ''),
        "bond_nics":  net.get('BONDNICS', ''),
    }


def import_system(config_dir: Path) -> dict:
    """Read Unraid ident.cfg → FreeRAID system identity + Samba/NTP/web."""
    ident = parse_cfg(config_dir / 'ident.cfg')
    return {
        "hostname":  ident.get('NAME', 'freeraid'),
        "timezone":  ident.get('timeZone', 'UTC'),
        "comment":   ident.get('COMMENT', ''),
        "workgroup": ident.get('WORKGROUP', 'WORKGROUP'),
        "ntp_servers": [
            s for s in (ident.get(f'NTP_SERVER{i}', '') for i in range(1, 5)) if s
        ],
        "use_ntp":   ident.get('USE_NTP', 'yes').lower() == 'yes',
        "use_ssl":   ident.get('USE_SSL', 'no').lower() == 'yes',
        "use_ssh":   ident.get('USE_SSH', 'yes').lower() == 'yes',
        "web_port":      ident.get('PORT', '80'),
        "web_port_ssl":  ident.get('PORTSSL', '443'),
        "ssh_port":      ident.get('PORTSSH', '22'),
        "local_tld":     ident.get('LOCAL_TLD', 'local'),
    }


def import_shares(config_dir: Path) -> list:
    """Read share configs from config/shares/*.cfg using real Unraid field names."""
    shares = []
    shares_dir = config_dir / 'shares'
    if not shares_dir.exists():
        return shares

    for share_file in sorted(shares_dir.glob('*.cfg')):
        s = parse_cfg(share_file)
        name = share_file.stem

        # shareExport: "e" = enabled, "-" = disabled
        smb_enabled = s.get('shareExport', 'e') == 'e'
        smb_security = s.get('shareSecurity', 'public')   # public / secure / private
        smb_read_list  = [u for u in s.get('shareReadList', '').split(',') if u]
        smb_write_list = [u for u in s.get('shareWriteList', '').split(',') if u]

        # shareExportNFS: "-" = disabled, anything else = enabled
        nfs_enabled = s.get('shareExportNFS', '-') != '-'

        # shareUseCache: "yes" / "no" / "prefer" / "only"
        cache_mode = s.get('shareUseCache', 'yes')

        # cache pool name (appdata uses "prefer" + specific pool)
        cache_pool = s.get('shareCachePool', 'cache')

        include_disks = [d for d in s.get('shareInclude', '').split(',') if d]
        exclude_disks = [d for d in s.get('shareExclude', '').split(',') if d]

        shares.append({
            "name": name,
            "path": f'/mnt/user/{name}',
            "comment": s.get('shareComment', ''),
            "smb_enabled": smb_enabled,
            "smb_security": smb_security,
            "smb_read_list": smb_read_list,
            "smb_write_list": smb_write_list,
            "nfs_enabled": nfs_enabled,
            "nfs_security": s.get('shareSecurityNFS', 'public'),
            "cache_mode": cache_mode,
            "cache_pool": cache_pool,
            "allocator": s.get('shareAllocator', 'highwater'),
            "split_level": s.get('shareSplitLevel', ''),
            "include_disks": include_disks,
            "exclude_disks": exclude_disks,
            "cow": s.get('shareCOW', 'auto'),
            "_imported_from_unraid": True
        })

    return shares


def import_docker_templates(config_dir: Path, only: set | None = None) -> list:
    """Convert Unraid Docker XML templates to compose-compatible app entries.
    If `only` is provided, templates whose <Name> isn't in that set are skipped."""
    templates_dir = config_dir / 'plugins' / 'dockerMan' / 'templates-user'
    if not templates_dir.exists():
        templates_dir = config_dir / 'docker'

    apps = []
    if not templates_dir.exists():
        return apps

    for xml_file in sorted(templates_dir.glob('*.xml')):
        try:
            tree = ET.parse(xml_file)
            root = tree.getroot()

            name     = root.findtext('Name', xml_file.stem)
            if only is not None and name not in only:
                continue
            image    = root.findtext('Repository', '')
            overview = root.findtext('Overview', '')
            network  = root.findtext('Network', 'bridge')
            priv     = root.findtext('Privileged', 'false').lower() == 'true'
            webui    = (root.findtext('WebUI', '') or '').strip()
            icon     = (root.findtext('Icon', '') or '').strip()

            # ExtraParams is Unraid's catch-all for raw `docker run` flags.
            # Plex/Jellyfin/Frigate/Ollama all use it for `--runtime=nvidia
            # --gpus=all`; skipping it dropped GPU access on import (#17).
            # Translate runtime/gpus to compose `runtime: nvidia`; flag any
            # other flags so the user can port them deliberately.
            extra_params = (root.findtext('ExtraParams', '') or '').strip()
            nvidia_runtime = False
            unhandled_extra = []
            if extra_params:
                tokens = extra_params.split()
                i = 0
                while i < len(tokens):
                    t = tokens[i]
                    if t == '--runtime=nvidia' or (t == '--runtime' and i+1 < len(tokens) and tokens[i+1] == 'nvidia'):
                        nvidia_runtime = True
                        i += 2 if t == '--runtime' else 1
                    elif t.startswith('--gpus'):
                        # `--gpus=all` or `--gpus all` → same as nvidia runtime
                        nvidia_runtime = True
                        i += 2 if t == '--gpus' else 1
                    else:
                        unhandled_extra.append(t)
                        i += 1

            env_vars = {}
            for env in root.findall('Config[@Type="Variable"]'):
                k = env.get('Target', '')
                v = env.text or ''
                if k:
                    env_vars[k] = v

            ports = []
            for port in root.findall('Config[@Type="Port"]'):
                host  = port.text or ''
                guest = port.get('Target', '')
                proto = port.get('Protocol', 'tcp').lower()
                if host and guest:
                    ports.append(f'{host}:{guest}/{proto}')

            volumes = []
            for vol in root.findall('Config[@Type="Path"]'):
                host  = vol.text or ''
                guest = vol.get('Target', '')
                mode  = 'rw' if vol.get('Mode', 'rw') == 'rw' else 'ro'
                if host and guest:
                    volumes.append(f'{host}:{guest}:{mode}')

            apps.append({
                "name": name,
                "image": image,
                "overview": overview,
                "webui": webui,
                "icon": icon,
                "network_mode": network,
                "privileged": priv,
                "environment": env_vars,
                "ports": ports,
                "volumes": volumes,
                "restart": "unless-stopped",
                "nvidia_runtime": nvidia_runtime,
                "extra_params_unhandled": unhandled_extra,
                "_imported_from_unraid_template": xml_file.name
            })
            if unhandled_extra:
                print(f"  Note: {name} has unhandled ExtraParams (no compose equivalent): "
                      f"{' '.join(unhandled_extra)}", file=sys.stderr)

        except ET.ParseError as e:
            print(f"  Warning: could not parse {xml_file.name}: {e}", file=sys.stderr)

    return apps


def _build_cache_share_map(shares: list) -> dict:
    """Map share-name → /mnt/cache/<name> for shares that prefer/only on cache.
    mergerfs + SQLite doesn't mix (disk I/O errors on sonarr/radarr/plex DBs),
    so container volumes touching these shares are rewritten to bypass the
    mergerfs pool. This is how Unraid's shfs effectively behaves."""
    m = {}
    for s in shares:
        if s.get('cache_mode') in ('prefer', 'only'):
            m[s['name']] = f"/mnt/cache/{s['name']}"
    return m


def _rewrite_volume(vol_spec: str, share_map: dict) -> str:
    """Rewrite `host:guest:mode` replacing /mnt/user/<share>/... → /mnt/cache/<share>/..."""
    if not share_map or not vol_spec.startswith('/mnt/user/'):
        return vol_spec
    # vol_spec is "host:guest:mode" — only rewrite host half
    parts = vol_spec.split(':')
    host = parts[0]
    rest = parts[1:]
    # host looks like /mnt/user/<share>[/subpath]
    tail = host[len('/mnt/user/'):]
    if '/' in tail:
        share, sub = tail.split('/', 1)
        new_prefix = share_map.get(share)
        if new_prefix:
            host = f'{new_prefix}/{sub}'
    else:
        share = tail
        new_prefix = share_map.get(share)
        if new_prefix:
            host = new_prefix
    return ':'.join([host] + rest)


def write_compose_files(apps: list, output_dir: Path, share_map: dict | None = None):
    """Generate docker-compose.yml files for each imported app."""
    output_dir.mkdir(parents=True, exist_ok=True)
    share_map = share_map or {}

    for app in apps:
        name = re.sub(r'[^a-z0-9_-]', '-', app['name'].lower())
        compose = {
            "version": "3.8",
            "services": {
                name: {
                    "image": app["image"],
                    "container_name": name,
                    "restart": app["restart"],
                    "network_mode": app.get("network_mode", "bridge"),
                }
            }
        }
        svc = compose["services"][name]

        if app.get("privileged"):
            svc["privileged"] = True
        if app.get("environment"):
            svc["environment"] = app["environment"]
        if app.get("ports"):
            svc["ports"] = app["ports"]
        if app.get("volumes"):
            svc["volumes"] = [_rewrite_volume(v, share_map) for v in app["volumes"]]
        # `runtime: nvidia` is honored by `docker compose up` when the nvidia
        # runtime is registered in /etc/docker/daemon.json (which freeraid's
        # cmd_nvidia_install does). The NVIDIA_VISIBLE_DEVICES /
        # NVIDIA_DRIVER_CAPABILITIES env vars are already flowing through the
        # generic environment passthrough above.
        if app.get("nvidia_runtime"):
            svc["runtime"] = "nvidia"

        # Labels for the FreeRAID web UI — the core reads freeraid.webui off
        # the container's Config.Labels to render the "Open Web UI" button.
        labels = {}
        if app.get("webui"):
            labels["freeraid.webui"] = app["webui"]
        if app.get("icon"):
            labels["freeraid.icon"] = app["icon"]
        if labels:
            svc["labels"] = labels

        out_file = output_dir / f'{name}.docker-compose.yml'
        # Write as YAML-ish JSON (proper YAML writer not always available)
        out_file.write_text(json.dumps(compose, indent=2))
        print(f"  Wrote {out_file.name}")


# ── Main ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Import Unraid config to FreeRAID format')
    parser.add_argument('source', help='Path to Unraid config directory or USB device (e.g. /dev/sdb)')
    parser.add_argument('--out', default='freeraid.conf.json', help='Output config file path')
    parser.add_argument('--compose-dir', default='./compose', help='Output directory for docker-compose files')
    parser.add_argument('--only-running', default='',
                        help='Comma-separated container names to include (from `docker ps`). '
                             'Other templates are skipped. Empty = import all templates.')
    parser.add_argument('--only-running-file', default='',
                        help='Path to a file with one container name per line (lines starting '
                             "with # are ignored). Equivalent to --only-running but reads from "
                             'disk so the active-set can ride along in the backup. Merges with '
                             '--only-running if both are given.')
    parser.add_argument('--skip-parity', action='store_true',
                        help="Don't import the parity disk. Use this to test-boot FreeRAID "
                             "without wiping Unraid's parity — you can reboot back to Unraid "
                             "without a full parity rebuild. The array runs unprotected "
                             "(data + cache only) until you add parity later. Has no effect "
                             "when --parity-method=nonraid, because NonRAID reads Unraid's "
                             "super.dat verbatim and never formats anything.")
    parser.add_argument('--parity-method', choices=['snapraid', 'nonraid'],
                        default='snapraid',
                        help="Parity strategy in the produced config. 'snapraid' (default) "
                             "writes the parity entry with fstype=xfs (SnapRAID will format "
                             "it on start). 'nonraid' marks fstype=raw (NonRAID's md driver "
                             "uses the device directly via super.dat — no formatting), and "
                             "honours --skip-parity as a no-op so the parity stays visible "
                             "in `freeraid status`. Also sets array.parity_method in the "
                             "output config.")
    args = parser.parse_args()

    only_set = {n.strip() for n in args.only_running.split(',') if n.strip()}
    if args.only_running_file:
        try:
            with open(args.only_running_file) as fh:
                for line in fh:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        only_set.add(line)
        except OSError as e:
            print(f"Warning: could not read --only-running-file {args.only_running_file}: {e}",
                  file=sys.stderr)
    only_set = only_set or None

    source = Path(args.source)
    mounted_tmp = None

    # Auto-mount block device
    if source.is_block_device() or str(source).startswith('/dev/'):
        print(f"Block device detected: {source}")
        mounted_tmp = tempfile.mkdtemp(prefix='freeraid-import-')
        print(f"Mounting {source}1 → {mounted_tmp}...")
        subprocess.run(['mount', '-o', 'ro', f'{source}1', mounted_tmp], check=True)
        config_dir = Path(mounted_tmp) / 'config'
    else:
        config_dir = source

    if not config_dir.exists():
        print(f"Error: config directory not found at {config_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"\nImporting from: {config_dir}")
    print("─" * 50)

    try:
        # Parse all Unraid configs
        print("Reading disk config...")
        array_cfg = import_disks(config_dir)
        # For nonraid the parity disk is never reformatted (the md driver
        # reads Unraid's super.dat directly), so --skip-parity stays a
        # safety flag for *snapraid* test boots only. Under nonraid we keep
        # the parity entry in config so `freeraid status` reflects what
        # nmdctl actually has, and we mark fstype=raw so no part of the
        # stack tries to mount/format it.
        if args.parity_method == 'nonraid':
            for p in array_cfg['parity']:
                p['fstype'] = 'raw'
        elif args.skip_parity and array_cfg['parity']:
            print(f"  --skip-parity: dropping {len(array_cfg['parity'])} parity drive(s) "
                  f"(Unraid parity left untouched — array will run unprotected)")
            array_cfg['parity'] = []
        parity_count = len(array_cfg['parity'])
        disk_count   = len(array_cfg['disks'])
        cache_count  = len(array_cfg['cache'])
        print(f"  Found: {parity_count} parity, {disk_count} data, {cache_count} cache drives")

        print("Reading network config...")
        net_cfg = import_network(config_dir)
        sys_cfg = import_system(config_dir)
        addr = net_cfg['ip'] if not net_cfg['dhcp'] and net_cfg['ip'] else ('DHCP' if net_cfg['dhcp'] else '<unset>')
        print(f"  Hostname: {sys_cfg['hostname']}, addr: {addr}, iface: {net_cfg['interface']}, tz: {sys_cfg['timezone']}")

        print("Reading disk + docker settings...")
        disk_tuning = import_disk_settings(config_dir)
        dock_cfg = import_docker_settings(config_dir)
        print(f"  defaultFsType: {disk_tuning['default_fs_type']}, per-disk tuning for {len(disk_tuning['per_disk'])} slots, docker data_root: {dock_cfg['data_root']}")

        # Fold per-disk tuning into the array.disks[] entries built from super.dat
        for entry in array_cfg['disks']:
            try:
                slot_int = int(entry['slot'].replace('disk', ''))
            except (ValueError, AttributeError):
                continue
            t = disk_tuning['per_disk'].get(slot_int) or {}
            if 'spindown' in t and t['spindown'] >= 0:
                entry['spindown_minutes'] = t['spindown']
            for k in ('warning', 'critical', 'fstype', 'comment'):
                if t.get(k):
                    entry[k if k != 'fstype' else 'fstype_unraid'] = t[k]

        print("Reading shares...")
        shares = import_shares(config_dir)
        print(f"  Found {len(shares)} shares")

        print("Reading Docker templates...")
        apps = import_docker_templates(config_dir, only=only_set)
        if only_set:
            print(f"  Filtering to running set: {sorted(only_set)}")
        print(f"  Found {len(apps)} Docker apps")

        if apps:
            share_map = _build_cache_share_map(shares)
            if share_map:
                print(f"  Cache-preferred shares (bypass mergerfs): {sorted(share_map.keys())}")
            print(f"Writing docker-compose files to {args.compose_dir}/")
            write_compose_files(apps, Path(args.compose_dir), share_map=share_map)

        # Build FreeRAID config
        freeraid_conf = {
            "_version": "1",
            "_schema": "freeraid-config",
            "_imported_from_unraid": True,

            "system": {
                "hostname":  sys_cfg['hostname'],
                "timezone":  sys_cfg['timezone'],
                "language":  "en_US",
                "comment":   sys_cfg['comment'],
                "workgroup": sys_cfg['workgroup'],
                "ntp_servers": sys_cfg['ntp_servers'],
                "use_ntp":   sys_cfg['use_ntp'],
                "web_port":  sys_cfg['web_port'],
                "ssh_port":  sys_cfg['ssh_port'],
            },

            "array": {
                "state": "stopped",
                "parity":          array_cfg['parity'],
                "disks":           array_cfg['disks'],
                "cache":           array_cfg['cache'],
                "pool_mountpoint": "/mnt/user",
                "default_fs_type": disk_tuning['default_fs_type'],
                "shutdown_timeout": disk_tuning['shutdown_timeout'],
                "mergerfs_options": "defaults,allow_other,cache.files=partial,dropcacheonclose=true,category.create=mfs,moveonenospc=true,minfreespace=200M",
                "parity_method":    args.parity_method
            },

            "snapraid": {
                "sync_schedule":       "0 3 * * *",
                "scrub_schedule":      "0 4 * * 0",
                "scrub_percent":       22,
                "scrub_age":           10,
                "diff_warn_deleted":   40,
                "diff_warn_updated":   40,
                "content_files":       [],
                "exclude":             ["/lost+found/", "*.tmp", "*.!qB", "*.part"]
            },

            "shares": shares,

            "network": net_cfg,

            "docker": dock_cfg,

            "_docker_apps": apps
        }

        out = Path(args.out)
        out.write_text(json.dumps(freeraid_conf, indent=2))
        print(f"\n✓ FreeRAID config written to: {out}")

        print("\nSummary:")
        print(f"  Parity drives : {parity_count}")
        print(f"  Data drives   : {disk_count}")
        print(f"  Cache drives  : {cache_count}")
        print(f"  Shares        : {len(shares)}")
        print(f"  Docker apps   : {len(apps)}")
        print(f"\nNext steps:")
        print(f"  1. Review {out} and adjust device paths if needed")
        print(f"  2. Copy to /boot/config/freeraid.conf.json")
        print(f"  3. Run: freeraid start")

    finally:
        if mounted_tmp:
            subprocess.run(['umount', mounted_tmp], check=False)
            os.rmdir(mounted_tmp)


if __name__ == '__main__':
    main()
