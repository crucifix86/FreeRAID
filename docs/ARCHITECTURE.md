# FreeRAID Architecture

## Overview

FreeRAID is a Debian-based NAS OS. No accounts, no subscriptions.

```
┌─────────────────────────────────────────────────────┐
│                   Web UI (Cockpit)                  │
│              https://yourserver:9090                │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│              freeraid CLI / daemon                  │
│         /usr/local/bin/freeraid                     │
└──────┬──────────────┬──────────────┬────────────────┘
       │              │              │
┌──────▼──────┐ ┌─────▼──────┐ ┌────▼───────────────┐
│  MergerFS   │ │  SnapRAID  │ │   Docker / Compose  │
│ (disk pool) │ │  (parity)  │ │   (apps)            │
└──────┬──────┘ └─────┬──────┘ └────────────────────┘
       │              │
┌──────▼──────────────▼──────────────────────────────┐
│                Physical Drives                      │
│  parity1   disk1   disk2   disk3   disk4   cache   │
└─────────────────────────────────────────────────────┘
```

## Config File

Single JSON file: `/boot/config/freeraid.conf.json`

- Lives on the boot partition (USB drive or first disk)
- Survives reboots
- Human readable, git-friendly
- Importable from Unraid via `freeraid-import`

## How Parity Works (SnapRAID vs Unraid)

| | Unraid | FreeRAID |
|---|---|---|
| Parity type | Real-time | Batch (scheduled) |
| Write speed | Slower (parity updated live) | Full disk speed |
| Data at risk | Only since last sync | Only since last sync |
| Best for | Frequently changing data | Media / mostly-static data |

Run `freeraid sync` after adding files to update parity.

## Drive Philosophy

Like Unraid, FreeRAID does **not** require reformatting drives.
- Existing XFS/ext4/btrfs drives: just add them
- Mixed drive sizes: fully supported (MergerFS handles it)
- NTFS/exFAT drives from Windows: mount read-only, copy data off first

## Migrating from Unraid

1. Plug in your Unraid USB drive
2. Run: `freeraid-import /dev/sdX --out /boot/config/freeraid.conf.json`
3. Review the generated config (device paths may need adjustment)
4. Run: `freeraid start`

Your data drives are never touched by the import — only the config is read.
Docker templates are converted to docker-compose files automatically.
