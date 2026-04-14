#!/usr/bin/env python3
"""
FreeRAID GUI Installer — standalone tkinter app.

Always downloads the latest release image from GitHub so users never write a
stale OS. The only local input is an optional Unraid flash-backup zip.

Run modes:
  * Dev:   sudo python3 scripts/installer.py
  * Build: scripts/build-installer.sh → dist/freeraid-installer (single-file)
"""
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError:
    print("tkinter missing — install with: sudo apt-get install python3-tk", file=sys.stderr)
    sys.exit(1)

IMAGE_FILES      = ("vmlinuz", "initrd.gz", "rootfs.squashfs")
IMAGE_ASSET_NAME = "freeraid-image-x64.tar.gz"
IMAGE_URL        = f"https://getfreeraid.com/images/{IMAGE_ASSET_NAME}"
VERSION_URL      = "https://getfreeraid.com/images/latest.txt"


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def find_create_usb() -> Path:
    bundled = resource_root() / "create-usb.sh"
    if bundled.is_file():
        return bundled
    repo_fallback = Path(__file__).resolve().parent / "create-usb.sh"
    if repo_fallback.is_file():
        return repo_fallback
    raise FileNotFoundError("create-usb.sh not found (bundle resource missing)")


def find_config_template() -> Path | None:
    bundled = resource_root() / "freeraid.conf.json"
    if bundled.is_file():
        return bundled
    repo_fallback = Path(__file__).resolve().parent.parent / "core" / "freeraid.conf.json"
    if repo_fallback.is_file():
        return repo_fallback
    return None


def list_candidate_disks():
    out = subprocess.check_output(
        ["lsblk", "-J", "-o", "NAME,SIZE,MODEL,TRAN,RM,TYPE,MOUNTPOINT"], text=True
    )
    data = json.loads(out)
    disks = []
    for dev in data.get("blockdevices", []):
        if dev.get("type") != "disk":
            continue
        mounts = [dev.get("mountpoint")] + [c.get("mountpoint") for c in dev.get("children") or []]
        if any(m in ("/", "/boot", "/boot/efi") for m in mounts if m):
            continue
        path  = f"/dev/{dev['name']}"
        size  = dev.get("size") or "?"
        model = (dev.get("model") or "").strip() or "(unknown)"
        tran  = (dev.get("tran")  or "").upper() or "?"
        rm    = "removable" if dev.get("rm") else "fixed"
        disks.append((path, f"{path}  —  {size}  {model}  [{tran}, {rm}]"))
    return disks


def fetch_latest_image_version() -> str | None:
    try:
        with urllib.request.urlopen(VERSION_URL, timeout=10) as r:
            return r.read().decode("utf-8", "replace").strip() or None
    except Exception:
        return None


