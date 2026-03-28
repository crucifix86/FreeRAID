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

// ── System stats (CPU / RAM / Network sparklines) ─────────────────────────────

const _sysPrev  = { cpu_idle: 0, cpu_total: 0, net_rx: 0, net_tx: 0 };
const _sysHist  = { cpu: [], ram: [], net: [] };
const HIST_MAX  = 30;

function _pushHist(key, val) {
  _sysHist[key].push(val);
  if (_sysHist[key].length > HIST_MAX) _sysHist[key].shift();
}

function _fmtBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB/s';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1) + ' MB/s';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(0) + ' KB/s';
  return bytes + ' B/s';
}

function refreshSysinfo() {
  let buf = '';
  cockpit.spawn(['freeraid', 'sysinfo'], { superuser: 'require' })
    .stream(d => { buf += d; })
    .then(() => {
      let d;
      try { d = JSON.parse(buf.trim()); } catch(_) { return; }

      // CPU %
      const idleDelta  = d.cpu_idle  - _sysPrev.cpu_idle;
      const totalDelta = d.cpu_total - _sysPrev.cpu_total;
      const cpuPct = totalDelta > 0 ? Math.round(100 * (1 - idleDelta / totalDelta)) : 0;

      // Net bytes/s
      const rxDelta = d.net_rx - _sysPrev.net_rx;
      const txDelta = d.net_tx - _sysPrev.net_tx;
      const netBps  = rxDelta + txDelta; // combined, per 4s interval → /4 for per-sec
      const netPct  = Math.min(100, netBps / 4 / 1250000 * 100); // scale to ~100Mbps

      // RAM %
      const ramPct = d.mem_total > 0
        ? Math.round(100 * (d.mem_total - d.mem_available) / d.mem_total)
        : 0;

      // Only push history after first sample (prev was 0)
      if (_sysPrev.cpu_total > 0) {
        _pushHist('cpu', cpuPct);
        _pushHist('ram', ramPct);
        _pushHist('net', netPct);
        document.getElementById('cpu-pct').textContent = cpuPct + '%';
        document.getElementById('ram-pct').textContent = ramPct + '%';
        const ramUsed = ((d.mem_total - d.mem_available) / 1048576).toFixed(1);
        const ramTotal = (d.mem_total / 1048576).toFixed(1);
        document.getElementById('ram-pct').textContent = ramPct + '% (' + ramUsed + '/' + ramTotal + ' GB)';
        document.getElementById('net-val').textContent =
          '↓' + _fmtBytes(Math.round(rxDelta / 4)) + '  ↑' + _fmtBytes(Math.round(txDelta / 4));
        _drawSparkline('cpu-chart', _sysHist.cpu, '#7c9ef8');
        _drawSparkline('ram-chart', _sysHist.ram, '#5dba7d');
        _drawSparkline('net-chart', _sysHist.net, '#e8a44a');
      }

      // System info (update every poll, not just after first delta)
      if (d.hostname) {
        const el = id => document.getElementById(id);
        if (el('si-hostname')) el('si-hostname').textContent = d.hostname;
        if (el('si-cpu'))      el('si-cpu').textContent = d.cpu_model + ' (' + d.cpu_cores + ' cores)';
        if (el('si-kernel'))   el('si-kernel').textContent = d.kernel;
        if (el('si-uptime') && d.uptime) {
          const s = d.uptime;
          const days  = Math.floor(s / 86400);
          const hours = Math.floor((s % 86400) / 3600);
          const mins  = Math.floor((s % 3600) / 60);
          el('si-uptime').textContent = days > 0
            ? `${days}d ${hours}h ${mins}m`
            : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        }
      }

      _sysPrev.cpu_idle  = d.cpu_idle;
      _sysPrev.cpu_total = d.cpu_total;
      _sysPrev.net_rx    = d.net_rx;
      _sysPrev.net_tx    = d.net_tx;
    })
    .catch(() => {});
}

