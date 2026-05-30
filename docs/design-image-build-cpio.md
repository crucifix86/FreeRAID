# Image build refactor: squashfs → cpio.gz → tmpfs

Design doc for known-bugs.md #20. Captures the full architectural change and
what's blocking execution.

## Status

**Stopgap landed (2026-05-30):** `mksquashfs -noI -noD -noF -noX`. Eliminates
the bit-flip → -EIO cascade by removing per-block compression CRC. RAM cost
roughly 3-4× the previous xz-compressed squashfs (~500 MB → ~2 GB).

**Full refactor:** not started. The work below replaces live-boot + squashfs
with the Unraid pattern: kernel + initramfs + cpio.gz extracted to tmpfs.
Needs design validation + test pass on POUGHKEEPSIE before execution.

## Why

Squashfs (even uncompressed) still lives in a kernel module and is read on
demand from the device-backed mount. The Unraid pattern extracts the root
cpio archive directly into tmpfs at boot — once extraction completes, files
are plain bytes with no filesystem layer between userspace and the page. A
bit-flip degenerates to "this page is wrong"; no module can interpret
it as "this filesystem is corrupt."

This also drops the `live-boot` dependency, simplifies the boot chain, and
matches the reference implementation users coming from Unraid expect.

## Target architecture

```
USB
├── syslinux.cfg          kernel + initramfs + (optional) cpio.gz path
├── vmlinuz               kernel from chroot
├── initramfs.img         initramfs-tools + cpio.gz extractor hook
└── rootfs.cpio.gz        the new artifact (replaces rootfs.squashfs)
```

Boot sequence:

1. syslinux loads `vmlinuz` + `initramfs.img`.
2. initramfs hook mounts tmpfs at `/newroot`, gunzip+cpio-extracts
   `rootfs.cpio.gz` from a known partition (FREERAID:/live/) into
   `/newroot`.
3. `switch_root /newroot /sbin/init`.

## Pieces that change

### `scripts/build-image.sh`

- Drop the live-boot + live-boot-initramfs-tools apt installs (lines 251-256).
- Drop the toram-driven service ordering for `freeraid-config-mount.service`
  (~line 747+) — instead boot directly into tmpfs.
- Replace the `mksquashfs` block (~line 814) with:

  ```bash
  info "Building rootfs.cpio.gz..."
  (cd "$ROOTFS" && find . -path ./boot -prune -o -print | cpio -o -H newc) \
      | gzip -9 > "$BUILD_DIR/rootfs.cpio.gz"
  info "rootfs.cpio.gz: $(du -sh "$BUILD_DIR/rootfs.cpio.gz" | cut -f1)"
  ```

- Add a custom initramfs hook (in `/etc/initramfs-tools/scripts/init-bottom/`)
  that locates and extracts `rootfs.cpio.gz` from the FREERAID partition,
  then switch_root. Test in a fresh chroot before shipping.

### `scripts/create-usb.sh`

- Write `rootfs.cpio.gz` to the FREERAID partition (FAT32) instead of
  `rootfs.squashfs`.
- Update syslinux.cfg `APPEND` line: drop `boot=live` / `toram`, add the
  cpio path discovery flag the new initramfs hook expects.

### `scripts/build-image.sh` requirements check

- Add `cpio` to the `for tool in …` loop (line 26). `gzip` is already there.
- Drop the `squashfs-tools` / `mksquashfs` requirement.

## Risks

1. **First boot can fail silently** if the initramfs hook can't find or
   extract the cpio. Mitigation: hook drops to an emergency shell on failure
   with a clear message; test on the QEMU image before USB.
2. **Memory pressure** if cpio.gz is large — gzip-9 of a typical FreeRAID
   rootfs is ~700 MB, extraction balloons to ~2.5 GB in tmpfs. Cheap boxes
   with 4 GB RAM may OOM during extraction. Mitigation: document the 8 GB
   minimum, surface in installer.
3. **Boot time regression** — extraction adds ~10-20 s vs live-boot's lazy
   read. Acceptable for a NAS.
4. **No upgrade path mid-session** — the `/boot/config/updates/` overlay
   pattern (#22) needs to land at the same time, otherwise this becomes the
   sole way to ship fixes and every commit needs a fresh USB. Bundle the
   work.

## Test plan

1. QEMU run with the new initramfs hook + a synthesized small cpio.gz —
   confirm switch_root succeeds and the live system comes up.
2. Full QEMU boot with a realistic rootfs.cpio.gz — verify memory
   footprint, boot time, all FreeRAID services come up.
3. Hardware boot on POUGHKEEPSIE in a parallel USB slot (do NOT replace
   the existing working USB until verified).
4. Stress test: pull a 5 GB docker image post-boot, verify no `-EIO` from
   the rootfs.
5. Verify update path: simulate a `/boot/config/updates/freeraid-cli.patch`
   overlay loading on top of the extracted tmpfs.

## Rollback

The stopgap (uncompressed squashfs) stays in tree until the cpio path is
validated end-to-end. Switching back is a one-commit revert of the
build-image.sh change. Keep the live-boot package install in place until
the cpio hook has shipped two clean test boots.
