/* FreeRAID Web UI — freeraid.js */
'use strict';

// ── Cockpit fallback for dev outside Cockpit ─────────────────────────────────

function initFallback() {
  window.cockpit = {
    spawn: (cmd) => {
      const p = {};
      p.stream = () => p;
      p.then  = (fn) => {
        if (cmd.includes('status'))
          fn('{"version":"0.1.2","array_state":"started","array_total":"16.0G","pool":{"mountpoint":"/mnt/user","size":"20G","used":"178M","free":"20G","pct":"1%"},"parity":[{"slot":"parity","device":"/dev/vdf","mountpoint":"/mnt/parity","size":"8G","present":true,"mounted":true,"label":"Parity"}],"disks":[{"slot":"disk1","device":"/dev/vdb","mountpoint":"/mnt/disk1","enabled":true,"present":true,"mounted":true,"size":"8G","used":"89M","free":"7.9G","pct":"2%","label":"Disk 1"},{"slot":"disk2","device":"/dev/vdc","mountpoint":"/mnt/disk2","enabled":true,"present":true,"mounted":true,"size":"8G","used":"89M","free":"7.9G","pct":"2%","label":"Disk 2"}],"cache":[{"slot":"cache","device":"/dev/vdg","mountpoint":"/mnt/cache","enabled":true,"present":true,"mounted":true,"size":"4G","used":"24K","free":"3.7G","pct":"1%","label":"Cache"}],"last_sync":"never"}');
        else if (cmd.includes('check-update'))
          fn('{"update_available":false,"current":"0.1.2","latest":"0.1.2"}');
        else
          fn('Demo mode — no real commands run.');
        return p;
      };
      p.catch = () => p;
      return p;
    }
  };
  ulog('warn', 'Running without Cockpit — demo mode');
}

window.addEventListener('load', () => {
  if (typeof cockpit === 'undefined') initFallback();
  refreshStatus();
  setInterval(refreshStatus, 8000);
  doCheckUpdate();
});

// ── State ────────────────────────────────────────────────────────────────────

let arrayState  = 'stopped';
let opRunning   = false;
let latestVer   = null;
let currentVer  = null;

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  ['dashboard','disks','settings','shares','docker','plugins'].forEach(t => {
    document.getElementById('tab-'+t).classList.toggle('hidden', name !== t);
  });
  if (name === 'shares') refreshShares();
  if (name === 'disks')  refreshDisks();
  if (name === 'docker') refreshDocker();
}

// ── Logging ──────────────────────────────────────────────────────────────────

function appendLog(panelId, level, text) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const line = document.createElement('p');
  line.className = `log-line log-${level}`;
  const ts = new Date().toTimeString().slice(0, 8);
  line.textContent = `[${ts}] ${text}`;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}

const log  = (level, text) => appendLog('log-panel', level, text);
const ulog = (level, text) => appendLog('update-log-panel', level, text);

function clearLog()       { document.getElementById('log-panel').innerHTML = ''; }
function clearUpdateLog() { document.getElementById('update-log-panel').innerHTML = ''; }

function showAlert(type, msg) {
  const bar = document.getElementById('alert-bar');
  bar.className = `alert ${type}`;
  bar.textContent = msg;
}
function hideAlert() {
  document.getElementById('alert-bar').className = 'alert hidden';
}

// ── Run a command, stream output to a log panel ──────────────────────────────

function runCmd(args, logPanelId) {
  const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  return new Promise((resolve, reject) => {
    appendLog(logPanelId, 'cmd', `$ freeraid ${args.join(' ')}`);
    let buf = '';
    cockpit.spawn(['freeraid', ...args], { superuser: 'require', err: 'out' })
      .stream(data => {
        buf += data;
        stripAnsi(data).split('\n').filter(l => l.trim()).forEach(line => {
          const lvl = line.includes('ERROR') ? 'error'
                    : line.includes('WARN')  ? 'warn'
                    : line.startsWith('==>') ? 'success'
                    : 'info';
          appendLog(logPanelId, lvl, stripAnsi(line));
        });
      })
      .then(() => resolve(buf))
      .catch(err => reject(err));
  });
}