function _drawSparkline(canvasId, data, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;

  const max = 100;
  const step = w / (HIST_MAX - 1);

  ctx.beginPath();
  data.forEach((val, i) => {
    const x = i * step;
    const y = h - (val / max) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  // Fill under line
  ctx.lineTo((data.length - 1) * step, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color + '33';
  ctx.fill();

  // Line
  ctx.beginPath();
  data.forEach((val, i) => {
    const x = i * step;
    const y = h - (val / max) * (h - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

window.addEventListener('load', () => {
  if (typeof cockpit === 'undefined') initFallback();

  // Verify we have superuser access before doing anything else.
  // If the user logged in as a non-root account without admin elevation,
  // every cockpit.spawn call silently fails. Catch this early.
  cockpit.spawn(['id', '-u'], { superuser: 'require', err: 'ignore' })
    .then(out => {
      if (out.trim() !== '0') {
        _showRootRequired();
        return;
      }
      _initApp();
    })
    .catch(() => _showRootRequired());
});

function _showRootRequired() {
  document.getElementById('wizard-overlay').classList.add('hidden');
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0d0d0d;font-family:sans-serif">
      <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:40px;max-width:420px;text-align:center">
        <div style="font-size:2em;margin-bottom:16px">🔒</div>
        <div style="font-size:1.2em;font-weight:600;color:#f87171;margin-bottom:12px">Root access required</div>
        <div style="color:#aaa;font-size:0.9em;margin-bottom:24px;line-height:1.5">
          FreeRAID must be accessed as <strong style="color:#fff">root</strong>.<br>
          Please log out and log back in as <code style="background:#2a2a2a;padding:2px 6px;border-radius:4px">root</code>.
        </div>
        <a href="/cockpit/logout" style="display:inline-block;background:#ef4444;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Log out &amp; switch user</a>
      </div>
    </div>`;
}

function _initApp() {
  checkSetupStatus();
  refreshStatus();
  setInterval(refreshStatus, 8000);
  refreshSysinfo();
  setInterval(refreshSysinfo, 4000);
  loadParitySchedule();
  loadMoverStatus();
  loadTurboWrite();
  loadBalancerStatus();
  refreshUpsStatus();
  // Skip update check if we just finished an update (flag set before reload)
  if (!sessionStorage.getItem('justUpdated')) {
    doCheckUpdate();
  } else {
    sessionStorage.removeItem('justUpdated');
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let arrayState  = 'stopped';
let opRunning   = false;
let latestVer   = null;
let currentVer  = null;

// ── Tab switching ─────────────────────────────────────────────────────────────

function openWebUIAccounts() {
  window.open('/cockpit/@localhost/users/index.html', '_blank');
}

function switchTab(name) {
  document.querySelectorAll('.sidebar-item[data-tab]').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  ['dashboard','disks','settings','shares','docker','plugins','network','users','logs','vms'].forEach(t => {
    document.getElementById('tab-'+t).classList.toggle('hidden', name !== t);
  });
  if (name === 'shares')  refreshShares();
  if (name === 'disks')   { refreshDisks(); refreshPools(); refreshZfsPools(); }
  if (name === 'docker')  { refreshDocker(); refreshNetworks(); }
  if (name === 'network') { refreshNetworkTab(); refreshTailscale(); }
  if (name === 'users')   refreshUsers();
  if (name === 'logs')    fetchLog();
  if (name === 'settings') { loadNotifSettings(); loadUpsConfig(); }
  if (name === 'plugins') refreshPlugins();
  if (name === 'vms')     { refreshVms(); refreshIsoList(); }
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
  badge.className   = 'array-status-badge ' + (arrayState === 'started' ? 'started' : 'stopped');

  const btn = document.getElementById('btn-start-stop');
  btn.textContent = arrayState === 'started' ? 'Stop Array' : 'Start Array';
  btn.className   = 'btn array-btn ' + (arrayState === 'started' ? 'btn-danger' : 'btn-primary');

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

  if (arrayState === 'started') {
    startIoStatLoop();
  } else {
    stopIoStatLoop();
  }
}

// ── Drive cards ──────────────────────────────────────────────────────────────

function usagePct(pctStr) { return parseInt(pctStr) || 0; }

// Tracks in-progress replacements: { slot: { pid, interval } }
const _replaceJobs = {};

function driveCard(drive, type) {
  const mounted  = drive.mounted, present = drive.present, enabled = drive.enabled !== false;
  const status   = drive.status || (present ? (mounted ? 'healthy' : 'unmounted') : 'missing');
  const stopped  = arrayState === 'stopped';
  const pct      = usagePct(drive.pct);

  // Rebuilding state (replacement job running)
  if (_replaceJobs[drive.slot]) {
    return `<div class="drive-card type-${type} rebuilding">
      <div class="drive-header">
        <span class="drive-status-dot dot-yellow rebuilding-pulse"></span>
        <span class="drive-slot">${drive.slot}</span>
        <span class="drive-type-badge">${type === 'parity' ? 'Parity' : type === 'cache' ? 'Cache' : 'Data'}</span>
      </div>
      <div class="drive-device">${drive.device}</div>
      <div class="drive-label" style="color:var(--yellow)">Rebuilding from parity...</div>
      <div class="rebuild-progress-bar"><div class="rebuild-progress-fill"></div></div>
    </div>`;
  }

  // Missing drive — show replacement UI (works whether stopped or running)
  if (status === 'missing' && type === 'data') {
    const selectId = `replace-sel-${drive.slot}`;
    const btnLabel = stopped ? 'Assign & Rebuild' : 'Replace';
    const note = stopped
      ? 'Array will start in degraded mode to rebuild this drive from parity.'
      : 'Array running in degraded mode. Files on this drive unavailable until replaced.';
    return `<div class="drive-card type-${type} missing">
      <div class="drive-header">
        <span class="drive-status-dot dot-red"></span>
        <span class="drive-slot">${drive.slot}</span>
        <span class="drive-type-badge">Data</span>
        <span class="drive-missing-badge">MISSING</span>
      </div>
      <div class="drive-label" style="color:var(--red)">Drive not detected</div>
      <div class="replace-controls">
        <select id="${selectId}" class="replace-select">
          <option value="">Select replacement drive...</option>
        </select>
        <button class="btn btn-danger btn-sm" onclick="startReplace('${drive.slot}', '${selectId}')">${btnLabel}</button>
      </div>
      <div class="replace-note">${note}</div>
    </div>`;
  }

  // Healthy/unmounted drive when stopped — show reassign option
  if (stopped && present && type === 'data') {
    const selectId = `reassign-sel-${drive.slot}`;
    const pct2 = usagePct(drive.pct);
    const barClass = pct2 >= 90 ? 'danger' : pct2 >= 75 ? 'high' : '';
    const usageHtml2 = mounted && drive.used
      ? `<div class="usage-bar-wrap">
           <div class="usage-bar-bg"><div class="usage-bar-fill ${barClass}" style="width:${pct2}%"></div></div>
           <div class="usage-stats"><span>${drive.used} used</span><span>${drive.free} free</span></div>
         </div>`
      : '';
    return `<div class="drive-card type-${type}">
      <div class="drive-header">
        <span class="drive-status-dot dot-grey"></span>
        <span class="drive-slot">${drive.slot}</span>
        <span class="drive-type-badge">Data</span>
      </div>
      <div class="drive-device">${drive.device}</div>
      <div class="drive-label">${drive.label}${drive.size ? ' · ' + drive.size.trim() : ''}</div>
      ${usageHtml2}
      <div class="replace-controls" style="margin-top:8px">
        <select id="${selectId}" class="replace-select">
          <option value="">Reassign drive...</option>
        </select>
        <button class="btn btn-sm btn-secondary" onclick="startReassign('${drive.slot}', '${selectId}')">Change</button>
      </div>
    </div>`;
  }

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

  let tempHtml = '';
  if (drive.temp) {
    const t = parseInt(drive.temp);
    const tempColor = t >= 55 ? 'var(--red)' : t >= 45 ? 'var(--yellow)' : 'var(--green)';
    tempHtml = `<span class="drive-temp" style="color:${tempColor}">${t}°C</span>`;
  }

  return `<div class="${cardClass}">
    <div class="drive-header">
      <span class="drive-status-dot ${dotClass}"></span>
      <span class="drive-slot">${drive.slot}</span>
      <span class="drive-type-badge">${typeLabel}</span>
      ${tempHtml}
      <button class="btn-smart-details" onclick="openSmartModal('${drive.device}','${drive.slot}')" title="SMART Details">⚙</button>
    </div>
    <div class="drive-device">${drive.device}</div>
    <div class="drive-label">${drive.label}${drive.size ? ' · ' + drive.size.trim() : ''}</div>
    ${usageHtml}
    <div class="drive-io-row hidden" data-io-dev="${drive.device}">
      <span class="io-badge io-read">▼ <span class="io-val">0 K</span>B/s</span>
      <span class="io-badge io-write">▲ <span class="io-val">0 K</span>B/s</span>
    </div>
  </div>`;
}

function renderDrives(data) {
  const grid    = document.getElementById('drive-grid');
  const stopped = arrayState === 'stopped';
  let html = '';
  (data.parity || []).forEach(d => { html += driveCard(d, 'parity'); });
  (data.disks  || []).forEach(d => { html += driveCard(d, 'data'); });
  (data.cache  || []).forEach(d => { html += driveCard(d, 'cache'); });
  grid.innerHTML = html || '<div class="loading-msg">No drives configured.</div>';

  // When stopped, also show unassigned drives inline so they can be assigned
  const needsDropdowns = stopped ||
    (data.disks || []).some(d => (d.status === 'missing') && !_replaceJobs[d.slot]);
  if (needsDropdowns) populateAllDropdowns(data);
}

// Populate all .replace-select dropdowns (replace + reassign), and append unassigned drive cards
function populateAllDropdowns(data) {
  cockpit.spawn(['freeraid', 'disks-scan'], { superuser: 'require', err: 'out' })
    .then(out => {
      let drives;
      try { drives = JSON.parse(out.trim()); } catch(e) { return; }
      const unassigned = drives.filter(d => !d.assigned && d.device !== '/dev/fd0' && d.name !== 'fd0');

      document.querySelectorAll('.replace-select').forEach(sel => {
        const current = sel.value;
        sel.innerHTML = sel.id.startsWith('reassign')
          ? '<option value="">Reassign drive...</option>'
          : '<option value="">Select replacement drive...</option>';
        unassigned.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.device;
          opt.textContent = `${d.device} — ${d.size} ${d.type} ${d.model || 'Unknown'}`;
          sel.appendChild(opt);
        });
        if (current) sel.value = current;
      });

      // If stopped, append unassigned drive cards to the grid
      if (arrayState === 'stopped' && unassigned.length) {
        const grid = document.getElementById('drive-grid');
        const existingUnassigned = grid.querySelectorAll('.drive-card.unassigned-drive');
        existingUnassigned.forEach(el => el.remove());

        unassigned.forEach(d => {
          const div = document.createElement('div');
          div.className = 'drive-card unassigned-drive';
          div.innerHTML = `
            <div class="drive-header">
              <span class="drive-status-dot dot-grey"></span>
              <span class="drive-slot" style="color:var(--text-muted)">Unassigned</span>
              <span class="drive-type-badge">${d.type}</span>
            </div>
            <div class="drive-device">${d.device}</div>
            <div class="drive-label">${d.model || 'Unknown'} · ${d.size}${d.has_fs ? ' · <span style="color:var(--yellow)">' + d.has_fs + '</span>' : ''}</div>
            <div class="replace-controls" style="margin-top:8px">
              <button class="btn btn-sm btn-primary" onclick="openAssignModal('${d.device}')">Add to Array</button>
            </div>`;
          grid.appendChild(div);
        });
      }
    })
    .catch(() => {});
}


function startReplace(slot, selectId) {
  const sel = document.getElementById(selectId);
  if (!sel || !sel.value) { showAlert('warn', 'Select a replacement drive first.'); return; }
  const dev = sel.value;
  if (!confirm(`Replace ${slot} with ${dev}?\n\nThis will FORMAT ${dev} and rebuild data from parity. This cannot be undone.`)) return;

  log('warn', `Starting drive replacement: ${slot} → ${dev}`);

  const doReplace = () => {
    cockpit.spawn(['freeraid', 'replace-disk-bg', slot, dev], { superuser: 'require', err: 'out' })
      .then(out => {
        let info;
        try { info = JSON.parse(out.trim().split('\n').pop()); } catch(e) { info = {}; }
        _replaceJobs[slot] = { pid: info.pid };
        refreshStatus();
        _replaceJobs[slot].interval = setInterval(() => pollReplaceStatus(slot), 10000);
        showAlert('info', `Rebuilding ${slot} from parity — this may take a long time.`);
      })
      .catch(err => { log('error', `Replace failed: ${err}`); showAlert('error', `Replace failed: ${err}`); });
  };

  // If array is stopped, start it in degraded mode first so parity + other drives are mounted
  if (arrayState === 'stopped') {
    log('cmd', 'Starting array in degraded mode for rebuild...');
    cockpit.spawn(['freeraid', 'start'], { superuser: 'require', err: 'out' })
      .stream(line => log('info', line.trim()))
      .then(() => { refreshStatus(); doReplace(); })
      .catch(err => { log('error', String(err)); showAlert('error', 'Failed to start array: ' + err); });
  } else {
    doReplace();
  }
}

function startReassign(slot, selectId) {
  const sel = document.getElementById(selectId);
  if (!sel || !sel.value) return;
  const dev = sel.value;
  if (!confirm(`Reassign ${slot} to ${dev}?\n\nThis only updates the config — the drive will be formatted when the array starts if it has no filesystem.`)) return;
  runCmd(['disks-unassign', dev], 'log-panel')
    .then(() => runCmd(['disks-assign', dev, 'array', slot], 'log-panel'))
    .then(() => { refreshStatus(); showAlert('success', `${slot} reassigned to ${dev}.`); })
    .catch(err => { log('error', String(err)); showAlert('error', String(err)); });
}

function pollReplaceStatus(slot) {
  cockpit.spawn(['freeraid', 'replace-disk-status', slot], { superuser: 'require', err: 'out' })
    .then(out => {
      let status;
      try { status = JSON.parse(out.trim()); } catch(e) { return; }
      if (!status.running) {
        clearInterval(_replaceJobs[slot].interval);
        delete _replaceJobs[slot];
        if (status.exit === 0 || status.exit === null) {
          showAlert('success', `Drive ${slot} successfully replaced and rebuilt.`);
          log('success', `Replace complete for ${slot}`);
        } else {
          showAlert('error', `Replace job for ${slot} finished with errors. Check the log panel.`);
          log('error', `Replace job for ${slot} exited with code ${status.exit}`);
          if (status.log) log('info', status.log);
        }
        refreshStatus();
      }
    })
    .catch(() => {});
}

// ── SMART modal ───────────────────────────────────────────────────────────────

function openSmartModal(device, slot) {
  const backdrop = document.getElementById('smart-modal-backdrop');
  const body     = document.getElementById('smart-modal-body');
  const title    = document.getElementById('smart-modal-title');
  title.textContent = `SMART — ${slot} (${device})`;
  body.innerHTML = '<div class="loading-msg">Loading SMART data...</div>';
  backdrop.classList.remove('hidden');

  cockpit.spawn(['freeraid', 'smart', device], { superuser: 'require', err: 'out' })
    .then(out => {
      let d;
      try { d = JSON.parse(out.trim()); } catch(e) { body.innerHTML = `<div class="smart-error">Failed to parse SMART data.</div>`; return; }
      if (d.error) { body.innerHTML = `<div class="smart-error">SMART not available: ${d.error}</div>`; return; }
      body.innerHTML = renderSmartModal(d, device);
    })
    .catch(err => { body.innerHTML = `<div class="smart-error">${err}</div>`; });
}

function closeSmartModal() {
  document.getElementById('smart-modal-backdrop').classList.add('hidden');
}

function renderSmartModal(d, device) {
  const fmtHours = h => h == null ? '—' : h >= 8760 ? `${(h/8760).toFixed(1)} yrs` : h >= 24 ? `${Math.floor(h/24)} days` : `${h} hrs`;
  const fmtBytes = b => b >= 1e12 ? `${(b/1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b/1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b/1e6).toFixed(1)} MB` : `${b} B`;

  const passed = d.smart_passed;
  const healthColor = passed === true ? 'var(--green)' : passed === false ? 'var(--red)' : 'var(--text-muted)';
  const healthText  = passed === true ? 'PASSED' : passed === false ? 'FAILED' : 'UNKNOWN';

  const warn = (d.reallocated_sectors > 0) || (d.pending_sectors > 0) || (d.uncorrectable > 0);

  let html = `
    <div class="smart-summary">
      <div class="smart-health" style="color:${healthColor}">${healthText}</div>
      <div class="smart-meta-grid">
        <div class="smart-meta-item"><span class="smart-meta-label">Model</span><span class="smart-meta-val">${d.model || '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label">Serial</span><span class="smart-meta-val">${d.serial || '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label">Firmware</span><span class="smart-meta-val">${d.firmware || '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label">Capacity</span><span class="smart-meta-val">${d.capacity_bytes ? fmtBytes(d.capacity_bytes) : '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label">Type</span><span class="smart-meta-val">${d.rotation_rate === 0 ? 'SSD' : d.rotation_rate > 0 ? `HDD (${d.rotation_rate} RPM)` : '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label">Temperature</span><span class="smart-meta-val" style="color:${d.temp >= 55 ? 'var(--red)' : d.temp >= 45 ? 'var(--yellow)' : 'var(--green)'}">${d.temp != null ? d.temp + '°C' : '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label">Power-On Time</span><span class="smart-meta-val">${fmtHours(d.power_on_hours)}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label">Power Cycles</span><span class="smart-meta-val">${d.power_cycles ?? '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label" style="color:${d.reallocated_sectors > 0 ? 'var(--red)' : ''}">Reallocated Sectors</span><span class="smart-meta-val" style="color:${d.reallocated_sectors > 0 ? 'var(--red)' : 'var(--green)'}">${d.reallocated_sectors ?? '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label" style="color:${d.pending_sectors > 0 ? 'var(--yellow)' : ''}">Pending Sectors</span><span class="smart-meta-val" style="color:${d.pending_sectors > 0 ? 'var(--yellow)' : 'var(--green)'}">${d.pending_sectors ?? '—'}</span></div>
        <div class="smart-meta-item"><span class="smart-meta-label" style="color:${d.uncorrectable > 0 ? 'var(--red)' : ''}">Uncorrectable</span><span class="smart-meta-val" style="color:${d.uncorrectable > 0 ? 'var(--red)' : 'var(--green)'}">${d.uncorrectable ?? '—'}</span></div>
      </div>
    </div>`;

  // NVMe health block
  if (d.nvme_health) {
    const n = d.nvme_health;
    html += `<div class="smart-section-title">NVMe Health</div>
    <div class="smart-meta-grid">
      <div class="smart-meta-item"><span class="smart-meta-label">Critical Warnings</span><span class="smart-meta-val" style="color:${n.critical_warning ? 'var(--red)' : 'var(--green)'}">${n.critical_warning || 0}</span></div>
      <div class="smart-meta-item"><span class="smart-meta-label">Media Errors</span><span class="smart-meta-val" style="color:${n.media_errors > 0 ? 'var(--red)' : 'var(--green)'}">${n.media_errors ?? '—'}</span></div>
      <div class="smart-meta-item"><span class="smart-meta-label">% Life Used</span><span class="smart-meta-val" style="color:${n.percentage_used >= 90 ? 'var(--red)' : n.percentage_used >= 70 ? 'var(--yellow)' : 'var(--green)'}">${n.percentage_used ?? '—'}%</span></div>
    </div>`;
  }

  // ATA attribute table
  if (d.attributes && d.attributes.length) {
    html += `<div class="smart-section-title">Attributes</div>
    <table class="smart-attr-table">
      <thead><tr><th>ID</th><th>Attribute</th><th>Value</th><th>Worst</th><th>Thresh</th><th>Raw</th></tr></thead>
      <tbody>`;
    d.attributes.forEach(a => {
      const rowClass = a.flags.failed ? 'smart-attr-fail' : '';
      html += `<tr class="${rowClass}"><td>${a.id}</td><td>${a.name}</td><td>${a.value}</td><td>${a.worst}</td><td>${a.thresh}</td><td>${a.raw}</td></tr>`;
    });
    html += `</tbody></table>`;
  }

  // Self-test history
  if (d.self_tests && d.self_tests.length) {
    html += `<div class="smart-section-title">Recent Self-Tests</div>
    <table class="smart-attr-table">
      <thead><tr><th>#</th><th>Type</th><th>Status</th><th>Hours</th></tr></thead>
      <tbody>`;
    d.self_tests.forEach(t => {
      const ok = (t.status || '').toLowerCase().includes('completed without');
      html += `<tr><td>${t.num}</td><td>${t.type}</td><td style="color:${ok ? 'var(--green)' : 'var(--yellow)'}">${t.status}</td><td>${t.remaining ?? '—'}</td></tr>`;
    });
    html += `</tbody></table>`;
  }

  html += `<div class="smart-actions">
    <button class="btn btn-secondary btn-sm" onclick="runSmartTest('${device}','short')">Run Short Test</button>
    <button class="btn btn-ghost btn-sm" onclick="runSmartTest('${device}','long')">Run Long Test</button>
  </div>`;

  return html;
}

function runSmartTest(device, type) {
  const body = document.getElementById('smart-modal-body');
  cockpit.spawn(['freeraid', 'smart-test', device, type], { superuser: 'require', err: 'out' })
    .then(() => {
      showAlert('success', `${type} self-test started on ${device}. Reopen SMART details in a few minutes to see results.`);
    })
    .catch(err => showAlert('error', String(err)));
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

function runScrub() {
  if (opRunning) return;
  if (!confirm('Run a full parity check now? This may take a while.')) return;
  opRunning = true;
  setButtonsDisabled(true);
  log('cmd', 'Running parity check (scrub)...');
  runCmd(['scrub'], 'log-panel')
    .then(() => refreshStatus())
    .catch(err => log('error', String(err)))
    .finally(() => { opRunning = false; setButtonsDisabled(false); });
}

function editHostname() {
  const current = document.getElementById('si-hostname').textContent;
  const name = prompt('Enter new hostname:', current);
  if (!name || name === current) return;
  cockpit.spawn(['freeraid', 'set-hostname', name], { superuser: 'require' })
    .then(() => { document.getElementById('si-hostname').textContent = name; })
    .catch(err => alert('Failed: ' + err));
}

function sysLogout() {
  cockpit.logout();
}

function sysReboot() {
  if (!confirm('Reboot this system?')) return;
  cockpit.spawn(['systemctl', 'reboot'], { superuser: 'require' }).catch(() => {});
}

function sysShutdown() {
  if (!confirm('Shut down this system?')) return;
  cockpit.spawn(['systemctl', 'poweroff'], { superuser: 'require' }).catch(() => {});
}

function setButtonsDisabled(d) {
  ['btn-start-stop', 'btn-sync', 'btn-scrub'].forEach(id => {
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

// ── Extra Storage Pools ───────────────────────────────────────────────────────

let _pools = [];

function refreshPools() {
  let buf = '';
  cockpit.spawn(['freeraid', 'pool-list'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const start = buf.indexOf('[');
        _pools = JSON.parse(buf.slice(start));
      } catch(_) { _pools = []; }
      renderPools();
      _populatePoolSelectors();
    })
    .catch(() => { _pools = []; renderPools(); });
}

function renderPools() {
  const el = document.getElementById('pools-list');
  if (!_pools.length) {
    el.innerHTML = '<div class="loading-msg">No extra pools. Create one above to add drives outside the main array.</div>';
    return;
  }
  el.innerHTML = _pools.map(p => {
    const diskCount = (p.disks || []).length;
    const stateClass = p.mounted ? 'status-healthy' : 'status-stopped';
    const stateLabel = p.mounted ? 'Running' : 'Stopped';
    const usageBar = p.mounted && p.pct ? `
      <div class="usage-bar-bg" style="margin:4px 0 2px">
        <div class="usage-bar-fill" style="width:${parseInt(p.pct)||0}%"></div>
      </div>
      <div style="font-size:11px;color:var(--text-dim)">${p.used} used / ${p.free} free (${p.pct})</div>` : '';
    const disksList = (p.disks || []).map(d => `
      <div class="pool-disk-row">
        <span style="font-family:monospace">${d.device}</span>
        <span style="color:var(--text-dim);font-size:11px">${d.slot}</span>
        <button class="btn btn-xs btn-ghost" onclick="poolUnassignDisk(${JSON.stringify(p.name)}, ${JSON.stringify(d.device)})" title="Unassign">✕</button>
      </div>`).join('');
    const pn = JSON.stringify(p.name);
    return `<div class="pool-card">
      <div class="pool-card-header">
        <div class="pool-name">${p.name}</div>
        <span class="pool-state ${stateClass}">${stateLabel}</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          ${p.mounted
            ? `<button class="btn btn-sm btn-secondary" onclick="poolStop(${pn})">Stop</button>`
            : `<button class="btn btn-sm btn-primary" onclick="poolStart(${pn})">Start</button>`
          }
          <button class="btn btn-sm btn-ghost" onclick="poolRemove(${pn})" title="Remove pool">Remove</button>
        </div>
      </div>
      <div class="pool-meta">
        <span>${diskCount} disk${diskCount !== 1 ? 's' : ''}</span>
        <span style="color:var(--text-dim);font-size:11px">${p.mountpoint}</span>
      </div>
      ${usageBar}
      <div class="pool-disks">${disksList || '<div style="font-size:12px;color:var(--text-dim);padding:4px 0">No drives assigned yet.</div>'}</div>
    </div>`;
  }).join('');
}

function _populatePoolSelectors() {
  // Update the "Storage Pool" dropdown in the Add Share form
  const sel = document.getElementById('new-share-pool');
  if (!sel) return;
  // Keep only the first option (main array), then add extra pools
  while (sel.options.length > 1) sel.remove(1);
  _pools.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = `${p.name} (extra pool)`;
    sel.appendChild(opt);
  });

  // Update assign modal with pool options
  const roleList = document.getElementById('assign-role-list');
  if (!roleList) return;
  // Remove previously injected pool buttons
  roleList.querySelectorAll('.pool-assign-btn').forEach(b => b.remove());
  _pools.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'assign-role-btn pool-assign-btn';
    btn.innerHTML = `<span class="assign-role-icon">🗄</span>
      <div>
        <div class="assign-role-name">Pool: ${p.name}</div>
        <div class="assign-role-desc">${p.mountpoint} — no parity</div>
      </div>`;
    btn.onclick = () => doAssignPool(p.name);
    roleList.appendChild(btn);
  });
}

function toggleAddPool() {
  document.getElementById('add-pool-form').classList.toggle('hidden');
  if (!document.getElementById('add-pool-form').classList.contains('hidden'))
    document.getElementById('new-pool-name').focus();
}

function doAddPool() {
  const name = document.getElementById('new-pool-name').value.trim();
  if (!name) { alert('Pool name is required'); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) { alert('Pool name must be alphanumeric (underscores/hyphens ok)'); return; }
  toggleAddPool();
  dlog('cmd', `Creating pool: ${name}`);
  runCmd(['pool-add', name], 'disks-log-panel')
    .then(() => {
      document.getElementById('new-pool-name').value = '';
      dlog('success', `Pool "${name}" created.`);
      refreshPools();
    })
    .catch(err => dlog('error', String(err)));
}

function poolRemove(name) {
  if (!confirm(`Remove pool "${name}"?\n\nDrives will be unassigned but data is NOT deleted.`)) return;
  dlog('cmd', `Removing pool: ${name}`);
  runCmd(['pool-remove', name], 'disks-log-panel')
    .then(() => { refreshPools(); refreshDisks(); })
    .catch(err => dlog('error', String(err)));
}

function poolStart(name) {
  dlog('cmd', `Starting pool: ${name}`);
  runCmd(['pool-start', name], 'disks-log-panel')
    .then(() => { dlog('success', `Pool "${name}" started.`); refreshPools(); })
    .catch(err => dlog('error', String(err)));
}

function poolStop(name) {
  dlog('cmd', `Stopping pool: ${name}`);
  runCmd(['pool-stop', name], 'disks-log-panel')
    .then(() => { dlog('success', `Pool "${name}" stopped.`); refreshPools(); })
    .catch(err => dlog('error', String(err)));
}

function poolUnassignDisk(poolName, dev) {
  if (!confirm(`Unassign ${dev} from pool "${poolName}"?`)) return;
  dlog('cmd', `Unassigning ${dev} from pool ${poolName}`);
  runCmd(['pool-unassign', poolName, dev], 'disks-log-panel')
    .then(() => { refreshPools(); refreshDisks(); })
    .catch(err => dlog('error', String(err)));
}

function doAssignPool(poolName) {
  if (!_assignDev) return;
  const dev = _assignDev;
  closeAssignModal();
  dlog('cmd', `Assigning ${dev} to pool ${poolName}...`);
  runCmd(['pool-assign', poolName, dev], 'disks-log-panel')
    .then(() => {
      dlog('success', `${dev} assigned to pool "${poolName}".`);
      refreshDisks();
      refreshPools();
    })
    .catch(err => dlog('error', String(err)));
}

function refreshDisks() {
  refreshSpindown();
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
    const preClearBtn = (!d.assigned)
      ? `<button class="btn btn-sm btn-ghost" onclick="startPreclear('${d.device}')">Pre-clear</button>`
      : '';

    const model = d.model || 'Unknown';
    const fsBadge = d.has_fs ? `<span class="disk-type-badge" style="color:var(--yellow)">${d.has_fs}</span>` : '';

    return `<div class="disk-scan-card ${roleClass}">
      <div class="disk-device">${d.device}</div>
      <div class="disk-model">${model} ${fsBadge}</div>
      <div style="display:flex;gap:6px;align-items:center">${typeBadge}</div>
      <div class="disk-size">${d.size}</div>
      <div style="min-width:140px">${statusHtml}</div>
      <div style="display:flex;gap:6px">${assignBtn}${unassignBtn}${preClearBtn}</div>
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

// ── Pre-clear ────────────────────────────────────────────────────────────────

const _preclearPollers = {}; // dev → intervalId

function startPreclear(dev) {
  if (!confirm(`Pre-clear ${dev}?\n\nThis will:\n1. Run a SMART short self-test\n2. Zero the entire drive (this takes a long time)\n3. Run a SMART long self-test\n\nAll data on ${dev} will be destroyed.`)) return;

  dlog('cmd', `Starting pre-clear on ${dev}...`);
  cockpit.spawn(['freeraid', 'preclear-bg', dev], { superuser: 'require', err: 'out' })
    .then(out => {
      try { JSON.parse(out.trim()); } catch(_) {}
      dlog('info', `Pre-clear started on ${dev}. Monitoring progress...`);
      _startPreclearPoll(dev);
    })
    .catch(err => dlog('error', `Pre-clear failed to start: ${err}`));
}

function _startPreclearPoll(dev) {
  if (_preclearPollers[dev]) clearInterval(_preclearPollers[dev]);
  _preclearPollers[dev] = setInterval(() => _pollPreclear(dev), 5000);
  _pollPreclear(dev);
}

function _pollPreclear(dev) {
  cockpit.spawn(['freeraid', 'preclear-status', dev], { superuser: 'require', err: 'out' })
    .then(out => {
      let s;
      try { s = JSON.parse(out.trim()); } catch(_) { return; }
      _renderPreclearProgress(dev, s);
      if (!s.running && s.stage !== 'idle') {
        clearInterval(_preclearPollers[dev]);
        delete _preclearPollers[dev];
        if (s.stage === 'done') {
          dlog('success', `Pre-clear complete on ${dev} — drive is ready to assign.`);
        } else {
          dlog('warn', `Pre-clear on ${dev} ended (stage: ${s.stage}).`);
        }
        refreshDisks();
      }
    })
    .catch(() => {});
}

function _renderPreclearProgress(dev, s) {
  const panelId = 'preclear-bar-' + dev.replace(/\//g, '_');
  let panel = document.getElementById(panelId);
  if (!panel) {
    // Insert after the disk scan card for this device
    const scanList = document.getElementById('disk-scan-list');
    if (!scanList) return;
    panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'preclear-panel';
    scanList.appendChild(panel);
  }

  const stageLabels = {
    starting: 'Starting...', smart_short: 'SMART short test',
    zeroing: 'Zeroing drive', smart_long: 'SMART long test', done: 'Complete'
  };
  const label = stageLabels[s.stage] || s.stage;
  const pct = s.pct || 0;
  const barClass = s.stage === 'done' ? 'preclear-bar-done' : 'preclear-bar-active';
  const cancelBtn = s.running
    ? `<button class="btn btn-sm btn-danger" onclick="cancelPreclear('${dev}')">Cancel</button>`
    : '';

  panel.innerHTML = `
    <div class="preclear-header">
      <span class="preclear-dev">${dev}</span>
      <span class="preclear-stage">${label}</span>
      <span class="preclear-pct">${pct}%</span>
      ${cancelBtn}
    </div>
    <div class="preclear-bar-bg">
      <div class="preclear-bar-fill ${barClass}" style="width:${pct}%"></div>
    </div>
    ${s.message ? `<div class="preclear-msg">${s.message}</div>` : ''}`;
}

function cancelPreclear(dev) {
  if (!confirm(`Cancel pre-clear on ${dev}?`)) return;
  clearInterval(_preclearPollers[dev]);
  delete _preclearPollers[dev];
  cockpit.spawn(['freeraid', 'preclear-cancel', dev], { superuser: 'require', err: 'out' })
    .then(() => {
      dlog('info', `Pre-clear cancelled on ${dev}.`);
      const panelId = 'preclear-bar-' + dev.replace(/\//g, '_');
      const panel = document.getElementById(panelId);
      if (panel) panel.remove();
    })
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
    const sec         = s.smb_security || 'public';
    const secLabel    = sec === 'public' ? 'Public' : sec === 'secure' ? 'Secure' : 'Private';
    const secClass    = sec === 'public' ? 'badge-public' : 'badge-private';
    const secBadge    = `<span class="badge ${secClass}">${secLabel}</span>`;
    const cacheBadge  = s.cache_mode ? `<span class="badge badge-cache">Cache: ${s.cache_mode}</span>` : '';
    const unraidBadge = s._imported_from_unraid ? `<span class="badge badge-unraid">Unraid</span>` : '';
    const pwBadge     = s.share_password_set ? `<span class="badge badge-pw">Password</span>` : '';
    const encBadge    = s.encrypted ? `<span class="badge badge-enc">Encrypted</span>` : '';
    const nameSafe    = s.name.replace(/'/g, "\\'");
    const nameJson    = JSON.stringify(s.name);
    return `<div class="share-card" id="share-card-${s.name}">
      <div class="share-name">${s.name}</div>
      <div class="share-path">${s.path}</div>
      <div class="share-badges">${smbBadge}${nfsBadge}${secBadge}${cacheBadge}${unraidBadge}${pwBadge}${encBadge}</div>
      <div class="share-actions">
        <button class="btn btn-sm btn-secondary" onclick="toggleSharePerms(${nameJson})">Permissions</button>
        <button class="btn btn-sm btn-secondary" onclick="toggleShareNfs(${nameJson})">NFS</button>
        <button class="btn btn-sm btn-secondary" onclick="toggleSharePassword(${nameJson})">Password</button>
        <button class="btn btn-sm btn-secondary" onclick="toggleShareEnc(${nameJson})">Encryption</button>
        <button class="btn btn-sm btn-ghost" onclick="removeShare('${nameSafe}')">Remove</button>
      </div>
    </div>
    <div class="share-perms-panel hidden" id="share-perms-${s.name}"></div>
    <div class="share-perms-panel hidden" id="share-nfs-${s.name}"></div>
    <div class="share-perms-panel hidden" id="share-pw-${s.name}">
      <div class="share-panel-inner">
        <div class="panel-title">Share Password — <span style="color:var(--text-muted);font-weight:400">${s.name}</span></div>
        <p style="font-size:0.85em;color:var(--text-muted);margin:0 0 10px">
          Set a password so clients connect as <code>freeraid_share_${s.name}</code> with this password.
          Leave blank to remove password protection.
        </p>
        <label class="field-label">New Password</label>
        <input type="password" id="share-pw-input-${s.name}" class="text-input" placeholder="Leave blank to remove" autocomplete="new-password">
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-primary btn-sm" onclick="saveSharePassword(${nameJson})">Save</button>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('share-pw-${s.name}').classList.add('hidden')">Cancel</button>
        </div>
        <div id="share-pw-msg-${s.name}" style="margin-top:8px;font-size:0.85em"></div>
      </div>
    </div>
    <div class="share-perms-panel hidden" id="share-enc-${s.name}">
      <div class="share-panel-inner" id="share-enc-inner-${s.name}">
        <div class="loading-msg">Loading encryption status...</div>
      </div>
    </div>`;
  }).join('');
}

let _sharePermsCache = {}; // name → user list

function toggleSharePerms(name) {
  const panel = document.getElementById('share-perms-' + name);
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  panel.innerHTML = '<div class="loading-msg" style="padding:12px">Loading...</div>';
  panel.classList.remove('hidden');

  // Load users and share data in parallel
  let userBuf = '', shareBuf = '';
  const p1 = new Promise(res => {
    cockpit.spawn(['freeraid', 'users-list'], { superuser: 'require', err: 'ignore' })
      .stream(d => { userBuf += d; }).then(res).catch(res);
  });
  const p2 = new Promise(res => {
    cockpit.spawn(['freeraid', 'shares-list'], { superuser: 'require', err: 'ignore' })
      .stream(d => { shareBuf += d; }).then(res).catch(res);
  });

  Promise.all([p1, p2]).then(() => {
    let users = [], share = null;
    try { users = JSON.parse(userBuf.slice(userBuf.indexOf('['))); } catch(e) {}
    try {
      const shares = JSON.parse(shareBuf.slice(shareBuf.indexOf('[')));
      share = shares.find(s => s.name === name);
    } catch(e) {}

    if (!share) { panel.innerHTML = '<div style="padding:12px;color:var(--red)">Could not load share data.</div>'; return; }

    const readList  = share.smb_read_list  || [];
    const writeList = share.smb_write_list || [];
    const sec       = share.smb_security   || 'public';
    const nameJson  = JSON.stringify(name);

    const userRows = users.filter(u => u.samba_enabled).map(u => `
      <div class="perm-user-row">
        <span class="perm-username">${u.name}</span>
        <label class="perm-check-label">
          <input type="checkbox" data-user="${u.name}" data-perm="read"
            ${readList.includes(u.name) || writeList.includes(u.name) ? 'checked' : ''}>
          Read
        </label>
        <label class="perm-check-label">
          <input type="checkbox" data-user="${u.name}" data-perm="write"
            ${writeList.includes(u.name) ? 'checked' : ''}>
          Write
        </label>
      </div>`).join('');

    panel.innerHTML = `
      <div class="share-perms-body">
        <div class="perms-row">
          <div>
            <label class="install-label">Access Level</label>
            <select class="install-select" id="perms-sec-${name}" onchange="onPermsSecChange(${nameJson})" style="min-width:200px">
              <option value="public"  ${sec==='public'  ? 'selected':''}>Public — anyone can access</option>
              <option value="secure"  ${sec==='secure'  ? 'selected':''}>Secure — authenticated users only</option>
              <option value="private" ${sec==='private' ? 'selected':''}>Private — specific users only</option>
            </select>
          </div>
          <button class="btn btn-sm btn-primary" style="align-self:flex-end" onclick="saveSharePerms(${nameJson})">Save</button>
        </div>
        <div id="perms-users-${name}" class="${sec !== 'private' ? 'hidden' : ''}">
          ${users.filter(u => u.samba_enabled).length === 0
            ? '<div style="color:var(--text-dim);font-size:13px;margin-top:8px">No Samba users found. Add users in the Share Users tab first.</div>'
            : `<div style="margin-top:12px">
                <div class="perm-user-header">
                  <span class="perm-username" style="font-weight:600">User</span>
                  <span class="perm-check-label" style="font-weight:600">Read</span>
                  <span class="perm-check-label" style="font-weight:600">Write</span>
                </div>
                ${userRows}
              </div>`
          }
        </div>
      </div>`;
  });
}

function onPermsSecChange(name) {
  const sec = document.getElementById('perms-sec-' + name).value;
  document.getElementById('perms-users-' + name).classList.toggle('hidden', sec !== 'private');
}

function saveSharePerms(name) {
  const sec = document.getElementById('perms-sec-' + name).value;

  let readList = [], writeList = [];
  if (sec === 'private') {
    document.querySelectorAll(`#share-perms-${name} [data-perm="read"]:checked`).forEach(cb => {
      readList.push(cb.dataset.user);
    });
    document.querySelectorAll(`#share-perms-${name} [data-perm="write"]:checked`).forEach(cb => {
      writeList.push(cb.dataset.user);
      if (!readList.includes(cb.dataset.user)) readList.push(cb.dataset.user);
    });
  }

  const readJson  = JSON.stringify(readList);
  const writeJson = JSON.stringify(writeList);

  slog('cmd', `Setting permissions for ${name}: ${sec}`);
  runCmd(['shares-set-perms', name, sec, readJson, writeJson], 'shares-log-panel')
    .then(() => {
      slog('success', `Permissions saved for ${name}.`);
      document.getElementById('share-perms-' + name).classList.add('hidden');
      refreshShares();
    })
    .catch(err => slog('error', String(err)));
}

function toggleShareNfs(name) {
  const panel = document.getElementById('share-nfs-' + name);
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  panel.innerHTML = '<div class="loading-msg" style="padding:12px">Loading...</div>';
  panel.classList.remove('hidden');

  let shareBuf = '';
  cockpit.spawn(['freeraid', 'shares-list'], { superuser: 'require', err: 'ignore' })
    .stream(d => { shareBuf += d; })
    .then(() => {
      let shares;
      try { shares = JSON.parse(shareBuf); } catch(e) { panel.innerHTML = '<div style="padding:12px;color:var(--red)">Error loading share data.</div>'; return; }
      const share = shares.find(s => s.name === name);
      if (!share) { panel.innerHTML = '<div style="padding:12px;color:var(--red)">Share not found.</div>'; return; }

      const enabled  = share.nfs_enabled ? 'checked' : '';
      const clients  = share.nfs_clients  || '*';
      const options  = share.nfs_options  || 'rw,sync,no_subtree_check,no_root_squash';

      panel.innerHTML = `
        <div class="share-perms-body">
          <div class="perms-row" style="align-items:center;margin-bottom:12px">
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;cursor:pointer">
              <input type="checkbox" id="nfs-enabled-${name}" ${enabled} style="accent-color:var(--accent)">
              Enable NFS export for this share
            </label>
          </div>
          <div class="perms-row" style="flex-direction:column;gap:4px;margin-bottom:10px">
            <label class="settings-label">Allowed Clients</label>
            <input type="text" class="install-input" id="nfs-clients-${name}" value="${clients}"
              placeholder="* or 192.168.1.0/24 or hostname" style="max-width:320px">
            <div style="font-size:11px;color:var(--text-dim);margin-top:2px">
              Use * for all, or a subnet like 192.168.1.0/24, or a specific IP
            </div>
          </div>
          <div class="perms-row" style="flex-direction:column;gap:4px;margin-bottom:14px">
            <label class="settings-label">Export Options</label>
            <input type="text" class="install-input" id="nfs-options-${name}" value="${options}"
              placeholder="rw,sync,no_subtree_check,no_root_squash" style="max-width:400px">
            <div style="font-size:11px;color:var(--text-dim);margin-top:2px">
              Common: rw/ro, sync/async, no_subtree_check, no_root_squash/root_squash
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="saveShareNfs('${name}')">Save NFS</button>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('share-nfs-${name}').classList.add('hidden')">Cancel</button>
          </div>
        </div>`;
    })
    .catch(() => { panel.innerHTML = '<div style="padding:12px;color:var(--red)">Failed to load shares.</div>'; });
}

function saveShareNfs(name) {
  const enabled = document.getElementById('nfs-enabled-' + name).checked ? 'true' : 'false';
  const clients = document.getElementById('nfs-clients-' + name).value.trim() || '*';
  const options = document.getElementById('nfs-options-' + name).value.trim() || 'rw,sync,no_subtree_check,no_root_squash';

  slog('cmd', `Updating NFS for ${name}...`);
  runCmd(['shares-set-nfs', name, enabled, clients, options], 'shares-log-panel')
    .then(() => {
      slog('success', `NFS settings saved for ${name}.`);
      document.getElementById('share-nfs-' + name).classList.add('hidden');
      refreshShares();
    })
    .catch(err => slog('error', String(err)));
}

function toggleSharePassword(name) {
  const panel = document.getElementById('share-pw-' + name);
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    document.getElementById('share-pw-input-' + name).focus();
  }
}

function saveSharePassword(name) {
  const pw  = document.getElementById('share-pw-input-' + name).value;
  const msg = document.getElementById('share-pw-msg-' + name);
  msg.textContent = 'Saving...';
  msg.style.color = 'var(--text-muted)';

  cockpit.spawn(['freeraid', 'shares-set-password', name, pw], { superuser: 'require', err: 'message' })
    .stream(d => { msg.textContent = d.trim(); })
    .then(() => {
      msg.style.color = 'var(--green)';
      msg.textContent = pw ? `Password set. Connect as: freeraid_share_${name}` : 'Password removed.';
      document.getElementById('share-pw-input-' + name).value = '';
      setTimeout(() => {
        document.getElementById('share-pw-' + name).classList.add('hidden');
        refreshShares();
      }, 1500);
    })
    .catch(err => {
      msg.style.color = 'var(--red)';
      msg.textContent = String(err);
    });
}

function toggleShareEnc(name) {
  const panel = document.getElementById('share-enc-' + name);
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  _loadEncPanel(name);
}

function _loadEncPanel(name) {
  const inner = document.getElementById('share-enc-inner-' + name);
  inner.innerHTML = '<div class="loading-msg">Checking encryption status...</div>';
  let buf = '';
  cockpit.spawn(['freeraid', 'share-encrypt-status', name], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      let status = { encrypted: false, unlocked: false };
      try { status = JSON.parse(buf.trim()); } catch(_) {}
      _renderEncPanel(name, status);
    })
    .catch(err => {
      inner.innerHTML = `<div style="padding:8px;color:var(--red)">Error: ${err}</div>`;
    });
}

function _renderEncPanel(name, status) {
  const inner = document.getElementById('share-enc-inner-' + name);
  const nameJson = JSON.stringify(name);
  if (!status.encrypted) {
    inner.innerHTML = `
      <div class="panel-title">Encryption — ${name}</div>
      <p style="font-size:0.85em;color:var(--text-dim);margin:0 0 12px">
        Enable per-share encryption using gocryptfs. Files on disk will be encrypted at rest.
        You will need to unlock the share after each reboot. Requires <code>gocryptfs</code> installed.
      </p>
      <label class="field-label">Encryption Password</label>
      <input type="password" id="share-enc-pw-${name}" class="text-input" placeholder="Set a strong password" autocomplete="new-password">
      <label class="field-label" style="margin-top:8px">Confirm Password</label>
      <input type="password" id="share-enc-pw2-${name}" class="text-input" placeholder="Confirm password" autocomplete="new-password">
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="doShareEncEnable(${nameJson})">Enable Encryption</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('share-enc-${name}').classList.add('hidden')">Cancel</button>
      </div>
      <div id="share-enc-msg-${name}" style="margin-top:8px;font-size:0.85em"></div>`;
  } else if (!status.unlocked) {
    inner.innerHTML = `
      <div class="panel-title">Encryption — ${name} <span class="badge badge-enc">Encrypted</span> <span class="badge" style="background:#2a1a1a;color:#f87171">Locked</span></div>
      <p style="font-size:0.85em;color:var(--text-dim);margin:0 0 12px">
        This share is encrypted and currently locked. Enter the password to unlock it and make files accessible.
      </p>
      <label class="field-label">Password</label>
      <input type="password" id="share-enc-pw-${name}" class="text-input" placeholder="Encryption password" autocomplete="current-password">
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="doShareEncUnlock(${nameJson})">Unlock</button>
        <button class="btn btn-danger btn-sm" onclick="doShareEncDisable(${nameJson})">Remove Encryption</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('share-enc-${name}').classList.add('hidden')">Cancel</button>
      </div>
      <div id="share-enc-msg-${name}" style="margin-top:8px;font-size:0.85em"></div>`;
  } else {
    inner.innerHTML = `
      <div class="panel-title">Encryption — ${name} <span class="badge badge-enc">Encrypted</span> <span class="badge" style="background:#0d2b1a;color:var(--green)">Unlocked</span></div>
      <p style="font-size:0.85em;color:var(--text-dim);margin:0 0 12px">
        Share is encrypted and unlocked. Files are accessible. You can lock it now or remove encryption entirely.
      </p>
      <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="doShareEncLock(${nameJson})">Lock Now</button>
        <button class="btn btn-danger btn-sm" onclick="doShareEncDisable(${nameJson})">Remove Encryption</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('share-enc-${name}').classList.add('hidden')">Cancel</button>
      </div>
      <div id="share-enc-msg-${name}" style="margin-top:8px;font-size:0.85em"></div>`;
  }
}

function doShareEncEnable(name) {
  const pw  = document.getElementById('share-enc-pw-'  + name).value;
  const pw2 = document.getElementById('share-enc-pw2-' + name).value;
  const msg = document.getElementById('share-enc-msg-' + name);
  if (!pw) { msg.style.color = 'var(--red)'; msg.textContent = 'Password is required.'; return; }
  if (pw !== pw2) { msg.style.color = 'var(--red)'; msg.textContent = 'Passwords do not match.'; return; }
  msg.style.color = 'var(--text-dim)';
  msg.textContent = 'Initialising vault... this may take a moment.';
  cockpit.spawn(['freeraid', 'share-encrypt-enable', name, pw], { superuser: 'require', err: 'out' })
    .then(() => {
      msg.style.color = 'var(--green)';
      msg.textContent = 'Encryption enabled. Share is now encrypted and unlocked.';
      setTimeout(() => { refreshShares(); _loadEncPanel(name); }, 1500);
    })
    .catch(err => { msg.style.color = 'var(--red)'; msg.textContent = String(err); });
}

function doShareEncDisable(name) {
  const inner = document.getElementById('share-enc-inner-' + name);
  const pw = inner.querySelector('input[type="password"]') ? inner.querySelector('input[type="password"]').value : '';
  if (!confirm('Remove encryption from "' + name + '"? All files will be decrypted and stored in plaintext.')) return;
  if (!pw) {
    const p = prompt('Enter the encryption password to decrypt files:');
    if (!p) return;
    _runEncCommand('share-encrypt-disable', name, p);
  } else {
    _runEncCommand('share-encrypt-disable', name, pw);
  }
}

function doShareEncUnlock(name) {
  const pw  = document.getElementById('share-enc-pw-' + name).value;
  const msg = document.getElementById('share-enc-msg-' + name);
  if (!pw) { msg.style.color = 'var(--red)'; msg.textContent = 'Password required.'; return; }
  msg.style.color = 'var(--text-dim)'; msg.textContent = 'Unlocking...';
  cockpit.spawn(['freeraid', 'share-encrypt-unlock', name, pw], { superuser: 'require', err: 'out' })
    .then(() => {
      msg.style.color = 'var(--green)'; msg.textContent = 'Unlocked.';
      setTimeout(() => { refreshShares(); _loadEncPanel(name); }, 1000);
    })
    .catch(err => { msg.style.color = 'var(--red)'; msg.textContent = String(err); });
}

function doShareEncLock(name) {
  const msg = document.getElementById('share-enc-msg-' + name);
  msg.style.color = 'var(--text-dim)'; msg.textContent = 'Locking...';
  cockpit.spawn(['freeraid', 'share-encrypt-lock', name], { superuser: 'require', err: 'out' })
    .then(() => {
      msg.style.color = 'var(--green)'; msg.textContent = 'Locked.';
      setTimeout(() => { refreshShares(); _loadEncPanel(name); }, 1000);
    })
    .catch(err => { msg.style.color = 'var(--red)'; msg.textContent = String(err); });
}

function _runEncCommand(cmd, name, pw) {
  const msg = document.getElementById('share-enc-msg-' + name);
  if (msg) { msg.style.color = 'var(--text-dim)'; msg.textContent = 'Working...'; }
  cockpit.spawn(['freeraid', cmd, name, pw], { superuser: 'require', err: 'out' })
    .then(() => {
      if (msg) { msg.style.color = 'var(--green)'; msg.textContent = 'Done.'; }
      setTimeout(() => { refreshShares(); _loadEncPanel(name); }, 1200);
    })
    .catch(err => {
      if (msg) { msg.style.color = 'var(--red)'; msg.textContent = String(err); }
    });
}

function toggleAddShare() {
  document.getElementById('add-share-form').classList.toggle('hidden');
}

function doAddShare() {
  const name     = document.getElementById('new-share-name').value.trim();
  const comment  = document.getElementById('new-share-comment').value.trim();
  const security = document.getElementById('new-share-security').value;
  const pool     = document.getElementById('new-share-pool').value;
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
          `jq '(.shares[] | select(.name=="${name}")) |= . + {"comment":"${comment}","smb_security":"${security}","pool":"${pool}","cache_mode":"${cache}","smb_enabled":${smb},"nfs_enabled":${nfs}}' /boot/config/freeraid.conf.json > /tmp/fr.tmp && mv /tmp/fr.tmp /boot/config/freeraid.conf.json`
        ], { superuser: 'require' })
          .then(resolve).catch(reject);
      });
    })
    .then(() => runCmd(['shares-apply'], 'shares-log-panel'))
    .then(() => {
      document.getElementById('new-share-name').value    = '';
      document.getElementById('new-share-comment').value = '';
      refreshShares();
      slog('success', `Share "${name}" created and active.`);
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

// ── App Browser ───────────────────────────────────────────────────────────────

let _appBrowserOpen = false;
let _appBrowserLoaded = false;
let _appSearchTimer = null;

function toggleAppBrowser() {
  const panel = document.getElementById('app-browser-panel');
  _appBrowserOpen = !_appBrowserOpen;
  panel.classList.toggle('hidden', !_appBrowserOpen);
  if (_appBrowserOpen && !_appBrowserLoaded) {
    loadAppBrowser();
  }
}

function loadAppBrowser() {
  const grid = document.getElementById('app-grid');
  grid.innerHTML = '<div class="loading-msg">Loading app library...</div>';

  // Check if feed is cached
  cockpit.spawn(['freeraid', 'apps-search', '', '50'], { superuser: 'require', err: 'out' })
    .then(out => {
      let apps;
      try { apps = JSON.parse(out.trim()); } catch(e) {
        // Feed not cached yet
        grid.innerHTML = `<div class="app-feed-empty">
          <div style="font-size:28px;margin-bottom:8px">📦</div>
          <div style="font-weight:600;margin-bottom:4px">App feed not downloaded yet</div>
          <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Click "Update Feed" to download 3000+ community apps</div>
          <button class="btn btn-primary" onclick="refreshAppFeed()">Download App Feed</button>
        </div>`;
        return;
      }
      _appBrowserLoaded = true;
      renderAppGrid(apps);
      loadAppCategories();
    })
    .catch(() => {
      grid.innerHTML = '<div class="app-feed-empty">Failed to load apps. Try clicking "Update Feed".</div>';
    });
}

function loadAppCategories() {
  cockpit.spawn(['freeraid', 'apps-categories'], { superuser: 'require', err: 'out' })
    .then(out => {
      let cats;
      try { cats = JSON.parse(out.trim()); } catch(e) { return; }
      const sel = document.getElementById('app-category-filter');
      cats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        sel.appendChild(opt);
      });
    })
    .catch(() => {});
}

function searchApps() {
  clearTimeout(_appSearchTimer);
  _appSearchTimer = setTimeout(() => {
    const q   = document.getElementById('app-search-input').value.trim();
    const cat = document.getElementById('app-category-filter').value;
    const grid = document.getElementById('app-grid');
    grid.innerHTML = '<div class="loading-msg">Searching...</div>';
    const args = ['apps-search', q || '', '80'];
    cockpit.spawn(['freeraid', ...args], { superuser: 'require', err: 'out' })
      .then(out => {
        let apps;
        try { apps = JSON.parse(out.trim()); } catch(e) { grid.innerHTML = '<div class="loading-msg">No results.</div>'; return; }
        if (cat) apps = apps.filter(a => (a.categories || []).some(c => c === cat));
        renderAppGrid(apps);
      })
      .catch(() => { grid.innerHTML = '<div class="loading-msg">Search failed.</div>'; });
  }, 300);
}

function renderAppGrid(apps) {
  const grid = document.getElementById('app-grid');
  if (!apps.length) { grid.innerHTML = '<div class="loading-msg">No apps found.</div>'; return; }
  grid.innerHTML = apps.map(a => {
    const icon = a.icon
      ? `<img src="${a.icon}" class="app-icon" onerror="this.style.display='none'">`
      : `<div class="app-icon-placeholder">${(a.name||'?')[0]}</div>`;
    const cats = (a.categories || []).slice(0,2).map(c =>
      `<span class="app-cat-badge">${c.split(':').pop()}</span>`).join('');
    const dl = a.downloads > 1000 ? `${(a.downloads/1000).toFixed(0)}k` : (a.downloads || '');
    return `<div class="app-card" onclick="openAppInstall('${encodeURIComponent(a.name)}')">
      <div class="app-card-icon">${icon}</div>
      <div class="app-card-body">
        <div class="app-card-name">${a.name}</div>
        <div class="app-card-desc">${a.overview || ''}</div>
        <div class="app-card-footer">${cats}${dl ? `<span class="app-dl-count">↓${dl}</span>` : ''}</div>
      </div>
    </div>`;
  }).join('');
}

function refreshAppFeed() {
  const btn  = document.getElementById('app-feed-btn');
  const grid = document.getElementById('app-grid');
  btn.disabled = true;
  btn.textContent = 'Updating...';
  grid.innerHTML = '<div class="loading-msg">Downloading app feed (~10MB)...</div>';
  cockpit.spawn(['freeraid', 'apps-fetch'], { superuser: 'require', err: 'out' })
    .then(() => {
      _appBrowserLoaded = false;
      loadAppBrowser();
      loadAppCategories();
      showAlert('success', 'App feed updated.');
    })
    .catch(err => showAlert('error', 'Feed update failed: ' + err))
    .finally(() => { btn.disabled = false; btn.textContent = 'Update Feed'; });
}

let _usedPorts = new Set();

function openAppInstall(encodedName) {
  const name = decodeURIComponent(encodedName);
  const backdrop = document.getElementById('app-install-backdrop');
  const body     = document.getElementById('app-install-body');
  const title    = document.getElementById('app-install-title');
  const iconEl   = document.getElementById('app-install-icon');
  title.textContent = name;
  body.innerHTML = '<div class="loading-msg">Loading...</div>';
  backdrop.classList.remove('hidden');

  // Fetch app data and used ports in parallel
  Promise.all([
    cockpit.spawn(['freeraid', 'apps-get', name], { superuser: 'require', err: 'out' }),
    cockpit.spawn(['freeraid', 'ports-used'], { superuser: 'require', err: 'out' })
  ]).then(([appOut, portsOut]) => {
    let app;
    try { app = JSON.parse(appOut.trim()); } catch(e) { body.innerHTML = '<div class="loading-msg">Failed to load app.</div>'; return; }
    if (app.error) { body.innerHTML = `<div class="loading-msg">${app.error}</div>`; return; }

    try { _usedPorts = new Set(JSON.parse(portsOut.trim())); } catch(e) { _usedPorts = new Set(); }

    iconEl.src = app.icon || '';
    body.innerHTML = renderInstallForm(app);
  }).catch(err => { body.innerHTML = `<div class="loading-msg">${err}</div>`; });
}

function closeAppInstall() {
  document.getElementById('app-install-backdrop').classList.add('hidden');
}

function renderInstallForm(app, isEdit = false) {
  const cfg = app.config || [];
  const ports = cfg.filter(c => c.type === 'Port');
  const paths = cfg.filter(c => c.type === 'Path');
  const vars  = cfg.filter(c => c.type === 'Variable' || c.type === 'env');
  const other = cfg.filter(c => !['Port','Path','Variable','env'].includes(c.type));

  const nextFreePort = (start) => {
    let p = parseInt(start) || 8080;
    while (_usedPorts.has(p)) p++;
    return p;
  };

  const fieldHtml = (label, items) => {
    if (!items.length) return '';
    return `<div class="install-group-title">${label}</div>` +
      items.map(c => {
        let val = c.default || '';
        let conflict = false;
        let suggestion = '';
        if (c.type === 'Port' && val) {
          const portNum = parseInt(val);
          if (_usedPorts.has(portNum)) {
            conflict = true;
            const suggested = nextFreePort(portNum + 1);
            suggestion = suggested;
            val = String(suggested);
          }
        }
        const conflictHtml = conflict
          ? `<div class="port-conflict">⚠ Port ${c.default} in use — auto-set to ${suggestion}</div>`
          : '';
        return `
        <div class="install-field">
          <label class="install-label">${c.name || c.target}${c.required ? ' <span style="color:var(--red)">*</span>' : ''}</label>
          ${c.desc ? `<div class="install-desc">${c.desc}</div>` : ''}
          ${conflictHtml}
          <input type="${c.mask ? 'password' : 'text'}" class="install-input${conflict ? ' port-conflict-input' : ''}"
            data-target="${c.target}" data-type="${c.type}"
            value="${val}" placeholder="${c.default || ''}">
        </div>`;
      }).join('');
  };

  const safeName = app.name.replace(/'/g, "\\'");
  const defaultNet = app.network || 'bridge';

  return `
    <div class="install-overview">${app.overview || ''}</div>
    <div class="install-meta">
      <span><strong>Image:</strong> ${app.image}</span>
      ${app.webui ? `<span><strong>Web UI:</strong> ${app.webui}</span>` : ''}
    </div>
    <div id="install-form">
      ${fieldHtml('Ports', ports)}
      ${fieldHtml('Paths / Volumes', paths)}
      ${fieldHtml('Environment Variables', vars)}
      ${fieldHtml('Other', other)}
      <div class="install-group-title">Network</div>
      <div class="install-field">
        <label class="install-label">Network Type</label>
        <select class="install-input install-select" data-type="freeraid.network" data-target="network"
          onchange="onNetworkTypeChange(this)">
          <option value="bridge"${defaultNet==='bridge'?' selected':''}>Bridge (NAT + port mapping)</option>
          <option value="host"${defaultNet==='host'?' selected':''}>Host (share host network)</option>
          <option value="custom">Custom (assign own IP)</option>
        </select>
      </div>
      <div class="install-field" id="custom-network-fields" style="display:none">
        <label class="install-label">Network Name</label>
        <div class="install-desc">Name of an existing Docker network (e.g. <code>freeraid-br</code>)</div>
        <input type="text" class="install-input" data-type="freeraid.network" data-target="network"
          id="custom-network-name" placeholder="freeraid-br">
        <label class="install-label" style="margin-top:8px">IP Address <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
        <input type="text" class="install-input" data-type="freeraid.network_ip" data-target="network_ip"
          id="custom-network-ip" placeholder="192.168.1.200">
      </div>
    </div>
    <div class="install-actions">
      <button class="btn btn-primary" onclick="doInstallApp('${safeName}')">
        ${isEdit ? 'Save &amp; Restart' : 'Install'}
      </button>
      <button class="btn btn-secondary" onclick="doInstallApp('${safeName}', false)">
        ${isEdit ? 'Save (no restart)' : "Install (don't start)"}
      </button>
      <button class="btn btn-ghost" onclick="closeAppInstall()">Cancel</button>
    </div>`;
}

function onNetworkTypeChange(sel) {
  const custom = document.getElementById('custom-network-fields');
  if (!custom) return;
  custom.style.display = sel.value === 'custom' ? '' : 'none';
}

function doInstallApp(name, autoStart = true) {
  const form = document.getElementById('install-form');
  const inputs = form.querySelectorAll('.install-input');

  // Build config — for network, use custom fields if "custom" is selected, else use the select value
  const netSel = form.querySelector('select[data-type="freeraid.network"]');
  const isCustomNet = netSel && netSel.value === 'custom';
  const config = [];
  const seen = new Set();
  for (const inp of inputs) {
    const t = inp.dataset.type;
    const tgt = inp.dataset.target;
    if (!t) continue;
    // Skip the dropdown when custom mode is active (custom text input takes precedence)
    if (isCustomNet && inp.tagName === 'SELECT' && t === 'freeraid.network') continue;
    // Skip custom fields when not in custom mode
    if (!isCustomNet && inp.id === 'custom-network-name') continue;
    if (!isCustomNet && inp.id === 'custom-network-ip') continue;
    config.push({ type: t, target: tgt, value: inp.value });
  }

  // If editing, grab the existing slug to stop before reinstalling
  const editSlug = document.getElementById('app-install-body')?._editSlug || null;

  closeAppInstall();
  dklog('cmd', `${editSlug ? 'Updating' : 'Installing'} ${name}...`);

  // For edits: stop running container first, then overwrite compose
  const preStep = editSlug
    ? cockpit.spawn(['freeraid', 'docker-stop', editSlug], { superuser: 'require', err: 'out' }).catch(() => {})
    : Promise.resolve();

  preStep.then(() =>
    cockpit.spawn(['freeraid', 'apps-install', name, JSON.stringify(config)], { superuser: 'require', err: 'out' })
  ).then(out => {
      let result;
      try { result = JSON.parse(out.trim().split('\n').pop()); } catch(e) { result = {}; }
      if (result.error) { dklog('error', result.error); showAlert('error', result.error); return; }
      dklog('success', `${name} saved as ${result.slug}`);
      if (autoStart) {
        dklog('cmd', `Starting ${result.slug}...`);
        return cockpit.spawn(['freeraid', 'docker-start', result.slug], { superuser: 'require', err: 'out' })
          .then(() => { dklog('success', `${name} started.`); refreshDocker(); showAlert('success', `${name} ${editSlug ? 'updated and restarted' : 'installed and started'}.`); })
          .catch(err => { dklog('error', String(err)); showAlert('error', `Save ok but start failed: ${err}`); refreshDocker(); });
      }
      refreshDocker();
      showAlert('success', `${name} ${editSlug ? 'updated' : 'installed'}. Start it from the Containers list.`);
    })
    .catch(err => { dklog('error', String(err)); showAlert('error', String(err)); });
}

// ── Tailscale ─────────────────────────────────────────────────────────────────

function refreshTailscale() {
  cockpit.spawn(['freeraid', 'tailscale-status'], { superuser: 'require', err: 'out' })
    .then(out => {
      try { applyTailscaleStatus(JSON.parse(out.trim())); } catch(_) {}
    }).catch(() => {});
}

function applyTailscaleStatus(s) {
  document.getElementById('ts-loading').style.display = 'none';
  const notInst = document.getElementById('ts-not-installed');
  const inst    = document.getElementById('ts-installed');

  if (!s.installed) {
    notInst.classList.remove('hidden');
    inst.classList.add('hidden');
    return;
  }
  notInst.classList.add('hidden');
  inst.classList.remove('hidden');

  const connected = s.state === 'Running' && s.online;
  document.getElementById('ts-dot').className = 'drive-status-dot ' + (connected ? 'dot-green' : 'dot-grey');
  document.getElementById('ts-state').textContent    = s.state || 'Unknown';
  document.getElementById('ts-ip').textContent       = s.ip    || '—';
  document.getElementById('ts-hostname').textContent = s.hostname || '—';

  document.getElementById('ts-btn-up').classList.toggle('hidden', connected);
  document.getElementById('ts-btn-down').classList.toggle('hidden', !connected);
}

function installTailscale() {
  log('cmd', 'Installing Tailscale...');
  document.getElementById('ts-not-installed').innerHTML = '<div style="color:var(--text-dim)">Installing... this may take a minute.</div>';
  cockpit.spawn(['freeraid', 'tailscale-install'], { superuser: 'require', err: 'out' })
    .stream(line => { const t = line.trim(); if (t) log('info', t); })
    .then(() => { log('success', 'Tailscale installed.'); refreshTailscale(); })
    .catch(err => log('error', 'Install failed: ' + err));
}

function tailscaleUp() {
  log('cmd', 'Connecting to Tailscale...');
  cockpit.spawn(['freeraid', 'tailscale-up'], { superuser: 'require', err: 'out' })
    .stream(line => { const t = line.trim(); if (t) log('info', t); })
    .then(out => {
      try {
        const r = JSON.parse(out.trim().split('\n').pop());
        if (r.needs_auth && r.auth_url) {
          const wrap = document.getElementById('ts-auth-wrap');
          const link = document.getElementById('ts-auth-url');
          wrap.classList.remove('hidden');
          link.href = r.auth_url;
          link.textContent = r.auth_url;
          log('info', 'Authentication required — open the URL shown in the Network tab.');
        }
      } catch(_) {}
      refreshTailscale();
    })
    .catch(err => log('error', 'Tailscale up failed: ' + err));
}

function tailscaleDown() {
  log('cmd', 'Disconnecting Tailscale...');
  cockpit.spawn(['freeraid', 'tailscale-down'], { superuser: 'require', err: 'out' })
    .then(() => { log('success', 'Tailscale disconnected.'); refreshTailscale(); })
    .catch(err => log('error', String(err)));
}

// ── Network Tab ───────────────────────────────────────────────────────────────

function refreshNetworkTab() {
  cockpit.spawn(['freeraid', 'network-info'], { superuser: 'require', err: 'out' })
    .then(out => {
      let ifaces;
      try { ifaces = JSON.parse(out.trim().split('\n').pop()); } catch(e) { ifaces = []; }
      if (ifaces.error) { document.getElementById('network-iface-list').innerHTML = `<div class="smart-error">${ifaces.error}</div>`; return; }

      // Populate hostname
      cockpit.spawn(['hostname'], { err: 'ignore' }).then(h => {
        const hn = h.trim();
        document.getElementById('net-hostname-current').textContent = hn;
        document.getElementById('net-hostname').value = hn;
      });

      const el = document.getElementById('network-iface-list');
      if (!ifaces.length) { el.innerHTML = '<div class="loading-msg">No interfaces found.</div>'; return; }

      el.innerHTML = ifaces.map(iface => `
        <div class="net-iface-card" id="iface-${iface.name}">
          <div class="net-iface-header">
            <span class="net-iface-name">${iface.name}</span>
            <span class="net-iface-mac">${iface.mac}</span>
            <span class="net-state-badge ${iface.state === 'UP' ? 'up' : 'down'}">${iface.state}</span>
            <div style="margin-left:auto;display:flex;gap:6px">
              <button class="btn btn-sm ${iface.mode==='dhcp'?'btn-primary':'btn-ghost'}"
                onclick="setIfaceDHCP('${iface.name}')">DHCP</button>
              <button class="btn btn-sm ${iface.mode==='static'?'btn-primary':'btn-ghost'}"
                onclick="showIfaceStatic('${iface.name}')">Static</button>
            </div>
          </div>
          <div class="net-iface-ip">${iface.ip ? `${iface.ip}/${iface.prefix}` : 'No IP'}</div>
          ${iface.gateway ? `<div class="net-iface-meta">Gateway: ${iface.gateway}</div>` : ''}
          ${iface.dns     ? `<div class="net-iface-meta">DNS: ${iface.dns}</div>` : ''}
          <div class="net-static-form hidden" id="static-form-${iface.name}">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:8px;align-items:end;margin-top:12px">
              <div>
                <label class="install-label">IP Address / Prefix</label>
                <input type="text" class="install-input" id="sf-ip-${iface.name}"
                  value="${iface.ip ? iface.ip+'/'+iface.prefix : ''}" placeholder="192.168.1.100/24">
              </div>
              <div>
                <label class="install-label">Gateway</label>
                <input type="text" class="install-input" id="sf-gw-${iface.name}"
                  value="${iface.gateway}" placeholder="192.168.1.1">
              </div>
              <div>
                <label class="install-label">DNS</label>
                <input type="text" class="install-input" id="sf-dns-${iface.name}"
                  value="${iface.dns || '8.8.8.8 1.1.1.1'}" placeholder="8.8.8.8">
              </div>
              <div style="grid-column:span 1"></div>
              <button class="btn btn-primary" onclick="applyStatic('${iface.name}')">Apply</button>
            </div>
            <div style="font-size:11px;color:var(--accent-warn);margin-top:6px">
              ⚠ Applying a new IP may drop your current connection briefly.
            </div>
          </div>
        </div>`).join('');

      // Show static form if already static
      ifaces.filter(i => i.mode === 'static').forEach(i => showIfaceStatic(i.name));
    })
    .catch(err => { document.getElementById('network-iface-list').innerHTML = `<div class="smart-error">${err}</div>`; });
}

function saveHostname() {
  const name = document.getElementById('net-hostname').value.trim();
  if (!name) return;
  cockpit.spawn(['freeraid', 'set-hostname', name], { superuser: 'require', err: 'out' })
    .then(() => {
      document.getElementById('net-hostname-current').textContent = name;
      showAlert('success', `Hostname set to "${name}"`);
    })
    .catch(err => showAlert('error', String(err)));
}

function showIfaceStatic(name) {
  document.getElementById(`static-form-${name}`)?.classList.remove('hidden');
}

function setIfaceDHCP(name) {
  if (!confirm(`Switch ${name} to DHCP? Your IP address will change.`)) return;
  cockpit.spawn(['freeraid', 'network-set', name, 'dhcp'], { superuser: 'require', err: 'out' })
    .then(() => { showAlert('success', `${name} set to DHCP — IP will refresh shortly.`); setTimeout(refreshNetworkTab, 3000); })
    .catch(err => showAlert('error', String(err)));
}

function applyStatic(name) {
  const ip  = document.getElementById(`sf-ip-${name}`).value.trim();
  const gw  = document.getElementById(`sf-gw-${name}`).value.trim();
  const dns = document.getElementById(`sf-dns-${name}`).value.trim();
  if (!ip || !gw) { showAlert('error', 'IP and Gateway are required.'); return; }
  if (!confirm(`Apply static IP ${ip} to ${name}?\nYour connection may drop briefly.`)) return;
  cockpit.spawn(['freeraid', 'network-set', name, 'static', ip, gw, dns], { superuser: 'require', err: 'out' })
    .then(() => { showAlert('success', `Static IP applied to ${name}.`); setTimeout(refreshNetworkTab, 3000); })
    .catch(err => showAlert('error', String(err)));
}

// ── Users Tab ─────────────────────────────────────────────────────────────────

function refreshUsers() {
  cockpit.spawn(['freeraid', 'users-list'], { superuser: 'require', err: 'out' })
    .then(out => {
      let users;
      try { users = JSON.parse(out.trim().split('\n').pop()); } catch(e) { users = []; }
      const el = document.getElementById('user-list');
      if (!users.length) {
        el.innerHTML = '<div style="font-size:13px;color:var(--text-dim);padding:12px 0">No user accounts yet. Add one above to enable share access.</div>';
        return;
      }
      el.innerHTML = users.map(u => `
        <div class="user-row">
          <div class="user-avatar">${u.name[0].toUpperCase()}</div>
          <div class="user-info">
            <div class="user-name">${u.name}</div>
            <div class="user-meta">
              UID ${u.uid} · ${u.home}
              <span class="samba-badge ${u.samba ? 'samba-on' : 'samba-off'}">${u.samba ? '✓ Samba' : '✗ No Samba'}</span>
            </div>
          </div>
          <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
            ${u.samba
              ? `<button class="btn btn-sm btn-ghost" onclick="openChangePassword('${u.name}')">Change Password</button>
                 <button class="btn btn-sm btn-secondary" onclick="doDisableSamba('${u.name}')">Disable Samba</button>`
              : `<button class="btn btn-sm btn-primary" onclick="doEnableSamba('${u.name}')">Enable Samba</button>`
            }
            <button class="btn btn-sm btn-danger" onclick="doDeleteUser('${u.name}')">Delete</button>
          </div>
        </div>`).join('');
    })
    .catch(err => { document.getElementById('user-list').innerHTML = `<div class="smart-error">${err}</div>`; });

  // Load anon toggle state
  cockpit.spawn(['freeraid', 'shares-get-anon'], { superuser: 'require', err: 'out' })
    .then(out => {
      try {
        const d = JSON.parse(out.trim().split('\n').pop());
        document.getElementById('anon-toggle').checked = d.anon === true || d.anon === 'true';
      } catch(e) {}
    }).catch(() => {});
}

function toggleAddUser() {
  document.getElementById('add-user-form').classList.toggle('hidden');
  document.getElementById('new-username').focus();
}

function doAddUser() {
  const name  = document.getElementById('new-username').value.trim();
  const pass  = document.getElementById('new-password').value;
  const pass2 = document.getElementById('new-password2').value;
  if (!name)          { showAlert('error', 'Username required.');           return; }
  if (!pass)          { showAlert('error', 'Password required.');           return; }
  if (pass !== pass2) { showAlert('error', 'Passwords do not match.');      return; }
  cockpit.spawn(['freeraid', 'users-add', name, pass], { superuser: 'require', err: 'out' })
    .then(() => {
      showAlert('success', `User "${name}" created.`);
      document.getElementById('new-username').value = '';
      document.getElementById('new-password').value = '';
      document.getElementById('new-password2').value = '';
      document.getElementById('add-user-form').classList.add('hidden');
      refreshUsers();
    })
    .catch(err => showAlert('error', String(err)));
}

function doDeleteUser(name) {
  if (!confirm(`Delete user "${name}"?\nThis removes their system account and Samba access.`)) return;
  cockpit.spawn(['freeraid', 'users-delete', name], { superuser: 'require', err: 'out' })
    .then(() => { showAlert('success', `User "${name}" deleted.`); refreshUsers(); })
    .catch(err => showAlert('error', String(err)));
}

function openChangePassword(name) {
  const pass = prompt(`New password for ${name}:`);
  if (!pass) return;
  const pass2 = prompt('Confirm new password:');
  if (pass !== pass2) { showAlert('error', 'Passwords do not match.'); return; }
  cockpit.spawn(['freeraid', 'users-setpassword', name, pass], { superuser: 'require', err: 'out' })
    .then(() => showAlert('success', `Password updated for "${name}".`))
    .catch(err => showAlert('error', String(err)));
}

function doEnableSamba(name) {
  const pass = prompt(`Set a Samba password for "${name}":`);
  if (!pass) return;
  const pass2 = prompt('Confirm password:');
  if (pass !== pass2) { showAlert('error', 'Passwords do not match.'); return; }
  cockpit.spawn(['freeraid', 'users-enable-samba', name, pass], { superuser: 'require', err: 'out' })
    .then(() => { showAlert('success', `Samba enabled for "${name}".`); refreshUsers(); })
    .catch(err => showAlert('error', String(err)));
}

function doDisableSamba(name) {
  if (!confirm(`Remove Samba access for "${name}"?\nThey will no longer be able to connect to shares.`)) return;
  cockpit.spawn(['freeraid', 'users-disable-samba', name], { superuser: 'require', err: 'out' })
    .then(() => { showAlert('success', `Samba disabled for "${name}".`); refreshUsers(); })
    .catch(err => showAlert('error', String(err)));
}

// ── Parity Schedule ──────────────────────────────────────────────────────────

function loadParitySchedule() {
  cockpit.spawn(['freeraid', 'parity-get-schedule'], { superuser: 'require', err: 'out' })
    .then(out => {
      try {
        const d = JSON.parse(out.trim().split('\n').pop());
        document.getElementById('parity-freq').value = d.freq || 'weekly';
        document.getElementById('parity-day').value  = d.day  || 'Sun';
        document.getElementById('parity-time').value = d.time || '04:00';
        onParityFreqChange();
      } catch(e) {}
    }).catch(() => {});
}

function onParityFreqChange() {
  const freq = document.getElementById('parity-freq').value;
  document.getElementById('parity-day-wrap').style.display = freq === 'weekly' ? '' : 'none';
}

function saveParitySchedule() {
  const freq = document.getElementById('parity-freq').value;
  const day  = document.getElementById('parity-day').value;
  const time = document.getElementById('parity-time').value;
  cockpit.spawn(['freeraid', 'parity-set-schedule', freq, day, time], { superuser: 'require', err: 'out' })
    .then(() => showAlert('success', 'Parity check schedule saved.'))
    .catch(err => showAlert('error', String(err)));
}

// ── Cache Mover ───────────────────────────────────────────────────────────────

function loadMoverStatus() {
  cockpit.spawn(['freeraid', 'mover-status'], { superuser: 'require', err: 'out' })
    .then(out => {
      try {
        const d = JSON.parse(out.trim().split('\n').pop());
        document.getElementById('mover-enabled').checked = d.enabled === true || d.enabled === 'true';
        document.getElementById('mover-time').value      = d.time || '02:00';
        document.getElementById('mover-last-run').textContent = d.last_run || 'never';
      } catch(e) {}
    }).catch(() => {});
}

function saveMoverSchedule() {
  const enabled = document.getElementById('mover-enabled').checked;
  const time    = document.getElementById('mover-time').value;
  cockpit.spawn(['freeraid', 'mover-set-schedule', enabled ? 'true' : 'false', time], { superuser: 'require', err: 'out' })
    .then(() => showAlert('success', `Mover ${enabled ? 'enabled' : 'disabled'} — runs daily at ${time}.`))
    .catch(err => showAlert('error', String(err)));
}

function runMoverNow() {
  appendLog('log-panel', 'cmd', 'Running cache mover...');
  cockpit.spawn(['freeraid', 'mover-run'], { superuser: 'require', err: 'out' })
    .then(out => {
      try {
        const d = JSON.parse(out.trim().split('\n').pop());
        appendLog('log-panel', 'success', `Mover complete — ${d.shares_processed} share(s) processed.`);
        loadMoverStatus();
      } catch(e) { appendLog('log-panel', 'success', 'Mover complete.'); }
    })
    .catch(err => appendLog('log-panel', 'error', String(err)));
}

// ── UPS / NUT ─────────────────────────────────────────────────────────────────

function refreshUpsStatus() {
  cockpit.spawn(['freeraid', 'ups-status'], { superuser: 'require', err: 'out' })
    .then(out => {
      try { applyUpsStatus(JSON.parse(out.trim())); } catch(_) {}
    }).catch(() => {});
}

function applyUpsStatus(s) {
  const card = document.getElementById('ups-card');
  if (!card) return;

  if (!s.available) {
    card.style.display = 'none';
    const res = document.getElementById('ups-test-result');
    if (res) res.textContent = s.error || 'UPS unavailable';
    return;
  }

  card.style.display = '';

  const onBatt = s.on_battery;
  const statusLabel = onBatt ? '⚡ On Battery' : '✔ On Mains';
  const statusColor = onBatt ? 'var(--yellow)' : 'var(--green)';

  const statusEl = document.getElementById('ups-status-val');
  if (statusEl) { statusEl.textContent = statusLabel; statusEl.style.color = statusColor; }

  const battPct = parseInt(s.battery_pct) || 0;
  const loadPct = parseInt(s.load_pct)    || 0;

  const battBar = document.getElementById('ups-batt-bar');
  if (battBar) {
    battBar.style.width = battPct + '%';
    battBar.style.background = battPct < 25 ? 'var(--red)' : battPct < 50 ? 'var(--yellow)' : 'var(--green)';
  }
  const battPctEl = document.getElementById('ups-batt-pct');
  if (battPctEl) battPctEl.textContent = battPct + '%';

  const loadBar = document.getElementById('ups-load-bar');
  if (loadBar) loadBar.style.width = loadPct + '%';
  const loadPctEl = document.getElementById('ups-load-pct');
  if (loadPctEl) loadPctEl.textContent = loadPct + '%';

  const runtimeEl = document.getElementById('ups-runtime');
  if (runtimeEl) runtimeEl.textContent = `Runtime: ${s.runtime_mins}min  •  ${s.model}`;

  const res = document.getElementById('ups-test-result');
  if (res) res.textContent = '';
}

function loadUpsConfig() {
  cockpit.spawn(['freeraid', 'ups-config-get'], { superuser: 'require', err: 'out' })
    .then(out => {
      try {
        const c = JSON.parse(out.trim());
        document.getElementById('ups-enabled').checked      = !!c.enabled;
        document.getElementById('ups-mode').value           = c.mode         || 'standalone';
        document.getElementById('ups-name').value           = c.name         || 'ups';
        document.getElementById('ups-driver').value         = c.driver       || 'usbhid-ups';
        document.getElementById('ups-port').value           = c.port         || 'auto';
        document.getElementById('ups-host').value           = c.host         || '';
        document.getElementById('ups-shutdown-pct').value   = c.shutdown_pct || 20;
        upsToggleMode();
      } catch(_) {}
    }).catch(() => {});
}

function upsToggleMode() {
  const mode = document.getElementById('ups-mode').value;
  document.getElementById('ups-standalone-fields').classList.toggle('hidden', mode !== 'standalone');
  document.getElementById('ups-netclient-fields').classList.toggle('hidden', mode !== 'netclient');
}

function saveUpsConfig() {
  const payload = {
    enabled:      document.getElementById('ups-enabled').checked,
    mode:         document.getElementById('ups-mode').value,
    name:         document.getElementById('ups-name').value.trim()           || 'ups',
    driver:       document.getElementById('ups-driver').value,
    port:         document.getElementById('ups-port').value.trim()           || 'auto',
    host:         document.getElementById('ups-host').value.trim()           || 'localhost',
    shutdown_pct: parseInt(document.getElementById('ups-shutdown-pct').value) || 20
  };
  log('cmd', 'Saving UPS configuration...');
  cockpit.spawn(['freeraid', 'ups-config-set', JSON.stringify(payload)], { superuser: 'require', err: 'out' })
    .stream(line => { const t = line.trim(); if (t) log('info', t); })
    .then(() => {
      log('success', 'UPS configuration saved.');
      refreshUpsStatus();
    })
    .catch(err => log('error', 'UPS config failed: ' + err));
}

// ── File Balancer ─────────────────────────────────────────────────────────────

let _balancerPoller = null;

function loadBalancerStatus() {
  cockpit.spawn(['freeraid', 'balance-status'], { superuser: 'require', err: 'out' })
    .then(out => {
      try { _applyBalancerStatus(JSON.parse(out.trim())); } catch(_) {}
    }).catch(() => {});
}

function _applyBalancerStatus(s) {
  // Disk usage mini-bars
  const barsEl = document.getElementById('balancer-disk-bars');
  if (barsEl && s.disks && s.disks.length) {
    barsEl.innerHTML = s.disks.map(d => {
      const pct = d.pct || 0;
      const barColor = pct >= 90 ? 'var(--red)' : pct >= 75 ? 'var(--yellow)' : 'var(--accent)';
      const name = d.mountpoint.split('/').pop() || d.device;
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px">
        <span style="width:50px;color:var(--text-dim);flex-shrink:0">${name}</span>
        <div style="flex:1;height:5px;background:var(--bg3);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px"></div>
        </div>
        <span style="width:32px;text-align:right;color:var(--text-dim)">${pct}%</span>
      </div>`;
    }).join('');
  }

  const running = !!s.running;
  document.getElementById('btn-balance-start').classList.toggle('hidden', running);
  document.getElementById('btn-balance-cancel').classList.toggle('hidden', !running);

  const prog = s.progress || {};
  const progressEl = document.getElementById('balancer-progress');
  if (progressEl) progressEl.classList.toggle('hidden', !running && prog.stage !== 'done');

  if (prog.stage) {
    const msgEl = document.getElementById('balancer-msg');
    if (msgEl) msgEl.textContent = prog.log || prog.stage;
    // Rough progress: use moved_bytes as proxy (cap at 100%)
    const barEl = document.getElementById('balancer-bar');
    if (barEl) {
      const pct = prog.stage === 'done' ? 100 : running ? 50 : 0;
      barEl.style.width = pct + '%';
      barEl.className = 'preclear-bar-fill ' + (prog.stage === 'done' ? 'preclear-bar-done' : 'preclear-bar-active');
    }
  }

  if (!running && _balancerPoller) {
    clearInterval(_balancerPoller);
    _balancerPoller = null;
    if (prog.stage === 'done') {
      log('success', `Balancer complete — moved ${prog.moved_files || 0} file(s).`);
    }
  }
}

function startBalancer() {
  const threshold = document.getElementById('balance-threshold').value || '10';
  log('cmd', `Starting file balancer (threshold: ${threshold}%)...`);
  cockpit.spawn(['freeraid', 'balance-bg', threshold], { superuser: 'require', err: 'out' })
    .then(() => {
      log('info', 'Balancer running in background...');
      _balancerPoller = setInterval(loadBalancerStatus, 4000);
      loadBalancerStatus();
    })
    .catch(err => log('error', 'Balancer failed to start: ' + err));
}

function cancelBalancer() {
  cockpit.spawn(['freeraid', 'balance-cancel'], { superuser: 'require', err: 'out' })
    .then(() => {
      log('info', 'Balancer cancelled.');
      if (_balancerPoller) { clearInterval(_balancerPoller); _balancerPoller = null; }
      loadBalancerStatus();
    })
    .catch(err => log('error', String(err)));
}

function loadTurboWrite() {
  cockpit.spawn(['freeraid', 'turbo-get'], { superuser: 'require', err: 'out' })
    .then(out => {
      try {
        const d = JSON.parse(out.trim());
        document.getElementById('turbo-enabled').checked = !!d.enabled;
        document.getElementById('turbo-warning').classList.toggle('hidden', !d.enabled);
      } catch(e) {}
    }).catch(() => {});
}

function setTurboWrite(enabled) {
  const label = enabled ? 'Enabling turbo write...' : 'Disabling turbo write and syncing parity...';
  log('cmd', label);
  document.getElementById('turbo-warning').classList.toggle('hidden', !enabled);
  cockpit.spawn(['freeraid', 'turbo-set', enabled ? 'true' : 'false'], { superuser: 'require', err: 'out' })
    .stream(line => { const t = line.trim(); if (t) log('info', t); })
    .then(() => {
      log('success', enabled ? 'Turbo write enabled.' : 'Turbo write disabled — parity synced.');
    })
    .catch(err => {
      log('error', 'Turbo write toggle failed: ' + err);
      loadTurboWrite(); // revert UI
    });
}

function setAnonAccess(enabled) {
  cockpit.spawn(['freeraid', 'shares-set-anon', enabled ? 'true' : 'false'], { superuser: 'require', err: 'out' })
    .then(() => showAlert('success', `Anonymous access ${enabled ? 'enabled' : 'disabled'}.`))
    .catch(err => { showAlert('error', String(err)); refreshUsers(); }); // revert toggle on error
}

// ── Docker Networks ────────────────────────────────────────────────────────────

function toggleNetworkPanel() {
  const panel = document.getElementById('network-create-panel');
  panel.classList.toggle('hidden');
}

function refreshNetworks() {
  const el = document.getElementById('network-list');
  if (!el) return;
  cockpit.spawn(['freeraid', 'docker-network-list'], { superuser: 'require', err: 'out' })
    .then(out => {
      let nets;
      try { nets = JSON.parse(out.trim().split('\n').pop()); } catch(e) { nets = []; }
      if (!nets.length) {
        el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No custom networks. Create one above to give containers their own LAN IP.</div>';
        return;
      }
      el.innerHTML = nets.map(n => `
        <div class="network-row">
          <span class="network-name">${n.name}</span>
          <span class="network-badge">${n.driver}</span>
          <span style="font-size:11px;color:var(--text-muted)">${n.subnet || ''}</span>
          <button class="btn btn-sm btn-danger" style="margin-left:auto" onclick="deleteNetwork('${n.name}')">Delete</button>
        </div>`).join('');
    })
    .catch(() => { el.innerHTML = '<div class="loading-msg">Could not load networks.</div>'; });
}

function doCreateNetwork() {
  const name    = document.getElementById('net-name').value.trim();
  const parent  = document.getElementById('net-parent').value.trim();
  const subnet  = document.getElementById('net-subnet').value.trim();
  const gateway = document.getElementById('net-gateway').value.trim();
  if (!name || !parent || !subnet || !gateway) {
    showAlert('error', 'All fields required to create a network.'); return;
  }
  dklog('cmd', `Creating network ${name}...`);
  cockpit.spawn(['freeraid', 'docker-network-create', name, parent, subnet, gateway],
    { superuser: 'require', err: 'out' })
    .then(() => {
      dklog('success', `Network ${name} created.`);
      showAlert('success', `Network "${name}" created. Select it as "Custom" in any container's network settings.`);
      document.getElementById('network-create-panel').classList.add('hidden');
      refreshNetworks();
    })
    .catch(err => { dklog('error', String(err)); showAlert('error', String(err)); });
}

function deleteNetwork(name) {
  if (!confirm(`Delete network "${name}"?\nContainers using it will lose network access.`)) return;
  cockpit.spawn(['freeraid', 'docker-network-delete', name], { superuser: 'require', err: 'out' })
    .then(() => { dklog('success', `Network ${name} deleted.`); refreshNetworks(); })
    .catch(err => { dklog('error', String(err)); showAlert('error', String(err)); });
}

function refreshDocker() {
  const el = document.getElementById('docker-container-list');
  el.innerHTML = '<div class="loading-msg">Loading...</div>';

  let buf = '';
  const listP = cockpit.spawn(['freeraid', 'docker-list'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; });
  const auP = cockpit.spawn(['freeraid', 'docker-autoupdate-get'], { superuser: 'require', err: 'out' });

  Promise.all([listP, auP])
    .then(([, auOut]) => {
      try {
        const jsonStart = buf.indexOf('[');
        const containers = JSON.parse(buf.slice(jsonStart));
        const autoupdate = JSON.parse(auOut || '{}');
        renderDocker(containers, autoupdate);
      } catch(e) {
        el.innerHTML = '<div class="loading-msg">Could not load containers.</div>';
      }
    })
    .catch(() => { el.innerHTML = '<div class="loading-msg">docker-list failed.</div>'; });
}

let _dockerSelection = new Set();
let _dockerContainers = [];

// Close context menu when clicking outside of it
document.addEventListener('click', (e) => {
  const m = document.getElementById('docker-ctx-menu');
  if (m && !e.target.closest('#docker-ctx-menu') && !e.target.closest('.btn-ctx-menu')) {
    m.remove();
  }
});

let _dockerAutoupdate = {};

function renderDocker(containers, autoupdate) {
  _dockerContainers = containers;
  if (autoupdate) _dockerAutoupdate = autoupdate;
  const el = document.getElementById('docker-container-list');

  const running = containers.filter(c => c.state === 'running').length;
  document.getElementById('docker-running-count').textContent = running;
  document.getElementById('docker-stopped-count').textContent = containers.length - running;
  document.getElementById('docker-total-count').textContent   = containers.length;

  const selectAllWrap = document.getElementById('docker-select-all-wrap');
  selectAllWrap.style.display = containers.length ? '' : 'none';

  if (!containers.length) {
    el.innerHTML = '<div class="loading-msg">No containers installed yet. Use the App Browser above to add apps.</div>';
    return;
  }

  el.innerHTML = containers.map(c => {
    const isRunning  = c.state === 'running';
    const dotClass   = isRunning ? 'dot-green' : 'dot-grey';
    const stateLabel = isRunning ? 'Running' : 'Stopped';
    const stateColor = isRunning ? 'var(--green)' : 'var(--text-dim)';
    const nameSafe   = c.name.replace(/'/g, "\\'");
    const checked    = _dockerSelection.has(c.name) ? 'checked' : '';
    const auChecked  = _dockerAutoupdate[c.name] ? 'checked' : '';
    const toggleBtn  = isRunning
      ? `<button class="btn btn-sm btn-danger" onclick="dockerStop('${nameSafe}')">Stop</button>`
      : `<button class="btn btn-sm btn-primary" onclick="dockerStart('${nameSafe}')">Start</button>`;

    // Ports display
    let portsHtml = '';
    if (isRunning && c.ports && c.ports.length) {
      portsHtml = `<div class="docker-ports">${c.ports.map(p =>
        `<span class="docker-port-badge">${p.host}→${p.container}</span>`
      ).join('')}</div>`;
    }

    // IP display — show host IP since Docker ports are forwarded to the host
    const ipHtml = isRunning && c.ports && c.ports.length
      ? `<div class="docker-ip">${window.location.hostname}</div>` : '';

    return `<div class="docker-card${isRunning ? ' running' : ''}" id="dcard-${c.name}">
      <input type="checkbox" class="docker-checkbox" ${checked}
        onchange="dockerSelectToggle('${nameSafe}', this.checked)">
      <div class="docker-header">
        <span class="drive-status-dot ${dotClass}"></span>
        <span class="docker-name">${c.name}</span>
        <button class="btn-ctx-menu" onclick="event.stopPropagation(); openDockerMenu(event, '${nameSafe}')">⋮</button>
      </div>
      <div class="docker-image">${c.image}</div>
      <div class="docker-state" style="color:${stateColor}">${stateLabel}</div>
      ${ipHtml}
      ${portsHtml}
      <div class="docker-actions">
        ${toggleBtn}
        <button class="btn btn-sm btn-ghost" onclick="dockerLogs('${nameSafe}')">Logs</button>
      </div>
      <div class="docker-autoupdate-row">
        <label class="autoupdate-label">
          <input type="checkbox" ${auChecked} onchange="setDockerAutoupdate('${nameSafe}', this.checked)">
          Auto-update
        </label>
      </div>
    </div>`;
  }).join('');
}

function setDockerAutoupdate(name, enabled) {
  _dockerAutoupdate[name] = enabled;
  cockpit.spawn(['freeraid', 'docker-autoupdate-set', name, enabled ? 'true' : 'false'],
    { superuser: 'require', err: 'out' })
    .catch(err => dklog('error', 'Failed to save auto-update setting: ' + err));
}

function dockerUpdateNow(name) {
  const existing = document.getElementById('docker-ctx-menu');
  if (existing) existing.remove();
  dklog('cmd', `Pulling latest image for ${name}...`);
  cockpit.spawn(['freeraid', 'docker-update', name], { superuser: 'require', err: 'out' })
    .stream(line => { const t = line.trim(); if (t) dklog('info', t); })
    .then(out => {
      try {
        const r = JSON.parse(out.trim().split('\n').pop());
        if (r.updated) dklog('success', `${name} updated to latest image.`);
        else dklog('info', `${name} is already up to date.`);
      } catch(_) {}
      refreshDocker();
    })
    .catch(err => dklog('error', `Update failed: ${err}`));
}

function openDockerMenu(event, name) {
  const existing = document.getElementById('docker-ctx-menu');
  if (existing) existing.remove();

  const c = _dockerContainers.find(x => x.name === name);
  if (!c) return;

  const isRunning = c.state === 'running';
  const hasWebUI  = c.webui && c.webui.trim();

  const menu = document.createElement('div');
  menu.id = 'docker-ctx-menu';
  menu.className = 'ctx-menu';

  const items = [];
  if (hasWebUI)  items.push(`<div class="ctx-item ctx-item-primary" onclick="dockerOpenWebUI('${name}')">🌐 Open Web UI</div>`);
  if (isRunning) items.push(`<div class="ctx-item" onclick="dockerTerminalCmd('${name}')">⬛ Terminal</div>`);
  items.push(`<div class="ctx-item" onclick="dockerEdit('${name}')">✎ Edit</div>`);
  items.push(`<div class="ctx-item" onclick="dockerLogs('${name}')">📋 Logs</div>`);
  items.push(`<div class="ctx-item" onclick="dockerUpdateNow('${name}')">⟳ Update Now</div>`);
  items.push(`<div class="ctx-sep"></div>`);
  if (isRunning) items.push(`<div class="ctx-item" onclick="dockerStop('${name}')">⏹ Stop</div>`);
  else           items.push(`<div class="ctx-item" onclick="dockerStart('${name}')">▶ Start</div>`);
  items.push(`<div class="ctx-item ctx-item-danger" onclick="dockerDeleteOne('${name}')">🗑 Delete</div>`);

  menu.innerHTML = items.join('');

  // Position near the button (fixed positioning — no scroll offset needed)
  const rect = event.target.getBoundingClientRect();
  const menuW = 190;
  let left = rect.right - menuW;
  let top  = rect.bottom + 4;
  // Keep within viewport
  if (left < 4) left = 4;
  if (top + 250 > window.innerHeight) top = rect.top - 250;
  menu.style.top  = top + 'px';
  menu.style.left = left + 'px';
  document.body.appendChild(menu);
}

function dockerOpenWebUI(name) {
  const c = _dockerContainers.find(x => x.name === name);
  if (!c || !c.webui) return;
  // Replace [IP] with the host's IP (ports are forwarded from the host, not the internal Docker bridge IP)
  const ip = window.location.hostname;
  let url = c.webui.replace('[IP]', ip).replace(/\[PORT:(\d+)\]/g, '$1');
  if (!url.startsWith('http')) url = 'http://' + url;
  window.open(url, '_blank');
}

// ── Terminal (new tab, xterm.js + Cockpit PTY) ────────────────────────────────

function dockerTerminalCmd(name) {
  const url = `terminal.html?container=${encodeURIComponent(name)}`;
  window.open(url, '_blank');
}

function terminalNewShell() {
  window.open('terminal.html?shell=1', '_blank');
}

function dockerEdit(name) {
  // Read current compose and pre-fill the install form with existing values
  const backdrop = document.getElementById('app-install-backdrop');
  const body     = document.getElementById('app-install-body');
  const title    = document.getElementById('app-install-title');
  const iconEl   = document.getElementById('app-install-icon');
  title.textContent = `Edit: ${name}`;
  iconEl.src = '';
  body.innerHTML = '<div class="loading-msg">Loading current config...</div>';
  backdrop.classList.remove('hidden');

  Promise.all([
    cockpit.spawn(['freeraid', 'docker-get-config', name], { superuser: 'require', err: 'out' }),
    cockpit.spawn(['freeraid', 'ports-used'],               { superuser: 'require', err: 'out' }),
  ]).then(([cfgOut, portsOut]) => {
    let app;
    try {
      const lines = cfgOut.trim().split('\n');
      app = JSON.parse(lines[lines.length - 1]);
    } catch(e) { body.innerHTML = `<div class="smart-error">Parse error: ${e}</div>`; return; }
    if (app.error) { body.innerHTML = `<div class="smart-error">${app.error}</div>`; return; }

    try {
      const portLines = portsOut.trim().split('\n');
      const ports = JSON.parse(portLines[portLines.length - 1]);
      _usedPorts = new Set(ports.map(Number));
    } catch(e) { _usedPorts = new Set(); }

    // Pre-fill network fields into the app object
    body.innerHTML = renderInstallForm(app, true);
    body._editSlug = name;  // used by doInstallApp to stop old container

    // Pre-select the correct network type
    const netSel = body.querySelector('select[data-type="freeraid.network"]');
    const customFields = body.querySelector('#custom-network-fields');
    const net = app.network || 'bridge';
    if (net === 'bridge' || net === 'host') {
      if (netSel) netSel.value = net;
    } else {
      if (netSel) netSel.value = 'custom';
      if (customFields) customFields.style.display = '';
      const nameInput = body.querySelector('#custom-network-name');
      const ipInput   = body.querySelector('#custom-network-ip');
      if (nameInput) nameInput.value = net;
      if (ipInput)   ipInput.value   = app.network_ip || '';
    }
  }).catch(err => { body.innerHTML = `<div class="smart-error">${err}</div>`; });
}

function dockerDeleteOne(name) {
  if (!confirm(`Delete ${name}?\n\nThis removes the compose file. Container data is NOT deleted.`)) return;
  const c = _dockerContainers.find(x => x.name === name);
  const nameSafe = name;
  const stopFirst = c && c.state === 'running'
    ? cockpit.spawn(['freeraid', 'docker-stop', nameSafe], { superuser: 'require', err: 'out' })
    : Promise.resolve();
  stopFirst.then(() =>
    cockpit.spawn(['freeraid', 'docker-delete', nameSafe], { superuser: 'require', err: 'out' })
  ).then(() => { dklog('success', `${name} deleted.`); refreshDocker(); })
   .catch(err => dklog('error', String(err)));
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
      ulog('success', `Update complete — reloading in 3 seconds...`);
      const statusEl = document.getElementById('s-update-status');
      if (statusEl) { statusEl.textContent = 'Up to date'; statusEl.className = 'settings-value up-to-date'; }
      if (btnUpdate) btnUpdate.classList.add('hidden');
      document.getElementById('update-bar').classList.add('hidden');
      sessionStorage.setItem('justUpdated', '1');
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

// ── Setup Wizard ─────────────────────────────────────────────────────────────

let _wizStep = 1;
let _wizPath = 'fresh'; // 'fresh' | 'import'
let _wizConfDir = null;
let _wizTmpDir  = null;

const WIZ_STEPS_FRESH  = [1, 2, 4, 5];
const WIZ_STEPS_IMPORT = [1, 2, 3, 4, 5];

function checkSetupStatus() {
  let buf = '';
  cockpit.spawn(['freeraid', 'setup-status'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const d = JSON.parse(buf.trim());
        if (d.setup_complete) return;
        // If disks already assigned (existing system), mark done silently
        if (d.has_disks) {
          cockpit.spawn(['freeraid', 'setup-complete'], { superuser: 'require' }).catch(() => {});
          return;
        }
        showWizard();
      } catch(e) { showWizard(); }
    })
    .catch(() => showWizard());
}

function showWizard() {
  document.getElementById('wizard-overlay').classList.remove('hidden');
  _wizRebuildDots();
  wizGoToStep(1);
  // Pre-fetch hostname
  let buf = '';
  cockpit.spawn(['freeraid', 'sysinfo'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const d = JSON.parse(buf.trim());
        if (d.hostname) document.getElementById('wiz-hostname').value = d.hostname;
      } catch(e) {}
    }).catch(() => {});
}

function wizSkip() {
  if (!confirm('Skip setup? You can configure FreeRAID manually from the dashboard.')) return;
  cockpit.spawn(['freeraid', 'setup-complete'], { superuser: 'require' }).catch(() => {});
  document.getElementById('wizard-overlay').classList.add('hidden');
}

function wizChoose(path) {
  _wizPath = path;
  _wizRebuildDots();
  const steps = path === 'import' ? WIZ_STEPS_IMPORT : WIZ_STEPS_FRESH;
  wizGoToStep(steps[1]);
}

function _wizRebuildDots() {
  const steps = _wizPath === 'import' ? WIZ_STEPS_IMPORT : WIZ_STEPS_FRESH;
  const el = document.getElementById('wizard-steps');
  el.innerHTML = '';
  steps.forEach((s, i) => {
    const curIdx = steps.indexOf(_wizStep);
    const dot = document.createElement('div');
    dot.className = 'wizard-step-dot' +
      (s === _wizStep ? ' active' : (i < curIdx ? ' done' : ''));
    dot.textContent = i + 1;
    el.appendChild(dot);
    if (i < steps.length - 1) {
      const line = document.createElement('div');
      line.className = 'wizard-step-line';
      el.appendChild(line);
    }
  });
}

function wizGoToStep(step) {
  _wizStep = step;
  _wizRebuildDots();

  [1,2,3,4,5].forEach(s => {
    document.getElementById('wiz-step-' + s).classList.toggle('hidden', s !== step);
  });

  const steps = _wizPath === 'import' ? WIZ_STEPS_IMPORT : WIZ_STEPS_FRESH;
  const idx   = steps.indexOf(step);
  const backBtn = document.getElementById('wiz-btn-back');
  const nextBtn = document.getElementById('wiz-btn-next');

  backBtn.style.display = (step > 1 && idx > 0) ? '' : 'none';
  backBtn.onclick = wizBack;

  if (step === 1) {
    nextBtn.style.display = 'none';
  } else if (step === 5) {
    nextBtn.textContent = 'Start Array';
    nextBtn.style.display = '';
    nextBtn.disabled = false;
    nextBtn.onclick = wizStartArray;
    wizBuildSummary();
  } else {
    nextBtn.textContent = 'Continue';
    nextBtn.style.display = '';
    nextBtn.disabled = false;
    nextBtn.onclick = wizNext;
  }

  if (step === 4) wizRescanDisks();
}

function wizNext() {
  const steps = _wizPath === 'import' ? WIZ_STEPS_IMPORT : WIZ_STEPS_FRESH;
  const idx   = steps.indexOf(_wizStep);

  // Validate step 2
  if (_wizStep === 2) {
    const hostname = document.getElementById('wiz-hostname').value.trim();
    if (!hostname) { alert('Please enter a hostname.'); return; }

    cockpit.spawn(['freeraid', 'set-hostname', hostname], { superuser: 'require' }).catch(() => {});

    const mode = document.querySelector('input[name="wiz-net-mode"]:checked').value;
    if (mode === 'static') {
      const ip  = document.getElementById('wiz-ip').value.trim();
      const gw  = document.getElementById('wiz-gateway').value.trim();
      const dns = document.getElementById('wiz-dns').value.trim() || '8.8.8.8';
      if (!ip || !gw) { alert('Please fill in IP Address and Gateway.'); return; }
      let buf = '';
      cockpit.spawn(['freeraid', 'network-info'], { superuser: 'require', err: 'ignore' })
        .stream(d => { buf += d; })
        .then(() => {
          try {
            const ifaces = JSON.parse(buf).interfaces;
            if (ifaces && ifaces.length) {
              cockpit.spawn(
                ['freeraid', 'network-set', ifaces[0].name, 'static', ip, gw, dns],
                { superuser: 'require' }
              ).catch(() => {});
            }
          } catch(e) {}
        }).catch(() => {});
    }
  }

  if (idx < steps.length - 1) wizGoToStep(steps[idx + 1]);
}

function wizBack() {
  const steps = _wizPath === 'import' ? WIZ_STEPS_IMPORT : WIZ_STEPS_FRESH;
  const idx   = steps.indexOf(_wizStep);
  if (idx > 0) wizGoToStep(steps[idx - 1]);
}

function wizNetModeChange() {
  const mode = document.querySelector('input[name="wiz-net-mode"]:checked').value;
  document.getElementById('wiz-static-fields').classList.toggle('hidden', mode !== 'static');
}

// Unraid import step
function wizHandleUpload(input) {
  if (!input.files || !input.files[0]) return;
  wizHandleUploadFile(input.files[0]);
}

function wizHandleUploadFile(file) {
  if (!file || !file.name.endsWith('.zip')) return;
  const statusEl  = document.getElementById('wiz-import-status');
  const previewEl = document.getElementById('wiz-import-content');
  statusEl.textContent = 'Uploading...';
  previewEl.innerHTML  = '';
  document.getElementById('wiz-import-preview').classList.remove('hidden');

  const reader = new FileReader();
  reader.onload = e => {
    const data    = new Uint8Array(e.target.result);
    const tmpPath = `/tmp/unraid-wizard-${Date.now()}.zip`;

    cockpit.file(tmpPath, { binary: true, superuser: 'require' })
      .replace(data)
      .then(() => {
        statusEl.textContent = 'Scanning backup...';
        let buf = '';
        cockpit.spawn(['bash', '-c',
          `TMPDIR=$(mktemp -d /tmp/unraid-wiz-XXXXXX) && ` +
          `unzip -q "${tmpPath}" -d "$TMPDIR" 2>/dev/null || true; ` +
          `CONFDIR=$(find "$TMPDIR" -name "disk.cfg" -o -name "ident.cfg" 2>/dev/null | head -1 | xargs dirname 2>/dev/null || echo ""); ` +
          `if [ -z "$CONFDIR" ]; then CONFDIR=$(find "$TMPDIR" -type d -name "config" | head -1); fi; ` +
          `SHARES=$(ls "$CONFDIR/shares/"*.cfg 2>/dev/null | wc -l || echo 0); ` +
          `DOCKER=$(ls "$CONFDIR/plugins/dockerMan/templates-user/"*.xml 2>/dev/null | wc -l || echo 0); ` +
          `HAS_NET=$([ -f "$CONFDIR/network.cfg" ] && echo 1 || echo 0); ` +
          `echo "$TMPDIR|$CONFDIR|$SHARES|$DOCKER|$HAS_NET"`
        ], { superuser: 'require' })
          .stream(d => { buf += d; })
          .then(() => {
            const parts = buf.trim().split('|');
            const [tmpdir, confdir, shares, docker, hasNet] = parts;
            _wizTmpDir  = tmpdir  || null;
            _wizConfDir = confdir || null;
            if (!confdir) {
              statusEl.textContent = 'Could not find Unraid config in zip. Continue to skip import.';
              return;
            }
            previewEl.innerHTML = [
              +shares  ? `<div class="preview-row"><span class="preview-count">${shares}</span> User shares</div>` : '',
              +docker  ? `<div class="preview-row"><span class="preview-count">${docker}</span> Docker apps</div>` : '',
              hasNet==='1' ? `<div class="preview-row"><span class="preview-count">✓</span> Network config</div>` : '',
            ].filter(Boolean).join('') ||
              '<div style="color:var(--text-dim);font-size:13px">Nothing recognizable found.</div>';
            statusEl.textContent = 'Ready. Click Continue to import.';
          })
          .catch(() => { statusEl.textContent = 'Scan failed. Continue to skip.'; });
      })
      .catch(() => { statusEl.textContent = 'Upload failed.'; });
  };
  reader.readAsArrayBuffer(file);
}

// Disk assignment in wizard
function wizRescanDisks() {
  const el = document.getElementById('wiz-disk-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-msg">Scanning...</div>';
  let buf = '';
  cockpit.spawn(['freeraid', 'disks-scan'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try { renderWizardDisks(JSON.parse(buf.slice(buf.indexOf('[')))); }
      catch(e) { el.innerHTML = '<div class="loading-msg">Scan failed.</div>'; }
    })
    .catch(() => { el.innerHTML = '<div class="loading-msg">Scan failed.</div>'; });
}

function renderWizardDisks(disks) {
  const el = document.getElementById('wiz-disk-list');
  if (!disks.length) {
    el.innerHTML = '<div class="loading-msg">No disks detected. Check connections and rescan.</div>';
    return;
  }
  el.innerHTML = disks.map(d => {
    const opts = ['unassigned','array','parity','cache'].map(r =>
      `<option value="${r}" ${(d.assigned ? d.role === r : r === 'unassigned') ? 'selected' : ''}>${
        r === 'unassigned' ? '— Unassigned —' : r.charAt(0).toUpperCase() + r.slice(1)
      }</option>`
    ).join('');
    const devSafe = d.device.replace(/'/g, "\\'");
    return `<div class="wiz-disk-item">
      <div class="wiz-disk-dev">${d.device}</div>
      <div class="wiz-disk-info">
        <div>${d.model || 'Unknown'}</div>
        <div class="wiz-disk-model">${d.type || 'HDD'}${d.has_fs ? ' · ' + d.has_fs : ''}</div>
      </div>
      <div class="wiz-disk-size">${d.size}</div>
      <select class="install-select" style="min-width:130px" onchange="wizAssignDisk('${devSafe}', this.value)">
        ${opts}
      </select>
    </div>`;
  }).join('');
}

function wizAssignDisk(dev, role) {
  const cmd = role === 'unassigned'
    ? ['freeraid', 'disks-unassign', dev]
    : ['freeraid', 'disks-assign', dev, role];
  cockpit.spawn(cmd, { superuser: 'require' }).catch(() => {});
}

function wizBuildSummary() {
  const el = document.getElementById('wiz-summary');
  let buf = '';
  cockpit.spawn(['freeraid', 'disks-scan'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        const disks = JSON.parse(buf.slice(buf.indexOf('[')));
        const a = disks.filter(d => d.assigned && d.role === 'array').length;
        const p = disks.filter(d => d.assigned && d.role === 'parity').length;
        const c = disks.filter(d => d.assigned && d.role === 'cache').length;
        el.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
            <div style="background:var(--bg3);padding:14px;border-radius:var(--radius);text-align:center">
              <div style="font-size:28px;font-weight:700;color:var(--accent)">${a}</div>
              <div style="font-size:12px;color:var(--text-dim);margin-top:4px">Array Disks</div>
            </div>
            <div style="background:var(--bg3);padding:14px;border-radius:var(--radius);text-align:center">
              <div style="font-size:28px;font-weight:700;color:var(--yellow)">${p}</div>
              <div style="font-size:12px;color:var(--text-dim);margin-top:4px">Parity</div>
            </div>
            <div style="background:var(--bg3);padding:14px;border-radius:var(--radius);text-align:center">
              <div style="font-size:28px;font-weight:700;color:var(--blue)">${c}</div>
              <div style="font-size:12px;color:var(--text-dim);margin-top:4px">Cache</div>
            </div>
          </div>
          ${p === 0 ? '<div class="alert warning" style="margin-bottom:12px">No parity disk assigned — data will not be protected against drive failure.</div>' : ''}
          ${a === 0 ? '<div class="alert error"   style="margin-bottom:12px">No array disks assigned — cannot start the array.</div>' : ''}
        `;
        document.getElementById('wiz-btn-next').disabled = (a === 0);
      } catch(e) {}
    });
}

function wizStartArray() {
  const nextBtn = document.getElementById('wiz-btn-next');
  const backBtn = document.getElementById('wiz-btn-back');
  const logEl   = document.getElementById('wiz-start-log');

  nextBtn.disabled = true;
  backBtn.style.display = 'none';
  logEl.style.display = '';
  logEl.innerHTML = '';

  function doImport() {
    if (_wizPath !== 'import' || !_wizConfDir) return Promise.resolve();
    return new Promise(resolve => {
      cockpit.spawn(['freeraid', 'shares-import', _wizConfDir], { superuser: 'require', err: 'out' })
        .stream(data => {
          data.split('\n').filter(l => l.trim()).forEach(line => {
            const p = document.createElement('p');
            p.className = 'log-line log-info';
            p.textContent = line.replace(/\x1b\[[0-9;]*m/g, '');
            logEl.appendChild(p);
          });
        })
        .then(() => resolve())
        .catch(() => resolve());
    });
  }

  doImport().then(() => {
    cockpit.spawn(['freeraid', 'start'], { superuser: 'require', err: 'out' })
      .stream(data => {
        data.split('\n').filter(l => l.trim()).forEach(line => {
          const p = document.createElement('p');
          p.className = 'log-line log-info';
          p.textContent = line.replace(/\x1b\[[0-9;]*m/g, '');
          logEl.appendChild(p);
          logEl.scrollTop = logEl.scrollHeight;
        });
      })
      .then(() => {
        if (_wizTmpDir) cockpit.spawn(['rm', '-rf', _wizTmpDir], { superuser: 'require' }).catch(() => {});
        wizFinish();
      })
      .catch(err => {
        const p = document.createElement('p');
        p.className = 'log-line log-error';
        p.textContent = 'Error: ' + String(err);
        logEl.appendChild(p);
        nextBtn.disabled = false;
        nextBtn.textContent = 'Retry';
        nextBtn.onclick = wizStartArray;
        backBtn.style.display = '';
      });
  });
}

function wizFinish() {
  cockpit.spawn(['freeraid', 'setup-complete'], { superuser: 'require' }).catch(() => {});
  document.getElementById('wiz-summary').innerHTML = '';
  document.getElementById('wiz-start-log').style.display = 'none';
  document.getElementById('wiz-done-msg').classList.remove('hidden');

  const nextBtn = document.getElementById('wiz-btn-next');
  nextBtn.textContent = 'Go to Dashboard';
  nextBtn.disabled = false;
  nextBtn.onclick = () => {
    document.getElementById('wizard-overlay').classList.add('hidden');
    refreshStatus();
    refreshSysinfo();
  };
  document.getElementById('wiz-btn-back').style.display = 'none';
}

// ── Log Viewer ────────────────────────────────────────────────────────────────

let _logSrc      = 'freeraid';
let _logTailInt  = null;

function selectLogSrc(src, btn) {
  _logSrc = src;
  document.querySelectorAll('.log-src-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  fetchLog();
}

function fetchLog() {
  const panel = document.getElementById('logs-view-panel');
  if (!panel) return;
  const lines = document.getElementById('log-lines-select').value;
  panel.innerHTML = '<div class="loading-msg">Loading...</div>';

  let buf = '';
  cockpit.spawn(['freeraid', 'logs-get', _logSrc, lines], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      if (!buf.trim()) { panel.innerHTML = '<div class="loading-msg">No log entries found.</div>'; return; }
      panel.innerHTML = '';
      buf.split('\n').forEach(line => {
        if (!line) return;
        const p = document.createElement('p');
        p.className = 'log-line ' + _logLineClass(line);
        p.textContent = line;
        panel.appendChild(p);
      });
      panel.scrollTop = panel.scrollHeight;
    })
    .catch(() => { panel.innerHTML = '<div class="loading-msg">Failed to load log.</div>'; });
}

function _logLineClass(line) {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('fail') || l.includes('crit')) return 'log-error';
  if (l.includes('warn'))  return 'log-warn';
  if (l.includes('==>') || l.includes('success') || l.includes('started') || l.includes('active')) return 'log-success';
  return 'log-info';
}

function clearLogsView() {
  const panel = document.getElementById('logs-view-panel');
  if (panel) panel.innerHTML = '';
}

function toggleLogTail() {
  const on = document.getElementById('log-tail-toggle').checked;
  if (on) {
    fetchLog();
    _logTailInt = setInterval(fetchLog, 5000);
  } else {
    clearInterval(_logTailInt);
    _logTailInt = null;
  }
}

// ── Disk Spin-down ────────────────────────────────────────────────────────────

const SPINDOWN_OPTIONS = [
  { value: 0,   label: 'Disabled (never spin down)' },
  { value: 60,  label: '5 minutes' },
  { value: 120, label: '10 minutes' },
  { value: 180, label: '15 minutes' },
  { value: 240, label: '20 minutes' },
  { value: 241, label: '30 minutes' },
  { value: 242, label: '1 hour' },
  { value: 244, label: '2 hours' },
  { value: 248, label: '4 hours' },
];

function refreshSpindown() {
  const el = document.getElementById('spindown-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-msg" style="font-size:12px">Loading...</div>';

  let buf = '';
  cockpit.spawn(['freeraid', 'spindown-get'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try { renderSpindown(JSON.parse(buf.trim())); }
      catch(e) { el.innerHTML = '<div class="loading-msg">Could not load spin-down settings.</div>'; }
    })
    .catch(() => { el.innerHTML = '<div class="loading-msg">hdparm not available.</div>'; });
}

function renderSpindown(drives) {
  const el = document.getElementById('spindown-list');
  if (!drives.length) {
    el.innerHTML = '<div class="loading-msg">No drives found.</div>';
    return;
  }

  const opts = SPINDOWN_OPTIONS.map(o =>
    `<option value="${o.value}">${o.label}</option>`
  ).join('');

  const roleLabel = { array: 'Array', parity: 'Parity', cache: 'Cache' };
  const roleColor = { array: 'var(--accent)', parity: 'var(--yellow)', cache: 'var(--blue)' };

  el.innerHTML = `
    <div class="spindown-grid">
      ${drives.map(d => {
        const devSafe = d.device.replace(/'/g, "\\'");
        const spinBadge = d.spindle === 'active/idle'
          ? `<span class="spindle-badge spindle-on">spinning</span>`
          : d.spindle === 'standby'
          ? `<span class="spindle-badge spindle-off">standby</span>`
          : '';
        const roleBadge = d.role
          ? `<span style="font-size:11px;font-weight:600;color:${roleColor[d.role] || 'var(--text-dim)'}">${roleLabel[d.role] || d.role}</span>`
          : '';
        const parityNote = d.role === 'parity' && d.value === 241
          ? ` <span style="font-size:11px;color:var(--text-dim)">(default)</span>` : '';
        const selOpts = SPINDOWN_OPTIONS.map(o =>
          `<option value="${o.value}" ${o.value === d.value ? 'selected' : ''}>${o.label}</option>`
        ).join('');
        return `<div class="spindown-row">
          <div class="spindown-dev">${d.device}</div>
          <div style="display:flex;align-items:center;gap:8px;min-width:90px">${roleBadge}</div>
          <div style="display:flex;align-items:center;gap:8px;flex:1">${spinBadge}</div>
          <div style="display:flex;align-items:center;gap:6px">
            <select class="install-select" style="min-width:200px"
              onchange="setSpindown('${devSafe}', this.value)">
              ${selOpts}
            </select>${parityNote}
          </div>
        </div>`;
      }).join('')}
    </div>
    <div style="margin-top:10px;font-size:12px;color:var(--text-dim)">
      Changes apply immediately and persist across reboots. Drives spin back up automatically when accessed.
      Parity drives default to 30 minutes — they're only needed during sync, scrub, or rebuild.
    </div>`;
}

function setSpindown(dev, value) {
  cockpit.spawn(['freeraid', 'spindown-set', dev, value], { superuser: 'require', err: 'out' })
    .then(() => refreshSpindown())
    .catch(() => {});
}

// ── Notifications ─────────────────────────────────────────────────────────────

const NOTIF_EVENTS = ['array_degraded', 'drive_temp', 'sync_error', 'scrub_error', 'update_available'];

function loadNotifSettings() {
  cockpit.spawn(['freeraid', 'notify-get'], { superuser: 'require', err: 'out' })
    .then(out => {
      const c = JSON.parse(out);
      applyNotifSettings(c);
    })
    .catch(() => {});
}

function applyNotifSettings(c) {
  const email = c.email || {};
  const webhook = c.webhook || {};
  const events = c.events || {};

  document.getElementById('notif-email-enabled').checked = !!email.enabled;
  document.getElementById('notif-smtp-host').value    = email.smtp_host  || '';
  document.getElementById('notif-smtp-port').value    = email.smtp_port  || '';
  document.getElementById('notif-smtp-from').value    = email.smtp_from  || '';
  document.getElementById('notif-smtp-user').value    = email.smtp_user  || '';
  document.getElementById('notif-smtp-pass').value    = email.smtp_pass  || '';
  document.getElementById('notif-smtp-to').value      = email.smtp_to    || '';

  document.getElementById('notif-webhook-enabled').checked = !!webhook.enabled;
  document.getElementById('notif-webhook-url').value    = webhook.url    || '';
  document.getElementById('notif-webhook-format').value = webhook.format || 'discord';

  NOTIF_EVENTS.forEach(ev => {
    const el = document.getElementById('notif-ev-' + ev);
    if (el) el.checked = !!events[ev];
  });

  const thresh = document.getElementById('notif-temp-threshold');
  if (thresh) thresh.value = c.temp_threshold || 55;
}

function saveNotifSettings() {
  const payload = {
    email: {
      enabled:   document.getElementById('notif-email-enabled').checked,
      smtp_host: document.getElementById('notif-smtp-host').value.trim(),
      smtp_port: parseInt(document.getElementById('notif-smtp-port').value) || 587,
      smtp_from: document.getElementById('notif-smtp-from').value.trim(),
      smtp_user: document.getElementById('notif-smtp-user').value.trim(),
      smtp_pass: document.getElementById('notif-smtp-pass').value,
      smtp_to:   document.getElementById('notif-smtp-to').value.trim()
    },
    webhook: {
      enabled: document.getElementById('notif-webhook-enabled').checked,
      url:     document.getElementById('notif-webhook-url').value.trim(),
      format:  document.getElementById('notif-webhook-format').value
    },
    events: {},
    temp_threshold: parseInt(document.getElementById('notif-temp-threshold').value) || 55
  };

  NOTIF_EVENTS.forEach(ev => {
    const el = document.getElementById('notif-ev-' + ev);
    payload.events[ev] = el ? el.checked : false;
  });

  cockpit.spawn(['freeraid', 'notify-set', JSON.stringify(payload)], { superuser: 'require', err: 'out' })
    .then(() => log('info', 'Notification settings saved'))
    .catch(err => log('error', 'Save failed: ' + err));
}

function testNotif(method) {
  cockpit.spawn(['freeraid', 'notify-test', method], { superuser: 'require', err: 'out' })
    .then(out => {
      const r = JSON.parse(out);
      log(r.ok ? 'info' : 'error', r.message || (r.ok ? 'Test sent' : 'Test failed'));
    })
    .catch(err => log('error', 'Test failed: ' + err));
}

// ── Per-disk I/O stats ────────────────────────────────────────────────────────

let _iostatRunning = false;

function startIoStatLoop() {
  if (_iostatRunning) return;
  _iostatRunning = true;
  _pollIoStat();
}

function stopIoStatLoop() {
  _iostatRunning = false;
}

function _pollIoStat() {
  if (!_iostatRunning) return;
  cockpit.spawn(['freeraid', 'iostat', '2'], { superuser: 'require', err: 'out' })
    .then(out => {
      try {
        const stats = JSON.parse(out.trim());
        applyIoStats(stats);
      } catch(_) {}
      if (_iostatRunning) setTimeout(_pollIoStat, 500);
    })
    .catch(() => {
      if (_iostatRunning) setTimeout(_pollIoStat, 5000);
    });
}

function applyIoStats(stats) {
  stats.forEach(s => {
    const row = document.querySelector(`[data-io-dev="${s.device}"]`);
    if (!row) return;
    const active = s.read_kbs > 0 || s.write_kbs > 0;
    row.classList.toggle('hidden', !active);
    const vals = row.querySelectorAll('.io-val');
    if (vals[0]) vals[0].textContent = fmtKbs(s.read_kbs);
    if (vals[1]) vals[1].textContent = fmtKbs(s.write_kbs);
  });
}

function fmtKbs(kbs) {
  if (kbs >= 1024) return (kbs / 1024).toFixed(1) + ' M';
  return kbs + ' K';
}

// ── Plugin Manager ────────────────────────────────────────────────────────────

let _pluginsInstalled = [];
let _pluginsAvailable = [];

function plog(level, text) { appendLog('plugins-log-panel', level, text); }

function refreshPlugins() {
  const el = document.getElementById('plugins-installed');
  if (el) el.innerHTML = '<div class="loading-msg">Loading...</div>';
  let buf = '';
  cockpit.spawn(['freeraid', 'plugin-list'], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      try { _pluginsInstalled = JSON.parse(buf.trim()); } catch (_) { _pluginsInstalled = []; }
      renderInstalledPlugins();
    })
    .catch(err => {
      plog('error', 'Failed to load installed plugins: ' + err);
      if (el) el.innerHTML = '<div class="loading-msg">Failed to load plugins.</div>';
    });
}

function fetchAvailablePlugins() {
  const el = document.getElementById('plugins-available');
  if (el) el.innerHTML = '<div class="loading-msg">Fetching plugin index...</div>';
  let buf = '';
  cockpit.spawn(['freeraid', 'plugin-available'], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      try { _pluginsAvailable = JSON.parse(buf.trim()); } catch (_) { _pluginsAvailable = []; }
      renderAvailablePlugins();
      plog('info', 'Plugin index fetched — ' + _pluginsAvailable.length + ' plugin(s) available.');
    })
    .catch(err => {
      plog('error', 'Failed to fetch plugin index: ' + err);
      if (el) el.innerHTML = '<div class="loading-msg">Failed to fetch plugin index.</div>';
    });
}

function renderInstalledPlugins() {
  const el = document.getElementById('plugins-installed');
  if (!el) return;
  if (!_pluginsInstalled.length) {
    el.innerHTML = '<div class="loading-msg">No plugins installed.</div>';
    return;
  }
  el.innerHTML = _pluginsInstalled.map(p => {
    const canUpdate = _pluginsAvailable.find(a => a.name === p.name &&
      a.version !== p.version);
    return `<div class="plugin-card" id="plugin-card-${p.name}">
      <div class="plugin-card-header">
        <span class="plugin-name">${p.name}</span>
        <span class="plugin-version badge">v${p.version || '?'}</span>
        <span class="badge badge-installed">Installed</span>
      </div>
      <div class="plugin-desc">${p.description || ''}</div>
      <div class="plugin-actions">
        ${canUpdate ? `<button class="btn btn-sm btn-primary" onclick="updatePlugin('${p.name}')">Update</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="removePlugin('${p.name}')">Remove</button>
      </div>
    </div>`;
  }).join('');
}

function renderAvailablePlugins() {
  const el = document.getElementById('plugins-available');
  if (!el) return;
  if (!_pluginsAvailable.length) {
    el.innerHTML = '<div class="loading-msg">No plugins found in index.</div>';
    return;
  }
  el.innerHTML = _pluginsAvailable.map(p => {
    const installed = _pluginsInstalled.find(i => i.name === p.name);
    const hasUpdate = installed && installed.version !== p.version;
    return `<div class="plugin-card" id="plugin-avail-${p.name}">
      <div class="plugin-card-header">
        <span class="plugin-name">${p.name}</span>
        <span class="plugin-version badge">v${p.version}</span>
        ${installed ? `<span class="badge badge-installed">Installed</span>` : ''}
        ${hasUpdate ? `<span class="badge badge-update">Update Available</span>` : ''}
        <span class="badge badge-cat">${p.category || ''}</span>
      </div>
      <div class="plugin-desc">${p.description || ''}</div>
      ${p.homepage ? `<div class="plugin-homepage"><a href="${p.homepage}" target="_blank" rel="noopener">${p.homepage}</a></div>` : ''}
      <div class="plugin-actions">
        ${!installed
          ? `<button class="btn btn-sm btn-primary" onclick="installPlugin('${p.name}')">Install</button>`
          : hasUpdate
            ? `<button class="btn btn-sm btn-primary" onclick="updatePlugin('${p.name}')">Update</button>`
            : `<button class="btn btn-sm" disabled>Up to date</button>`}
      </div>
    </div>`;
  }).join('');
}

function installPlugin(name) {
  plog('info', 'Installing ' + name + '...');
  _setPluginBusy(name, true);
  let buf = '';
  cockpit.spawn(['freeraid', 'plugin-install', name], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; plog('info', d.trim()); })
    .then(() => {
      plog('info', name + ' installed successfully.');
      refreshPlugins();
    })
    .catch(err => {
      plog('error', 'Install failed: ' + err);
      _setPluginBusy(name, false);
    });
}

function removePlugin(name) {
  if (!confirm('Remove plugin "' + name + '"? This will stop and remove the service.')) return;
  plog('info', 'Removing ' + name + '...');
  _setPluginBusy(name, true);
  let buf = '';
  cockpit.spawn(['freeraid', 'plugin-remove', name], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; plog('info', d.trim()); })
    .then(() => {
      plog('info', name + ' removed.');
      refreshPlugins();
    })
    .catch(err => {
      plog('error', 'Remove failed: ' + err);
      _setPluginBusy(name, false);
    });
}

function updatePlugin(name) {
  plog('info', 'Updating ' + name + '...');
  _setPluginBusy(name, true);
  let buf = '';
  cockpit.spawn(['freeraid', 'plugin-update', name], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; plog('info', d.trim()); })
    .then(() => {
      plog('info', name + ' updated.');
      refreshPlugins();
    })
    .catch(err => {
      plog('error', 'Update failed: ' + err);
      _setPluginBusy(name, false);
    });
}

function _setPluginBusy(name, busy) {
  ['plugin-card-' + name, 'plugin-avail-' + name].forEach(id => {
    const card = document.getElementById(id);
    if (!card) return;
    card.querySelectorAll('button').forEach(b => { b.disabled = busy; });
  });
}

// ── ZFS Pool Manager ──────────────────────────────────────────────────────────

let _zfsPools = [];
let _zfsAddOpen = false;

function refreshZfsPools() {
  const el = document.getElementById('zfs-pools-list');
  if (!el) return;
  let buf = '';
  cockpit.spawn(['freeraid', 'zfs-pool-list'], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      try { _zfsPools = JSON.parse(buf.trim()); } catch(_) { _zfsPools = []; }
      renderZfsPools();
    })
    .catch(() => {
      el.innerHTML = '<div class="loading-msg">ZFS not available or not installed.</div>';
    });
}

function renderZfsPools() {
  const el = document.getElementById('zfs-pools-list');
  if (!el) return;
  if (!_zfsPools.length) {
    el.innerHTML = '<div class="loading-msg">No ZFS pools. Create one above.</div>';
    return;
  }
  el.innerHTML = _zfsPools.map(p => {
    const healthClass = p.health === 'ONLINE' ? 'zfs-health-online'
                      : p.health === 'DEGRADED' ? 'zfs-health-degraded' : 'zfs-health-faulted';
    const datasets = (p.datasets || []).filter(d => d.name !== p.name);
    return `<div class="zfs-pool-card" id="zfs-pool-card-${p.name}">
      <div class="zfs-pool-header">
        <span class="zfs-pool-name">${p.name}</span>
        <span class="badge ${healthClass}">${p.health}</span>
        <span class="zfs-pool-meta">${p.size} total &bull; ${p.alloc} used &bull; ${p.free} free</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="btn btn-xs btn-ghost" onclick="zfsPoolScrub('${p.name}')">Scrub</button>
          <button class="btn btn-xs btn-ghost" onclick="zfsPoolStatus('${p.name}')">Status</button>
          <button class="btn btn-xs btn-ghost" onclick="toggleZfsDatasetAdd('${p.name}')">+ Dataset</button>
          <button class="btn btn-xs btn-danger" onclick="zfsPoolDestroy('${p.name}')">Destroy</button>
        </div>
      </div>
      <div id="zfs-dataset-add-${p.name}" class="hidden" style="padding:8px 0 4px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div>
          <label class="field-label" style="font-size:11px">Dataset Name</label>
          <input type="text" id="zfs-ds-name-${p.name}" class="text-input" style="width:160px" placeholder="e.g. media">
        </div>
        <div>
          <label class="field-label" style="font-size:11px">Quota (optional)</label>
          <input type="text" id="zfs-ds-quota-${p.name}" class="text-input" style="width:100px" placeholder="e.g. 500G">
        </div>
        <button class="btn btn-primary btn-xs" onclick="doCreateZfsDataset('${p.name}')">Create</button>
        <button class="btn btn-ghost btn-xs" onclick="toggleZfsDatasetAdd('${p.name}')">Cancel</button>
        <div id="zfs-ds-msg-${p.name}" style="font-size:0.85em;align-self:center"></div>
      </div>
      ${datasets.length ? `<div class="zfs-datasets">
        ${datasets.map(d => {
          const dsShort = d.name.replace(p.name + '/', '');
          return `<div class="zfs-dataset-row">
            <span class="zfs-ds-name">${dsShort}</span>
            <span class="zfs-ds-meta">${d.used} used &bull; ${d.avail} free</span>
            <span class="zfs-ds-meta" style="color:var(--accent)">comp: ${d.compression}</span>
            ${d.quota !== 'none' ? `<span class="zfs-ds-meta">quota: ${d.quota}</span>` : ''}
            <div style="margin-left:auto;display:flex;gap:4px">
              <button class="btn btn-xs btn-ghost" onclick="toggleZfsSnapshots('${p.name}', '${d.name}')">Snapshots</button>
              <button class="btn btn-xs btn-danger" onclick="zfsDatasetDestroy('${d.name}')">Delete</button>
            </div>
          </div>
          <div class="hidden" id="zfs-snaps-${d.name.replace(/\//g,'-')}">
            <div class="loading-msg" style="padding:6px 12px">Loading snapshots...</div>
          </div>`;
        }).join('')}
      </div>` : ''}
    </div>`;
  }).join('');
}

function toggleAddZfsPool() {
  const form = document.getElementById('add-zfs-pool-form');
  _zfsAddOpen = !_zfsAddOpen;
  form.classList.toggle('hidden', !_zfsAddOpen);
  if (_zfsAddOpen) _populateZfsDevList();
}

function _populateZfsDevList() {
  const el = document.getElementById('zfs-dev-list');
  if (!el) return;
  el.innerHTML = '<span style="color:var(--text-dim);font-size:12px">Scanning...</span>';
  let buf = '';
  cockpit.spawn(['freeraid', 'disks-scan'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      let disks = [];
      try { disks = JSON.parse(buf.trim()); } catch(_) {}
      const free = disks.filter(d => !d.role || d.role === 'unassigned');
      if (!free.length) {
        el.innerHTML = '<span style="color:var(--text-dim);font-size:12px">No unassigned drives available.</span>';
        return;
      }
      el.innerHTML = free.map(d =>
        `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 8px;background:var(--bg);border-radius:4px;border:1px solid var(--border)">
          <input type="checkbox" class="zfs-dev-check" value="${d.device}">
          <span style="font-family:monospace;font-size:12px">${d.device}</span>
          <span style="color:var(--text-dim);font-size:11px">${d.size || ''}</span>
        </label>`
      ).join('');
    })
    .catch(() => { el.innerHTML = '<span style="color:var(--red)">Failed to scan disks.</span>'; });
}

function doCreateZfsPool() {
  const name = document.getElementById('zfs-pool-name').value.trim();
  const type = document.getElementById('zfs-pool-type').value;
  const msg  = document.getElementById('zfs-create-msg');
  const checked = [...document.querySelectorAll('.zfs-dev-check:checked')].map(c => c.value);

  if (!name)           { msg.style.color = 'var(--red)'; msg.textContent = 'Pool name required.'; return; }
  if (!checked.length) { msg.style.color = 'var(--red)'; msg.textContent = 'Select at least one device.'; return; }
  if (type === 'mirror' && checked.length < 2) { msg.style.color = 'var(--red)'; msg.textContent = 'Mirror requires at least 2 devices.'; return; }
  if (type === 'raidz'  && checked.length < 3) { msg.style.color = 'var(--red)'; msg.textContent = 'RAIDZ-1 requires at least 3 devices.'; return; }
  if (type === 'raidz2' && checked.length < 4) { msg.style.color = 'var(--red)'; msg.textContent = 'RAIDZ-2 requires at least 4 devices.'; return; }

  msg.style.color = 'var(--text-dim)'; msg.textContent = 'Creating pool...';
  const args = ['freeraid', 'zfs-pool-create', name, type, ...checked];
  cockpit.spawn(args, { superuser: 'require', err: 'out' })
    .then(out => {
      msg.style.color = 'var(--green)'; msg.textContent = 'Pool created.';
      document.getElementById('zfs-pool-name').value = '';
      setTimeout(() => { toggleAddZfsPool(); refreshZfsPools(); }, 1200);
    })
    .catch(err => { msg.style.color = 'var(--red)'; msg.textContent = String(err); });
}

function zfsPoolDestroy(name) {
  if (!confirm('Destroy ZFS pool "' + name + '"? All data will be lost.')) return;
  cockpit.spawn(['freeraid', 'zfs-pool-destroy', name], { superuser: 'require', err: 'out' })
    .then(() => { log('info', 'ZFS pool ' + name + ' destroyed.'); refreshZfsPools(); })
    .catch(err => log('error', 'Destroy failed: ' + err));
}

function zfsPoolScrub(name) {
  cockpit.spawn(['freeraid', 'zfs-pool-scrub', name], { superuser: 'require', err: 'out' })
    .then(out => { log('info', 'Scrub started on ' + name + ': ' + out.trim()); refreshZfsPools(); })
    .catch(err => log('error', 'Scrub failed: ' + err));
}

function zfsPoolStatus(name) {
  let buf = '';
  cockpit.spawn(['freeraid', 'zfs-pool-status', name], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      const card = document.getElementById('zfs-pool-card-' + name);
      if (!card) return;
      let statusEl = document.getElementById('zfs-status-out-' + name);
      if (!statusEl) {
        statusEl = document.createElement('pre');
        statusEl.id = 'zfs-status-out-' + name;
        statusEl.style.cssText = 'font-size:11px;color:var(--text-dim);background:var(--bg);padding:10px;border-radius:4px;overflow-x:auto;margin-top:8px;white-space:pre-wrap';
        card.appendChild(statusEl);
      }
      statusEl.textContent = buf;
    })
    .catch(err => log('error', 'Status failed: ' + err));
}

function toggleZfsDatasetAdd(pool) {
  const el = document.getElementById('zfs-dataset-add-' + pool);
  if (el) el.classList.toggle('hidden');
}

function doCreateZfsDataset(pool) {
  const name  = document.getElementById('zfs-ds-name-' + pool).value.trim();
  const quota = document.getElementById('zfs-ds-quota-' + pool).value.trim() || 'none';
  const msg   = document.getElementById('zfs-ds-msg-' + pool);
  if (!name) { msg.style.color = 'var(--red)'; msg.textContent = 'Name required.'; return; }
  msg.style.color = 'var(--text-dim)'; msg.textContent = 'Creating...';
  cockpit.spawn(['freeraid', 'zfs-dataset-create', pool, name, quota], { superuser: 'require', err: 'out' })
    .then(() => {
      msg.style.color = 'var(--green)'; msg.textContent = 'Created.';
      setTimeout(() => { refreshZfsPools(); }, 1000);
    })
    .catch(err => { msg.style.color = 'var(--red)'; msg.textContent = String(err); });
}

function zfsDatasetDestroy(full) {
  if (!confirm('Delete dataset "' + full + '"? All data in this dataset will be lost.')) return;
  cockpit.spawn(['freeraid', 'zfs-dataset-destroy', full], { superuser: 'require', err: 'out' })
    .then(() => { log('info', 'Dataset ' + full + ' deleted.'); refreshZfsPools(); })
    .catch(err => log('error', 'Delete failed: ' + err));
}

function toggleZfsSnapshots(pool, dataset) {
  const id = 'zfs-snaps-' + dataset.replace(/\//g, '-');
  const el = document.getElementById(id);
  if (!el) return;
  if (!el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  _loadZfsSnapshots(pool, dataset, el);
}

function _loadZfsSnapshots(pool, dataset, el) {
  el.innerHTML = '<div class="loading-msg" style="padding:6px 12px">Loading snapshots...</div>';
  let buf = '';
  cockpit.spawn(['freeraid', 'zfs-snapshot-list', dataset], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      let snaps = [];
      try { snaps = JSON.parse(buf.trim()); } catch(_) {}
      const datasetJson = JSON.stringify(dataset);
      const poolJson    = JSON.stringify(pool);
      if (!snaps.length) {
        el.innerHTML = `<div style="padding:6px 12px;display:flex;gap:8px;align-items:center">
          <span style="color:var(--text-dim);font-size:12px">No snapshots.</span>
          <button class="btn btn-xs btn-secondary" onclick="_takeSnapshot(${datasetJson})">Take Snapshot</button>
        </div>`;
        return;
      }
      el.innerHTML = `<div style="padding:6px 12px">
        <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
          <button class="btn btn-xs btn-secondary" onclick="_takeSnapshot(${datasetJson})">Take Snapshot</button>
        </div>
        ${snaps.map(s => {
          const sn = JSON.stringify(s.name);
          return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--border);font-size:12px">
            <span style="font-family:monospace;flex:1">${s.name}</span>
            <span style="color:var(--text-dim)">${s.used}</span>
            <button class="btn btn-xs btn-ghost" onclick="_rollbackSnapshot(${sn})">Rollback</button>
            <button class="btn btn-xs btn-danger" onclick="_deleteSnapshot(${sn})">Delete</button>
          </div>`;
        }).join('')}
      </div>`;
    })
    .catch(() => { el.innerHTML = '<div style="padding:6px 12px;color:var(--red)">Failed to load snapshots.</div>'; });
}

function _takeSnapshot(dataset) {
  const label = prompt('Snapshot label (leave blank for timestamp):') || '';
  const args = label ? ['freeraid', 'zfs-snapshot-create', dataset, label]
                     : ['freeraid', 'zfs-snapshot-create', dataset];
  cockpit.spawn(args, { superuser: 'require', err: 'out' })
    .then(out => { log('info', out.trim()); refreshZfsPools(); })
    .catch(err => log('error', 'Snapshot failed: ' + err));
}

function _deleteSnapshot(snap) {
  if (!confirm('Delete snapshot ' + snap + '?')) return;
  cockpit.spawn(['freeraid', 'zfs-snapshot-delete', snap], { superuser: 'require', err: 'out' })
    .then(() => { log('info', 'Snapshot deleted: ' + snap); refreshZfsPools(); })
    .catch(err => log('error', 'Delete failed: ' + err));
}

function _rollbackSnapshot(snap) {
  if (!confirm('Roll back to ' + snap + '? All changes since this snapshot will be lost.')) return;
  cockpit.spawn(['freeraid', 'zfs-snapshot-rollback', snap], { superuser: 'require', err: 'out' })
    .then(out => { log('info', out.trim()); refreshZfsPools(); })
    .catch(err => log('error', 'Rollback failed: ' + err));
}

// ── VM Manager ────────────────────────────────────────────────────────────────

let _vms = [];

function refreshVms() {
  const el = document.getElementById('vms-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-msg">Loading VMs...</div>';
  let buf = '';
  cockpit.spawn(['freeraid', 'vm-list'], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      try { _vms = JSON.parse(buf.trim()); } catch(_) { _vms = []; }
      renderVms();
    })
    .catch(err => {
      el.innerHTML = '<div class="loading-msg">KVM/libvirt not available: ' + err + '</div>';
    });
}

function renderVms() {
  const el = document.getElementById('vms-list');
  if (!el) return;
  if (!_vms.length) {
    el.innerHTML = '<div class="loading-msg">No VMs. Create one above.</div>';
    return;
  }
  el.innerHTML = _vms.map(vm => {
    const running = vm.state === 'running';
    const stateClass = running ? 'vm-state-running' : 'vm-state-stopped';
    const nameJson = JSON.stringify(vm.name);
    return `<div class="vm-card" id="vm-card-${vm.name}">
      <div class="vm-card-header">
        <span class="vm-name">${vm.name}</span>
        <span class="badge ${stateClass}">${vm.state}</span>
        <span class="vm-meta">${vm.vcpus} vCPU &bull; ${vm.maxmem}</span>
        <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
          ${running
            ? `<button class="btn btn-xs btn-secondary" onclick="vmStop(${nameJson})">Shutdown</button>
               <button class="btn btn-xs btn-ghost" onclick="vmForceStop(${nameJson})">Force Off</button>
               <button class="btn btn-xs btn-ghost" onclick="vmOpenConsole(${nameJson})">Console</button>`
            : `<button class="btn btn-xs btn-primary" onclick="vmStart(${nameJson})">Start</button>`}
          <button class="btn btn-xs btn-danger" onclick="vmDelete(${nameJson})">Delete</button>
        </div>
      </div>
      <div id="vm-console-${vm.name}" class="hidden vm-console-panel"></div>
    </div>`;
  }).join('');
}

function toggleCreateVm() {
  document.getElementById('create-vm-form').classList.toggle('hidden');
}

function doCreateVm() {
  const name   = document.getElementById('vm-name').value.trim();
  const ram    = document.getElementById('vm-ram').value;
  const cpus   = document.getElementById('vm-cpus').value;
  const disk   = document.getElementById('vm-disk').value;
  const os     = document.getElementById('vm-os').value;
  const iso    = document.getElementById('vm-iso').value.trim();
  const msg    = document.getElementById('vm-create-msg');

  if (!name) { msg.style.color = 'var(--red)'; msg.textContent = 'VM name required.'; return; }
  msg.style.color = 'var(--text-dim)'; msg.textContent = 'Creating VM... this may take a moment.';

  const args = ['freeraid', 'vm-create', name, ram, cpus, disk, os];
  if (iso) args.push(iso);

  cockpit.spawn(args, { superuser: 'require', err: 'out' })
    .then(out => {
      msg.style.color = 'var(--green)'; msg.textContent = 'VM created.';
      document.getElementById('vm-name').value = '';
      setTimeout(() => { toggleCreateVm(); refreshVms(); }, 1200);
    })
    .catch(err => { msg.style.color = 'var(--red)'; msg.textContent = String(err); });
}

function vmStart(name) {
  _vmSetBusy(name, true);
  cockpit.spawn(['freeraid', 'vm-start', name], { superuser: 'require', err: 'out' })
    .then(() => { log('info', 'VM ' + name + ' started.'); refreshVms(); })
    .catch(err => { log('error', 'Start failed: ' + err); _vmSetBusy(name, false); });
}

function vmStop(name) {
  _vmSetBusy(name, true);
  cockpit.spawn(['freeraid', 'vm-stop', name], { superuser: 'require', err: 'out' })
    .then(() => { log('info', 'VM ' + name + ' shutting down.'); setTimeout(refreshVms, 2000); })
    .catch(err => { log('error', 'Shutdown failed: ' + err); _vmSetBusy(name, false); });
}

function vmForceStop(name) {
  if (!confirm('Force off "' + name + '"? This is like pulling the power cord.')) return;
  _vmSetBusy(name, true);
  cockpit.spawn(['freeraid', 'vm-stop', name, 'force'], { superuser: 'require', err: 'out' })
    .then(() => { log('info', 'VM ' + name + ' forced off.'); setTimeout(refreshVms, 1000); })
    .catch(err => { log('error', 'Force off failed: ' + err); _vmSetBusy(name, false); });
}

function vmDelete(name) {
  if (!confirm('Delete VM "' + name + '" and its disk image? This cannot be undone.')) return;
  cockpit.spawn(['freeraid', 'vm-delete', name], { superuser: 'require', err: 'out' })
    .then(() => { log('info', 'VM ' + name + ' deleted.'); refreshVms(); })
    .catch(err => log('error', 'Delete failed: ' + err));
}

function vmOpenConsole(name) {
  const panel = document.getElementById('vm-console-' + name);
  if (!panel) return;
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }

  // Get VNC port then open noVNC or show SSH tip
  let buf = '';
  cockpit.spawn(['freeraid', 'vm-vnc-port', name], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      const display = buf.trim(); // e.g. ":0" or ":1"
      if (!display) {
        panel.innerHTML = '<div style="padding:10px;color:var(--text-dim);font-size:12px">VNC not available for this VM.</div>';
        panel.classList.remove('hidden');
        return;
      }
      const displayNum = parseInt(display.replace(':', '')) || 0;
      const vncPort = 5900 + displayNum;
      const host = window.location.hostname;
      panel.classList.remove('hidden');
      panel.innerHTML = `<div style="padding:10px;font-size:12px">
        <div style="margin-bottom:6px;color:var(--text-dim)">VNC available on port <strong style="color:var(--text)">${vncPort}</strong></div>
        <div style="color:var(--text-dim)">Connect with any VNC client:</div>
        <code style="display:block;margin-top:4px;padding:6px;background:var(--bg);border-radius:4px">${host}:${vncPort}</code>
        <div style="margin-top:8px;color:var(--text-dim);font-size:11px">Or use Cockpit's built-in VM console (Machines plugin) for a full in-browser experience.</div>
      </div>`;
    })
    .catch(() => {
      panel.innerHTML = '<div style="padding:10px;color:var(--red);font-size:12px">Failed to get VNC info.</div>';
      panel.classList.remove('hidden');
    });
}

function _vmSetBusy(name, busy) {
  const card = document.getElementById('vm-card-' + name);
  if (!card) return;
  card.querySelectorAll('button').forEach(b => { b.disabled = busy; });
}

function refreshIsoList() {
  const el = document.getElementById('iso-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-msg">Scanning for ISOs...</div>';
  let buf = '';
  cockpit.spawn(['freeraid', 'vm-iso-list'], { superuser: 'require', err: 'out' })
    .stream(d => { buf += d; })
    .then(() => {
      let isos = [];
      try { isos = JSON.parse(buf.trim()); } catch(_) {}
      if (!isos.length) {
        el.innerHTML = '<div class="loading-msg">No ISO files found. Drop .iso files in <code>/mnt/user/isos/</code>.</div>';
        return;
      }
      el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:var(--text-dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em">
          <th style="text-align:left;padding:4px 8px">Name</th>
          <th style="text-align:left;padding:4px 8px">Path</th>
          <th style="text-align:right;padding:4px 8px">Size</th>
        </tr></thead>
        <tbody>
          ${isos.map(i => `<tr style="border-top:1px solid var(--border)">
            <td style="padding:6px 8px;font-family:monospace">${i.name}</td>
            <td style="padding:6px 8px;color:var(--text-dim);font-size:11px">${i.path}</td>
            <td style="padding:6px 8px;text-align:right;color:var(--text-dim)">${i.size}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    })
    .catch(() => { el.innerHTML = '<div class="loading-msg">Could not scan for ISOs.</div>'; });
}
