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
    """Parse Unraid's KEY="VALUE" style .cfg files."""
    result = {}
    if not path.exists():
        return result
    for line in path.read_text(errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^(\w+)="?([^"]*)"?$', line)
        if m:
            result[m.group(1)] = m.group(2)
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


def import_network(config_dir: Path) -> dict:
    """Read Unraid network.cfg → FreeRAID network config."""
    net = parse_cfg(config_dir / 'network.cfg')
    ident = parse_cfg(config_dir / 'ident.cfg')

    return {
        "interface": net.get('IFNAME', 'eth0'),
        "dhcp": net.get('USE_DHCP', 'yes').lower() == 'yes',
        "ip":      net.get('IPADDR', ''),
        "gateway": net.get('GATEWAY', ''),
        "dns": [d for d in [net.get('DNS_SERVER1', ''), net.get('DNS_SERVER2', '')] if d],
        "_hostname_from_ident": ident.get('NAME', 'freeraid')
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
                "network_mode": network,
                "privileged": priv,
                "environment": env_vars,
                "ports": ports,
                "volumes": volumes,
                "restart": "unless-stopped",
                "_imported_from_unraid_template": xml_file.name
            })

        except ET.ParseError as e:
            print(f"  Warning: could not parse {xml_file.name}: {e}", file=sys.stderr)

    return apps


def write_compose_files(apps: list, output_dir: Path):
    """Generate docker-compose.yml files for each imported app."""
    output_dir.mkdir(parents=True, exist_ok=True)

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
            svc["volumes"] = app["volumes"]

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
    parser.add_argument('--skip-parity', action='store_true',
                        help="Don't import the parity disk. Use this to test-boot FreeRAID "
                             "without wiping Unraid's parity — you can reboot back to Unraid "
                             "without a full parity rebuild. The array runs unprotected "
                             "(data + cache only) until you add parity later.")
    args = parser.parse_args()

    only_set = {n.strip() for n in args.only_running.split(',') if n.strip()} or None

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
        if args.skip_parity and array_cfg['parity']:
            print(f"  --skip-parity: dropping {len(array_cfg['parity'])} parity drive(s) "
                  f"(Unraid parity left untouched — array will run unprotected)")
            array_cfg['parity'] = []
        parity_count = len(array_cfg['parity'])
        disk_count   = len(array_cfg['disks'])
        cache_count  = len(array_cfg['cache'])
        print(f"  Found: {parity_count} parity, {disk_count} data, {cache_count} cache drives")

        print("Reading network config...")
        net_cfg = import_network(config_dir)
        hostname = net_cfg.pop('_hostname_from_ident', 'freeraid')
        print(f"  Hostname: {hostname}, DHCP: {net_cfg['dhcp']}")

        print("Reading shares...")
        shares = import_shares(config_dir)
        print(f"  Found {len(shares)} shares")

        print("Reading Docker templates...")
        apps = import_docker_templates(config_dir, only=only_set)
        if only_set:
            print(f"  Filtering to running set: {sorted(only_set)}")
        print(f"  Found {len(apps)} Docker apps")

        if apps:
            print(f"Writing docker-compose files to {args.compose_dir}/")
            write_compose_files(apps, Path(args.compose_dir))

        # Build FreeRAID config
        freeraid_conf = {
            "_version": "1",
            "_schema": "freeraid-config",
            "_imported_from_unraid": True,

            "system": {
                "hostname": hostname,
                "timezone": "America/Chicago",
                "language": "en_US"
            },

            "array": {
                "state": "stopped",
                "parity":          array_cfg['parity'],
                "disks":           array_cfg['disks'],
                "cache":           array_cfg['cache'],
                "pool_mountpoint": "/mnt/user",
                "mergerfs_options": "defaults,allow_other,cache.files=off,dropcacheonclose=true,category.create=mfs"
            },

            "snapraid": {
                "sync_schedule":       "0 3 * * *",
                "scrub_schedule":      "0 4 * * 0",
                "scrub_percent":       22,
                "scrub_age":           10,
                "diff_warn_deleted":   40,
                "diff_warn_updated":   40,
                "content_files":       [f'/mnt/disk{i+1}/.snapraid.content' for i in range(min(disk_count, 3))],
                "exclude":             ["/lost+found/", "*.tmp", "*.!qB", "*.part"]
            },

            "shares": shares,

            "network": net_cfg,

            "docker": {
                "enabled": True,
                "data_root": "/mnt/user/Appdata/docker",
                "compose_dir": "/mnt/user/Appdata/compose"
            },

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