// ── Status refresh ───────────────────────────────────────────────────────────

function refreshStatus() {
  let buf = '';
  cockpit.spawn(['freeraid', 'status', '--json'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const jsonStart = buf.indexOf('{');
        applyStatus(JSON.parse(buf.slice(jsonStart)));
      } catch (e) { log('warn', 'Could not parse status: ' + e); }
    })
    .catch(err => log('error', 'Status fetch failed: ' + (err.message || err)));
}

function applyStatus(data) {
  arrayState = data.array_state;
  currentVer = data.version;

  document.getElementById('version').textContent = 'v' + data.version;

  const badge = document.getElementById('array-badge');
  badge.textContent = arrayState === 'started' ? '●  Array Started' : '●  Array Stopped';
  badge.className   = 'array-badge ' + (arrayState === 'started' ? 'started' : 'stopped');

  const btn = document.getElementById('btn-start-stop');
  btn.textContent = arrayState === 'started' ? 'Stop Array' : 'Start Array';
  btn.className   = 'btn ' + (arrayState === 'started' ? 'btn-danger' : 'btn-primary');

  document.getElementById('array-total').textContent = data.array_total || '—';
  if (data.pool) {
    document.getElementById('pool-used').textContent = data.pool.used || '—';
    document.getElementById('pool-free').textContent = data.pool.free || '—';
  }
  document.getElementById('last-sync').textContent = data.last_sync || 'never';

  // Settings tab system info
  document.getElementById('s-version').textContent    = 'v' + data.version;
  document.getElementById('s-array-state').textContent = arrayState.charAt(0).toUpperCase() + arrayState.slice(1);
  document.getElementById('s-pool-mount').textContent  = (data.pool && data.pool.mountpoint) || '—';
  try {
    document.getElementById('s-hostname').textContent = location.hostname || '—';
  } catch(_) {}

  renderDrives(data);
}

// ── Drive cards ──────────────────────────────────────────────────────────────

function usagePct(pctStr) { return parseInt(pctStr) || 0; }

function driveCard(drive, type) {
  const mounted = drive.mounted, present = drive.present, enabled = drive.enabled !== false;
  const pct     = usagePct(drive.pct);

  let dotClass  = present ? (enabled ? (mounted ? 'dot-green' : 'dot-yellow') : 'dot-grey') : 'dot-red';
  let cardClass = `drive-card type-${type}${!enabled ? ' disabled' : ''}${!present ? ' missing' : ''}`;

  let usageHtml = '';
  if (mounted && drive.used) {
    const barClass = pct >= 90 ? 'danger' : pct >= 75 ? 'high' : '';
    usageHtml = `<div class="usage-bar-wrap">
      <div class="usage-bar-bg"><div class="usage-bar-fill ${barClass}" style="width:${pct}%"></div></div>
      <div class="usage-stats"><span>${drive.used} used</span><span>${drive.free} free</span></div>
    </div>`;
  } else if (present && enabled && !mounted) {
    usageHtml = `<div class="usage-stats"><span style="color:var(--yellow)">Not mounted</span></div>`;
  }

  const typeLabel = type === 'parity' ? 'Parity' : type === 'cache' ? 'Cache' : 'Data';
  return `<div class="${cardClass}">
    <div class="drive-header">
      <span class="drive-status-dot ${dotClass}"></span>
      <span class="drive-slot">${drive.slot}</span>
      <span class="drive-type-badge">${typeLabel}</span>
    </div>
    <div class="drive-device">${drive.device}</div>
    <div class="drive-label">${drive.label}${drive.size ? ' · ' + drive.size.trim() : ''}</div>
    ${usageHtml}
  </div>`;
}

