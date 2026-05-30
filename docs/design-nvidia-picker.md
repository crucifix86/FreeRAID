# NVIDIA driver picker UI

Design doc for known-bugs.md #9. Replaces the single "Install NVIDIA Driver"
button in Settings → Hardware with an ich777/Unraid-style picker.

## Status

**Backend landed (2026-05-30):**
- `freeraid nvidia-drivers-list` — JSON: candidate packages + family + current
  installed + loaded module version.
- `freeraid nvidia-install [<package>]` — defaults to `nvidia-driver` for
  backward compat; accepts any package from the allowed family list.
- `freeraid nvidia-disable` — removes the `/boot/config/.nvidia-enabled`
  marker so next boot starts clean. Does not uninstall in the running session
  (avoid surprise reboots).

**UI:** still single-button. The pieces below describe the work to land the
picker; gating on a few real `nvidia-drivers-list` outputs from POUGHKEEPSIE
since the picker's labels depend on the actual package set apt resolves.

## Driver families (Debian Bookworm non-free baseline)

| Package                       | Family  | Use case                                |
| ----------------------------- | ------- | --------------------------------------- |
| `nvidia-driver`               | current | Modern GPUs (Turing+), default          |
| `nvidia-tesla-535-driver`     | tesla   | Tesla / datacenter cards, LTS 535       |
| `nvidia-tesla-525-driver`     | tesla   | Older Tesla cards                       |
| `nvidia-tesla-470-driver`     | tesla   | Last branch supporting Kepler datacentr |
| `nvidia-legacy-470xx-driver`  | legacy  | Maxwell / Pascal consumer cards         |
| `nvidia-legacy-390xx-driver`  | legacy  | Fermi / Kepler consumer cards           |

Picker should pull these from `nvidia-drivers-list` rather than hardcoding,
because backports may add 550/560 and the legacy family will eventually
shed old entries.

**Important constraint for P40-class users:** [[p40-kv-cache-f32]] applies to
LLM hosts, not display. For non-LLM uses the dropdown can suggest the
`tesla` family — note this in the picker's help text.

## UI layout

Replace the current Settings → Hardware NVIDIA block with:

```
NVIDIA GPU
  GPU model:  <s-nvidia-gpu>
  Loaded:     <module version | "not loaded">
  Installed:  <package> @ <version> | "none"

  Driver:     [ Current (nvidia-driver, 535.x) ▾ ]   ← select from drivers[]
              [ Install ] [ Update ] [ Disable ]
  (status / progress line)
  (collapsible log panel — reuses existing nvidia-install-log structure)
```

- "Install" enabled when nothing installed OR selection differs from
  installed.
- "Update" enabled when installed package matches selection AND
  `apt-cache policy` shows a newer candidate.
- "Disable" enabled when `.nvidia-enabled` marker is present.

## State machine

```
                  ┌─────────────┐
                  │   not       │
        ┌─────────│   detected  │
        │         └─────────────┘
        │
        │ GPU present, no driver
        ▼
  ┌────────────┐      install               ┌────────────────┐
  │ available  ├──────────────────────────► │   installing   │
  └────────────┘                            └────────┬───────┘
                                                     │
                                          success    │ failure
                              ┌──────────────────────┴────────────┐
                              ▼                                   ▼
                       ┌────────────────┐               ┌──────────────────┐
                       │   installed    │               │   install_error  │
                       └────────┬───────┘               └────────┬─────────┘
                                │                                │
                       disable  │  update                        │ retry
                                ▼                                ▼
                       ┌────────────────┐                 (back to installing)
                       │   disabled     │
                       │ (marker gone,  │
                       │  driver still  │
                       │  loaded until  │
                       │  reboot)       │
                       └────────────────┘
```

## Frontend wiring

Files touched:
- `web/freeraid/index.html` — replace the single-button block (~line 491-501)
  with the picker markup above.
- `web/freeraid/freeraid.js` — replace `installNvidia()` and the
  status-refresh code (~lines 3658-3710) with:
  - `refreshNvidiaStatus()` — calls `nvidia-status` AND `nvidia-drivers-list`
    in parallel, paints model + dropdown.
  - `installNvidiaSelected()` — reads selected package from `<select>`,
    spawns `freeraid nvidia-install <pkg>`.
  - `disableNvidia()` — spawns `freeraid nvidia-disable`.
- No backend changes — drivers-list and parameterized install already
  shipped 2026-05-30.

## Test plan

1. Backend smoke: `freeraid nvidia-drivers-list | jq` returns valid JSON on
   POUGHKEEPSIE with the expected `drivers[]` shape and `installed_package`
   matching `dpkg -l | grep nvidia.*-driver`.
2. UI rendering with the real JSON (no mocked data).
3. Install round-trip with a non-default family (e.g. tesla-535) on a
   throwaway VM — confirm dpkg installs the right package, `nvidia-smi`
   still reports the GPU.
4. Disable + reboot — confirm `/boot/config/.nvidia-enabled` is gone and
   the next boot doesn't re-install.

## Open questions for next iteration

- Should the picker support nvidia-container-toolkit version independently,
  or always install the latest? Default: always latest (current behavior).
- Driver rollback path: if Install fails, do we restore the previous
  package? Probably not in v1 — surface the error and let the user retry.
- Multi-GPU: if the host has two distinct GPU generations (e.g. P40 + a
  modern card), the picker offers a single family. Document the workaround
  (run apt-get install manually for the secondary).