class InstallerApp:
    def __init__(self, root):
        self.root = root
        root.title("FreeRAID USB Installer")
        root.geometry("760x640")

        self.disks         = []
        self.selected_disk = tk.StringVar()
        self.unraid_zip    = tk.StringVar()
        self.skip_parity   = tk.BooleanVar(value=False)
        self.release_tag   = tk.StringVar(value="checking…")
        self.writing       = False

        self._build_ui()
        self._check_preflight()
        self.refresh_disks()
        threading.Thread(target=self._populate_release_tag, daemon=True).start()

    def _build_ui(self):
        pad = {"padx": 12, "pady": 6}
        tk.Label(self.root, text="FreeRAID USB Installer",
                 font=("", 16, "bold")).pack(anchor="w", **pad)
        tk.Label(self.root, text="This will ERASE the selected USB drive and write FreeRAID to it.",
                 fg="#a00").pack(anchor="w", padx=12)

        # Image info (read-only — always latest)
        frm = tk.LabelFrame(self.root, text="FreeRAID image")
        frm.pack(fill="x", **pad)
        row = tk.Frame(frm); row.pack(fill="x", padx=6, pady=6)
        tk.Label(row, text="Latest release:").pack(side="left")
        tk.Label(row, textvariable=self.release_tag,
                 font=("", 10, "bold"), fg="#2a7").pack(side="left", padx=6)
        tk.Label(frm, text="Downloaded fresh from GitHub on every install — you always get the newest OS.",
                 fg="#666", font=("", 9)).pack(anchor="w", padx=6, pady=(0, 4))

        # Disk picker
        frm = tk.LabelFrame(self.root, text="Target USB drive")
        frm.pack(fill="x", **pad)
        self.disk_combo = ttk.Combobox(frm, textvariable=self.selected_disk,
                                       state="readonly", width=80)
        self.disk_combo.pack(side="left", fill="x", expand=True, padx=6, pady=6)
        tk.Button(frm, text="Refresh", command=self.refresh_disks).pack(side="left", padx=6)

        # Unraid zip
        frm = tk.LabelFrame(self.root, text="Unraid backup (optional)")
        frm.pack(fill="x", **pad)
        row = tk.Frame(frm); row.pack(fill="x", padx=6, pady=6)
        tk.Entry(row, textvariable=self.unraid_zip).pack(side="left", fill="x", expand=True)
        tk.Button(row, text="Browse…", command=self._pick_zip).pack(side="left", padx=6)
        tk.Label(frm, text="Zip downloaded from the Unraid Main → Flash Backup panel.",
                 fg="#666", font=("", 9)).pack(anchor="w", padx=6, pady=(0, 4))

        # Options
        frm = tk.LabelFrame(self.root, text="Options")
        frm.pack(fill="x", **pad)
        tk.Checkbutton(frm, variable=self.skip_parity,
            text="Skip parity sync (test boot — preserves Unraid parity so you can swap USBs freely)"
            ).pack(anchor="w", padx=6, pady=6)

        self.btn_write = tk.Button(self.root, text="Write USB", bg="#4a7", fg="white",
                                   font=("", 12, "bold"), command=self.start_write)
        self.btn_write.pack(**pad)

        frm = tk.LabelFrame(self.root, text="Output")
        frm.pack(fill="both", expand=True, **pad)
        self.log = tk.Text(frm, height=12, bg="#111", fg="#eee", font=("monospace", 10))
        self.log.pack(fill="both", expand=True, padx=6, pady=6)
        self.log.configure(state="disabled")

    def _log(self, msg):
        self.log.configure(state="normal")
        self.log.insert("end", msg if msg.endswith("\n") else msg + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")
        self.root.update_idletasks()

    def _log_replace_last(self, msg):
        """Overwrite the last log line — used for progress updates."""
        self.log.configure(state="normal")
        self.log.delete("end-2l", "end-1l")
        self.log.insert("end", msg + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")
        self.root.update_idletasks()

    def _populate_release_tag(self):
        tag = fetch_latest_image_version()
        self.root.after(0, lambda: self.release_tag.set(tag or "unknown (network error)"))

    def _check_preflight(self):
        if os.geteuid() != 0:
            messagebox.showerror("Root required",
                "Run as root:\n  sudo ./freeraid-installer")
            self.root.destroy()
            return
        try:
            find_create_usb()
        except FileNotFoundError as e:
            messagebox.showerror("Resource missing", str(e))
            self.root.destroy()

    def refresh_disks(self):
        self.disks = list_candidate_disks()
        self.disk_combo["values"] = [lbl for _, lbl in self.disks]
        if self.disks:
            self.disk_combo.current(0)
        else:
            self.selected_disk.set("")
            self._log("No candidate disks found. Plug in a USB and click Refresh.")

    def _pick_zip(self):
        f = filedialog.askopenfilename(title="Select Unraid backup zip",
            filetypes=[("Zip archive", "*.zip"), ("All files", "*.*")])
        if f:
            self.unraid_zip.set(f)

    def _selected_dev(self):
        label = self.selected_disk.get()
        for path, lbl in self.disks:
            if lbl == label:
                return path
        return None

    def start_write(self):
        if self.writing:
            return
        dev = self._selected_dev()
        if not dev:
            messagebox.showerror("No disk", "Pick a target USB drive first.")
            return
        zip_path = self.unraid_zip.get().strip()
        if zip_path and not Path(zip_path).is_file():
            messagebox.showerror("Bad path", f"Not a file: {zip_path}")
            return
        if not messagebox.askyesno("Confirm erase",
                                   f"ALL DATA on {dev} will be destroyed.\n\nContinue?"):
            return

        self.writing = True
        self.btn_write.config(state="disabled", text="Working…")
        threading.Thread(target=self._run_full, args=(dev, zip_path), daemon=True).start()

    def _run_full(self, dev, zip_path):
        tmpdir = tempfile.mkdtemp(prefix="freeraid-installer-")
        try:
            img_dir = self._download_image(tmpdir)
            if not img_dir:
                return
            self._run_create_usb(dev, zip_path, img_dir)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
            self._reset_button()

    def _download_image(self, tmpdir: str) -> Path | None:
        tarball = Path(tmpdir) / IMAGE_ASSET_NAME
        self._log(f"Downloading {IMAGE_URL}")
        self._log("")  # placeholder line for progress overwrite
        try:
            req = urllib.request.Request(IMAGE_URL,
                headers={"User-Agent": "freeraid-installer"})
            with urllib.request.urlopen(req, timeout=30) as r, open(tarball, "wb") as f:
                total = int(r.headers.get("Content-Length") or 0)
                got = 0
                chunk = 1024 * 256
                while True:
                    buf = r.read(chunk)
                    if not buf:
                        break
                    f.write(buf)
                    got += len(buf)
                    if total:
                        pct = 100 * got / total
                        self._log_replace_last(
                            f"  {got/1_048_576:.1f} / {total/1_048_576:.1f} MB  ({pct:.1f}%)")
                    else:
                        self._log_replace_last(f"  {got/1_048_576:.1f} MB")
        except urllib.error.HTTPError as e:
            self._log(f"\nHTTP error: {e.code} {e.reason}")
            self.root.after(0, lambda: messagebox.showerror("Download failed",
                f"Could not fetch image:\n{IMAGE_URL}\n\n{e.code} {e.reason}"))
            return None
        except Exception as e:
            self._log(f"\nDownload error: {e}")
            self.root.after(0, lambda: messagebox.showerror("Download failed", str(e)))
            return None

        self._log("Extracting image…")
        img_dir = Path(tmpdir) / "image"
        img_dir.mkdir()
        try:
            with tarfile.open(tarball, "r:gz") as tf:
                tf.extractall(img_dir)
        except Exception as e:
            self._log(f"Extract error: {e}")
            self.root.after(0, lambda: messagebox.showerror("Extract failed", str(e)))
            return None

        # Flatten if the tarball contains a single top-level directory
        entries = list(img_dir.iterdir())
        if len(entries) == 1 and entries[0].is_dir():
            img_dir = entries[0]

        missing = [f for f in IMAGE_FILES if not (img_dir / f).is_file()]
        if missing:
            msg = f"Downloaded archive is missing: {', '.join(missing)}"
            self._log(msg)
            self.root.after(0, lambda: messagebox.showerror("Bad release asset", msg))
            return None
        self._log(f"✓ Image ready in {img_dir}")
        return img_dir

    def _run_create_usb(self, dev, zip_path, img_dir):
        try:
            script = find_create_usb()
        except FileNotFoundError as e:
            self._log(f"ERROR: {e}")
            return

        env = os.environ.copy()
        env["FREERAID_BUILD_DIR"] = str(img_dir)
        tpl = find_config_template()
        if tpl:
            env["FREERAID_CONFIG_TEMPLATE"] = str(tpl)

        cmd = ["bash", str(script), "--yes"]
        if self.skip_parity.get():
            cmd.append("--skip-parity")
        cmd.append(dev)
        if zip_path:
            cmd.append(zip_path)
        self._log(f"\n$ {' '.join(cmd)}\n")
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, bufsize=1, env=env)
            for line in p.stdout:
                self._log(line.rstrip())
            rc = p.wait()
            if rc == 0:
                self._log("\n✓ Done — USB is ready to boot.")
                self.root.after(0, lambda: messagebox.showinfo("Success",
                    f"FreeRAID written to {dev}."))
            else:
                self._log(f"\n✗ create-usb.sh exited with code {rc}")
                self.root.after(0, lambda: messagebox.showerror("Write failed",
                    f"create-usb.sh exited with code {rc}. See log."))
        except Exception as e:
            self._log(f"\nError: {e}")
            self.root.after(0, lambda: messagebox.showerror("Error", str(e)))

    def _reset_button(self):
        self.writing = False
        self.root.after(0, lambda: self.btn_write.config(state="normal", text="Write USB"))


def main():
    root = tk.Tk()
    InstallerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