function renderDrives(data) {
  const grid = document.getElementById('drive-grid');
  let html = '';
  (data.parity || []).forEach(d => { html += driveCard(d, 'parity'); });
  (data.disks  || []).forEach(d => { html += driveCard(d, 'data'); });
  (data.cache  || []).forEach(d => { html += driveCard(d, 'cache'); });
  grid.innerHTML = html || '<div class="loading-msg">No drives configured.</div>';
}

// ── Array actions ─────────────────────────────────────────────────────────────

function toggleArray() {
  if (opRunning) return;
  opRunning = true;
  setButtonsDisabled(true);
  const action = arrayState === 'started' ? 'stop' : 'start';
  log('cmd', `${action} array...`);
  runCmd([action], 'log-panel')
    .then(() => refreshStatus())
    .catch(err => log('error', String(err)))
    .finally(() => { opRunning = false; setButtonsDisabled(false); });
}

function runSync() {
  if (opRunning) return;
  opRunning = true;
  setButtonsDisabled(true);
  runCmd(['sync'], 'log-panel')
    .then(() => refreshStatus())
    .catch(err => log('error', String(err)))
    .finally(() => { opRunning = false; setButtonsDisabled(false); });
}

function setButtonsDisabled(d) {
  ['btn-start-stop', 'btn-sync'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = d;
  });
}

// ── Update check & apply (Settings tab) ──────────────────────────────────────

function doCheckUpdate() {
  const statusEl = document.getElementById('s-update-status');
  const latestEl = document.getElementById('s-latest');
  const btnUpdate = document.getElementById('btn-do-update');
  const updateBar = document.getElementById('update-bar');

  if (statusEl) statusEl.textContent = 'Checking...';

  let buf = '';
  cockpit.spawn(['freeraid', 'check-update'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const jsonStart = buf.indexOf('{');
        const data = JSON.parse(buf.slice(jsonStart));
        latestVer = data.latest;

        if (latestEl) latestEl.textContent = 'v' + data.latest;

        if (data.update_available) {
          if (statusEl) {
            statusEl.textContent = `Update available`;
            statusEl.className = 'settings-value update-avail';
          }
          if (btnUpdate) btnUpdate.classList.remove('hidden');
          // Show topbar notification banner
          document.getElementById('update-msg').textContent =
            `Update available: v${data.current} → v${data.latest}`;
          updateBar.classList.remove('hidden');
        } else {
          if (statusEl) {
            statusEl.textContent = 'Up to date';
            statusEl.className = 'settings-value up-to-date';
          }
          if (btnUpdate) btnUpdate.classList.add('hidden');
          updateBar.classList.add('hidden');
        }
      } catch(e) {
        if (statusEl) statusEl.textContent = 'Check failed';
      }
    })
    .catch(() => { if (statusEl) statusEl.textContent = 'Unreachable'; });
}

// ── Disks ─────────────────────────────────────────────────────────────────────

function clearDisksLog() { document.getElementById('disks-log-panel').innerHTML = ''; }
const dlog = (level, text) => appendLog('disks-log-panel', level, text);

let _assignDev = null;

function refreshDisks() {
  const el = document.getElementById('disk-scan-list');
  el.innerHTML = '<div class="loading-msg">Scanning...</div>';

  let buf = '';
  cockpit.spawn(['freeraid', 'disks-scan'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const jsonStart = buf.indexOf('[');
        renderDisks(JSON.parse(buf.slice(jsonStart)));
      } catch(e) {
        el.innerHTML = '<div class="loading-msg">Could not scan disks.</div>';
      }
    })
    .catch(() => { el.innerHTML = '<div class="loading-msg">Scan failed.</div>'; });
}

