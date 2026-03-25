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
  document.getElementById('tab-dashboard').classList.toggle('hidden', name !== 'dashboard');
  document.getElementById('tab-settings').classList.toggle('hidden',  name !== 'settings');
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