function renderDisks(disks) {
  const el      = document.getElementById('disk-scan-list');
  const stopped = arrayState === 'stopped';
  const notice  = document.getElementById('array-stopped-notice');

  notice.classList.toggle('hidden', stopped);

  if (!disks.length) {
    el.innerHTML = '<div class="loading-msg">No disks detected.</div>';
    return;
  }

  const roleColors = { array: 'role-array', parity: 'role-parity', cache: 'role-cache' };

  el.innerHTML = disks.map(d => {
    const roleClass = d.assigned ? (roleColors[d.role] || '') : 'unassigned';
    const typeBadge = `<span class="disk-type-badge">${d.type}</span>`;

    let statusHtml = '';
    if (d.assigned) {
      const roleLabel = d.role === 'array' ? 'Array' : d.role === 'parity' ? 'Parity' : 'Cache';
      statusHtml = `<span class="badge badge-smb" style="margin-right:4px">${roleLabel}: ${d.slot}</span>`;
    } else {
      statusHtml = `<span style="color:var(--text-dim);font-size:12px">Unassigned</span>`;
    }

    const assignBtn = stopped
      ? `<button class="btn btn-sm btn-primary" onclick="openAssignModal('${d.device}')">Assign</button>`
      : '';
    const unassignBtn = (stopped && d.assigned)
      ? `<button class="btn btn-sm btn-ghost" onclick="doUnassign('${d.device}')">Unassign</button>`
      : '';

    const model = d.model || 'Unknown';
    const fsBadge = d.has_fs ? `<span class="disk-type-badge" style="color:var(--yellow)">${d.has_fs}</span>` : '';

    return `<div class="disk-scan-card ${roleClass}">
      <div class="disk-device">${d.device}</div>
      <div class="disk-model">${model} ${fsBadge}</div>
      <div style="display:flex;gap:6px;align-items:center">${typeBadge}</div>
      <div class="disk-size">${d.size}</div>
      <div style="min-width:140px">${statusHtml}</div>
      <div style="display:flex;gap:6px">${assignBtn}${unassignBtn}</div>
    </div>`;
  }).join('');
}

function openAssignModal(dev) {
  _assignDev = dev;
  document.getElementById('assign-modal-device').textContent = dev;
  document.getElementById('assign-modal-backdrop').classList.remove('hidden');
}

function closeAssignModal() {
  _assignDev = null;
  document.getElementById('assign-modal-backdrop').classList.add('hidden');
}

function doAssign(role) {
  if (!_assignDev) return;
  const dev = _assignDev;
  closeAssignModal();
  dlog('cmd', `Assigning ${dev} as ${role}...`);
  runCmd(['disks-assign', dev, role], 'disks-log-panel')
    .then(() => {
      dlog('success', `${dev} assigned as ${role}. Start the array to use it.`);
      refreshDisks();
      refreshStatus();
    })
    .catch(err => dlog('error', String(err)));
}

function doUnassign(dev) {
  if (!confirm(`Unassign ${dev}?\n\nData on the disk is NOT deleted.`)) return;
  dlog('cmd', `Unassigning ${dev}...`);
  runCmd(['disks-unassign', dev], 'disks-log-panel')
    .then(() => { refreshDisks(); refreshStatus(); })
    .catch(err => dlog('error', String(err)));
}

// ── Shares ───────────────────────────────────────────────────────────────────

function clearSharesLog() { document.getElementById('shares-log-panel').innerHTML = ''; }
const slog = (level, text) => appendLog('shares-log-panel', level, text);

function refreshShares() {
  let buf = '';
  cockpit.spawn(['freeraid', 'shares-list'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const jsonStart = buf.indexOf('[');
        renderShares(JSON.parse(buf.slice(jsonStart)));
      } catch(e) {
        document.getElementById('shares-list').innerHTML =
          '<div class="loading-msg">No shares configured yet. Create one or import from Unraid above.</div>';
      }
    })
    .catch(() => {
      document.getElementById('shares-list').innerHTML =
        '<div class="loading-msg">Could not load shares.</div>';
    });
}

function renderShares(shares) {
  const el = document.getElementById('shares-list');
  if (!shares.length) {
    el.innerHTML = '<div class="loading-msg">No shares configured. Create one or import from Unraid above.</div>';
    return;
  }
  el.innerHTML = shares.map(s => {
    const smbBadge    = s.smb_enabled ? `<span class="badge badge-smb">SMB</span>` : '';
    const nfsBadge    = s.nfs_enabled ? `<span class="badge badge-nfs">NFS</span>` : '';
    const secBadge    = (s.smb_security === 'public')
      ? `<span class="badge badge-public">Public</span>`
      : `<span class="badge badge-private">Private</span>`;
    const cacheBadge  = s.cache_mode ? `<span class="badge badge-cache">Cache: ${s.cache_mode}</span>` : '';
    const unraidBadge = s._imported_from_unraid ? `<span class="badge badge-unraid">Unraid</span>` : '';
    const nameSafe    = s.name.replace(/'/g, "\\'");
    return `<div class="share-card">
      <div class="share-name">${s.name}</div>
      <div class="share-path">${s.path}</div>
      <div class="share-badges">${smbBadge}${nfsBadge}${secBadge}${cacheBadge}${unraidBadge}</div>
      <div class="share-actions">
        <button class="btn btn-sm btn-ghost" onclick="removeShare('${nameSafe}')">Remove</button>
      </div>
    </div>`;
  }).join('');
}

function toggleAddShare() {
  document.getElementById('add-share-form').classList.toggle('hidden');
}

function doAddShare() {
  const name     = document.getElementById('new-share-name').value.trim();
  const comment  = document.getElementById('new-share-comment').value.trim();
  const security = document.getElementById('new-share-security').value;
  const cache    = document.getElementById('new-share-cache').value;
  const smb      = document.getElementById('new-share-smb').checked;
  const nfs      = document.getElementById('new-share-nfs').checked;

  if (!name) { alert('Share name is required'); return; }

  toggleAddShare();
  slog('cmd', `Creating share: ${name}`);

  // Add via CLI then patch settings via config directly
  runCmd(['shares-add', name], 'shares-log-panel')
    .then(() => {
      // Patch the extra fields into config via jq
      return new Promise((resolve, reject) => {
        cockpit.spawn(['bash', '-c',
          `jq '(.shares[] | select(.name=="${name}")) |= . + {"comment":"${comment}","smb_security":"${security}","cache_mode":"${cache}","smb_enabled":${smb},"nfs_enabled":${nfs}}' /boot/config/freeraid.conf.json > /tmp/fr.tmp && mv /tmp/fr.tmp /boot/config/freeraid.conf.json`
        ], { superuser: 'require' })
          .then(resolve).catch(reject);
      });
    })
    .then(() => {
      document.getElementById('new-share-name').value    = '';
      document.getElementById('new-share-comment').value = '';
      refreshShares();
      slog('success', `Share "${name}" created.`);
    })
    .catch(err => slog('error', String(err)));
}

function removeShare(name) {
  if (!confirm(`Remove share "${name}"?\n\nFiles on disk are NOT deleted.`)) return;
  slog('cmd', `Removing share: ${name}`);
  runCmd(['shares-remove', name], 'shares-log-panel')
    .then(() => refreshShares())
    .catch(err => slog('error', String(err)));
}

function applyShares() {
  slog('cmd', 'Writing smb.conf and reloading Samba...');
  runCmd(['shares-apply'], 'shares-log-panel')
    .then(() => slog('success', 'Samba reloaded. Shares are live.'))
    .catch(err => slog('error', String(err)));
}

// ── Unraid config upload & import ─────────────────────────────────────────────

let _importTmpPath = null;

// Drag and drop
document.addEventListener('DOMContentLoaded', () => {
  const zone = document.getElementById('drop-zone');
  if (!zone) return;
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processUploadedFile(file);
  });
});

function handleUnraidUpload(input) {
  if (input.files[0]) processUploadedFile(input.files[0]);
}

function processUploadedFile(file) {
  if (!file.name.endsWith('.zip')) {
    alert('Please upload a .zip file (Unraid flash backup or config zip).');
    return;
  }

  slog('info', `Uploading ${file.name} (${(file.size/1024).toFixed(0)}KB)...`);

  const reader = new FileReader();
  reader.onload = e => {
    const data    = new Uint8Array(e.target.result);
    const tmpPath = `/tmp/unraid-upload-${Date.now()}.zip`;
    _importTmpPath = tmpPath;

    // Write zip to server via cockpit.file
    cockpit.file(tmpPath, { binary: true, superuser: 'require' })
      .replace(data)
      .then(() => {
        slog('success', `Uploaded to ${tmpPath} — scanning...`);
        return previewImport(tmpPath);
      })
      .catch(err => slog('error', 'Upload failed: ' + String(err)));
  };
  reader.readAsArrayBuffer(file);
}

function previewImport(zipPath) {
  // Extract zip and count what's inside
  let buf = '';
  return new Promise((resolve, reject) => {
    cockpit.spawn(['bash', '-c',
      `TMPDIR=$(mktemp -d /tmp/unraid-import-XXXXXX) && unzip -q "${zipPath}" -d "$TMPDIR" 2>/dev/null || true; ` +
      `CONFDIR=$(find "$TMPDIR" -name "disk.cfg" -o -name "ident.cfg" 2>/dev/null | head -1 | xargs dirname 2>/dev/null || echo ""); ` +
      `if [ -z "$CONFDIR" ]; then CONFDIR=$(find "$TMPDIR" -type d -name "config" | head -1); fi; ` +
      `SHARES=$(ls "$CONFDIR/shares/"*.cfg 2>/dev/null | wc -l || echo 0); ` +
      `DOCKER=$(ls "$CONFDIR/plugins/dockerMan/templates-user/"*.xml 2>/dev/null | wc -l || echo 0); ` +
      `HAS_DISK=$([ -f "$CONFDIR/disk.cfg" ] && echo 1 || echo 0); ` +
      `HAS_NET=$([ -f "$CONFDIR/network.cfg" ] && echo 1 || echo 0); ` +
      `echo "$TMPDIR|$CONFDIR|$SHARES|$DOCKER|$HAS_DISK|$HAS_NET"`
    ], { superuser: 'require' })
      .stream(d => { buf += d; })
      .then(() => {
        const parts = buf.trim().split('|');
        const [tmpdir, confdir, shares, docker, hasDisk, hasNet] = parts;
        showImportPreview({ tmpdir, confdir, shares: +shares, docker: +docker, hasDisk: hasDisk==='1', hasNet: hasNet==='1' });
        resolve();
      })
      .catch(reject);
  });
}

function showImportPreview(info) {
  if (!info.confdir) {
    slog('error', 'Could not find config/ directory in zip. Make sure it contains a Unraid flash backup.');
    return;
  }

  // Store confdir for import step
  document.getElementById('btn-do-import').dataset.confdir = info.confdir;
  document.getElementById('btn-do-import').dataset.tmpdir  = info.tmpdir;

  const rows = [
    info.shares  ? `<div class="preview-row"><span class="preview-count">${info.shares}</span> User shares (SMB/NFS settings)</div>` : '',
    info.docker  ? `<div class="preview-row"><span class="preview-count">${info.docker}</span> Docker app templates → compose files</div>` : '',
    info.hasDisk ? `<div class="preview-row"><span class="preview-count">✓</span> Disk assignments (parity, data, cache)</div>` : '',
    info.hasNet  ? `<div class="preview-row"><span class="preview-count">✓</span> Network config (hostname, IP settings)</div>` : '',
  ].filter(Boolean).join('');

  document.getElementById('import-preview-content').innerHTML = rows || '<div class="loading-msg">Nothing recognizable found in this zip.</div>';
  document.getElementById('import-preview').classList.remove('hidden');
}

function clearImportPreview() {
  document.getElementById('import-preview').classList.add('hidden');
  document.getElementById('unraid-file-input').value = '';
  _importTmpPath = null;
}

function doUnraidImport() {
  const btn     = document.getElementById('btn-do-import');
  const confdir = btn.dataset.confdir;
  const tmpdir  = btn.dataset.tmpdir;

  if (!confdir) { slog('error', 'No config directory found.'); return; }

  clearImportPreview();
  slog('cmd', `Importing from ${confdir}...`);

  runCmd(['shares-import', confdir], 'shares-log-panel')
    .then(() => {
      refreshShares();
      // Cleanup temp dir
      cockpit.spawn(['rm', '-rf', tmpdir], { superuser: 'require' }).catch(() => {});
    })
    .catch(err => slog('error', String(err)));
}

// ── Docker ────────────────────────────────────────────────────────────────────

function clearDockerLog() { document.getElementById('docker-log-panel').innerHTML = ''; }
const dklog = (level, text) => appendLog('docker-log-panel', level, text);

function refreshDocker() {
  const el = document.getElementById('docker-container-list');
  el.innerHTML = '<div class="loading-msg">Loading...</div>';

  let buf = '';
  cockpit.spawn(['freeraid', 'docker-list'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const jsonStart = buf.indexOf('[');
        renderDocker(JSON.parse(buf.slice(jsonStart)));
      } catch(e) {
        el.innerHTML = '<div class="loading-msg">Could not load containers.</div>';
      }
    })
    .catch(() => { el.innerHTML = '<div class="loading-msg">docker-list failed.</div>'; });
}

let _dockerSelection = new Set();

function renderDocker(containers) {
  const el = document.getElementById('docker-container-list');

  const running = containers.filter(c => c.state === 'running').length;
  document.getElementById('docker-running-count').textContent = running;
  document.getElementById('docker-stopped-count').textContent = containers.length - running;
  document.getElementById('docker-total-count').textContent   = containers.length;

  const selectAllWrap = document.getElementById('docker-select-all-wrap');
  selectAllWrap.style.display = containers.length ? '' : 'none';

  if (!containers.length) {
    el.innerHTML = '<div class="loading-msg">No compose files found in /etc/freeraid/compose/. ' +
      'Import from Unraid or add .docker-compose.yml files manually.</div>';
    return;
  }

  el.innerHTML = containers.map(c => {
    const isRunning  = c.state === 'running';
    const dotClass   = isRunning ? 'dot-green' : 'dot-grey';
    const stateLabel = isRunning ? 'Running' : 'Stopped';
    const stateColor = isRunning ? 'var(--green)' : 'var(--text-dim)';
    const nameSafe   = c.name.replace(/'/g, "\\'");
    const checked    = _dockerSelection.has(c.name) ? 'checked' : '';
    const toggleBtn  = isRunning
      ? `<button class="btn btn-sm btn-danger" onclick="dockerStop('${nameSafe}')">Stop</button>`
      : `<button class="btn btn-sm btn-primary" onclick="dockerStart('${nameSafe}')">Start</button>`;

    return `<div class="docker-card${isRunning ? ' running' : ''}" id="dcard-${c.name}">
      <input type="checkbox" class="docker-checkbox" ${checked}
        onchange="dockerSelectToggle('${nameSafe}', this.checked)">
      <div class="docker-header">
        <span class="drive-status-dot ${dotClass}"></span>
        <span class="docker-name">${c.name}</span>
      </div>
      <div class="docker-image">${c.image}</div>
      <div class="docker-state" style="color:${stateColor}">${stateLabel}</div>
      <div class="docker-actions">
        ${toggleBtn}
        <button class="btn btn-sm btn-ghost" onclick="dockerLogs('${nameSafe}')">Logs</button>
      </div>
    </div>`;
  }).join('');
}

function dockerSelectToggle(name, checked) {
  if (checked) _dockerSelection.add(name);
  else         _dockerSelection.delete(name);
  _dockerUpdateSelectionUI();
}

function dockerToggleAll(checked) {
  document.querySelectorAll('.docker-checkbox').forEach(cb => {
    const name = cb.closest('[id^="dcard-"]').id.replace('dcard-', '');
    cb.checked = checked;
    if (checked) _dockerSelection.add(name);
    else         _dockerSelection.delete(name);
  });
  _dockerUpdateSelectionUI();
}

function dockerClearSelection() {
  _dockerSelection.clear();
  document.querySelectorAll('.docker-checkbox').forEach(cb => { cb.checked = false; });
  const selectAll = document.getElementById('docker-select-all');
  if (selectAll) selectAll.checked = false;
  _dockerUpdateSelectionUI();
}

function _dockerUpdateSelectionUI() {
  const bar   = document.getElementById('docker-delete-bar');
  const count = document.getElementById('docker-delete-count');
  const n     = _dockerSelection.size;
  if (n > 0) {
    bar.classList.remove('hidden');
    count.textContent = `${n} selected`;
  } else {
    bar.classList.add('hidden');
  }
}

function dockerDeleteSelected() {
  const names = [..._dockerSelection];
  if (!names.length) return;
  if (!confirm(`Delete ${names.length} compose file(s)?\n\n${names.join('\n')}\n\nThis removes the file from /etc/freeraid/compose/ — running containers are stopped first.`)) return;

  dklog('cmd', `Deleting ${names.length} containers...`);
  dockerClearSelection();

  // Stop any running ones first, then delete — run sequentially
  const doDeletes = () => {
    const promises = names.map(name =>
      runCmd(['docker-delete', name], 'docker-log-panel')
        .then(() => dklog('success', `Deleted: ${name}`))
        .catch(err => dklog('error', `${name}: ${String(err)}`))
    );
    Promise.all(promises).then(() => refreshDocker());
  };

  // Stop running containers first
  const runningNames = names.filter(name => {
    const card = document.getElementById('dcard-' + name);
    return card && card.classList.contains('running');
  });

  if (runningNames.length) {
    dklog('info', `Stopping ${runningNames.length} running container(s) first...`);
    const stopPromises = runningNames.map(name =>
      runCmd(['docker-stop', name], 'docker-log-panel').catch(() => {})
    );
    Promise.all(stopPromises).then(doDeletes);
  } else {
    doDeletes();
  }
}

function dockerStart(name) {
  dklog('cmd', `Starting ${name}...`);
  runCmd(['docker-start', name], 'docker-log-panel')
    .then(() => { dklog('success', `${name} started.`); refreshDocker(); })
    .catch(err => dklog('error', String(err)));
}

function dockerStop(name) {
  dklog('cmd', `Stopping ${name}...`);
  runCmd(['docker-stop', name], 'docker-log-panel')
    .then(() => { dklog('success', `${name} stopped.`); refreshDocker(); })
    .catch(err => dklog('error', String(err)));
}

function dockerLogs(name) {
  dklog('cmd', `=== Logs: ${name} ===`);
  runCmd(['docker-logs', name], 'docker-log-panel')
    .catch(err => dklog('error', String(err)));
}

function doUpdate() {
  if (opRunning) return;
  opRunning = true;
  setButtonsDisabled(true);

  const btnUpdate = document.getElementById('btn-do-update');
  const btnCheck  = document.getElementById('btn-check-update');
  const logWrap   = document.getElementById('update-log-wrap');

  if (btnUpdate) btnUpdate.disabled = true;
  if (btnCheck)  btnCheck.disabled  = true;
  if (logWrap)   logWrap.classList.remove('hidden');

  document.getElementById('update-bar').classList.add('hidden');
  clearUpdateLog();
  ulog('info', `Starting update to v${latestVer || '?'}...`);

  runCmd(['update'], 'update-log-panel')
    .then(() => {
      ulog('success', 'Update complete — reloading in 3 seconds...');
      const statusEl = document.getElementById('s-update-status');
      if (statusEl) { statusEl.textContent = 'Up to date'; statusEl.className = 'settings-value up-to-date'; }
      if (btnUpdate) btnUpdate.classList.add('hidden');
      setTimeout(() => window.location.reload(), 3000);
    })
    .catch(err => {
      ulog('error', 'Update failed: ' + String(err));
      showAlert('error', 'Update failed — see update log for details.');
    })
    .finally(() => {
      opRunning = false;
      setButtonsDisabled(false);
      if (btnUpdate) btnUpdate.disabled = false;
      if (btnCheck)  btnCheck.disabled  = false;
    });
}
