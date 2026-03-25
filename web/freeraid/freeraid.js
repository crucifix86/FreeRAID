/* FreeRAID Web UI — freeraid.js */
/* Communicates with the freeraid CLI via cockpit.spawn() */

'use strict';

// ── Cockpit bridge or fallback for dev in plain browser ──────────────────────

let cockpitAvail = false;

function initFallback() {
  // Running outside cockpit (e.g. direct file:// open for dev)
  window.cockpit = {
    spawn: (cmd, opts) => {
      const p = {};
      p.stream = () => p;
      p.then = (fn) => { fn('{"version":"0.1.0","array_state":"stopped","pool":{"size":"","used":"","free":"","pct":""},"parity":[{"slot":"parity","device":"/dev/vdf","mountpoint":"/mnt/parity","size":"8G","present":true,"mounted":false,"label":"Parity"}],"disks":[{"slot":"disk1","device":"/dev/vdb","mountpoint":"/mnt/disk1","enabled":true,"present":true,"mounted":false,"size":"8G","used":"","free":"","pct":"","label":"Disk 1"},{"slot":"disk2","device":"/dev/vdc","mountpoint":"/mnt/disk2","enabled":true,"present":true,"mounted":false,"size":"8G","used":"","free":"","pct":"","label":"Disk 2"}],"cache":[{"slot":"cache","device":"/dev/vdg","mountpoint":"/mnt/cache","enabled":true,"present":true,"mounted":false,"size":"4G","used":"","free":"","pct":"","label":"Cache"}],"last_sync":"never"}'); return p; };
      p.catch = () => p;
      return p;
    }
  };
  log('warn', 'Running without Cockpit — demo mode (no real commands will run)');
}

// Check if cockpit is available after page load
window.addEventListener('load', () => {
  if (typeof cockpit !== 'undefined') {
    cockpitAvail = true;
  } else {
    initFallback();
  }
  refreshStatus();
  setInterval(refreshStatus, 8000);
});

// ── State ────────────────────────────────────────────────────────────────────

let arrayState = 'stopped';
let opRunning  = false;

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level, text) {
  const panel = document.getElementById('log-panel');
  const line  = document.createElement('p');
  line.className = `log-line log-${level}`;
  const ts = new Date().toTimeString().slice(0, 8);
  line.textContent = `[${ts}] ${text}`;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}

function clearLog() {
  document.getElementById('log-panel').innerHTML = '';
}

function showAlert(type, msg) {
  const bar = document.getElementById('alert-bar');
  bar.className = `alert ${type}`;
  bar.textContent = msg;
}

function hideAlert() {
  document.getElementById('alert-bar').className = 'alert hidden';
}

// ── Run a freeraid command, stream output to log ─────────────────────────────

function runCmd(args, label) {
  return new Promise((resolve, reject) => {
    log('cmd', `$ freeraid ${args.join(' ')}`);
    showAlert('info', `Running: freeraid ${args.join(' ')}...`);

    // Strip ANSI escape codes from output
    const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

    let outputBuf = '';

    const proc = cockpit.spawn(['freeraid', ...args], { superuser: 'require', err: 'out' })
      .stream(data => {
        outputBuf += data;
        stripAnsi(data).split('\n').filter(l => l.trim()).forEach(line => {
          const lvl = line.includes('ERROR') ? 'error'
                    : line.includes('WARN')  ? 'warn'
                    : line.startsWith('==>') ? 'success'
                    : 'info';
          log(lvl, stripAnsi(line));
        });
      })
      .then(() => {
        hideAlert();
        log('success', `✓ ${label || args[0]} completed`);
        resolve(outputBuf);
      })
      .catch(err => {
        showAlert('error', `Error running freeraid ${args[0]}: ${err.message || err}`);
        log('error', `✗ ${label || args[0]} failed: ${err.message || err}`);
        reject(err);
      });
  });
}

// ── Status refresh ───────────────────────────────────────────────────────────

function refreshStatus() {
  let buf = '';
  cockpit.spawn(['freeraid', 'status', '--json'], { superuser: 'require', err: 'ignore' })
    .stream(d => { buf += d; })
    .then(() => {
      try {
        // Find the JSON object in output (CLI may print other stuff before it)
        const jsonStart = buf.indexOf('{');
        const data = JSON.parse(buf.slice(jsonStart));
        applyStatus(data);
      } catch (e) {
        log('warn', 'Could not parse status JSON: ' + e);
      }
    })
    .catch(err => {
      log('error', 'Status fetch failed: ' + (err.message || err));
    });
}

function applyStatus(data) {
  arrayState = data.array_state;

  // Version
  document.getElementById('version').textContent = 'v' + data.version;

  // Badge
  const badge = document.getElementById('array-badge');
  badge.textContent = arrayState === 'started' ? '●  Array Started' : '●  Array Stopped';
  badge.className = 'array-badge ' + (arrayState === 'started' ? 'started' : 'stopped');

  // Start/stop button
  const btn = document.getElementById('btn-start-stop');
  btn.textContent = arrayState === 'started' ? 'Stop Array' : 'Start Array';
  btn.className   = 'btn ' + (arrayState === 'started' ? 'btn-danger' : 'btn-primary');

  // Pool stats
  if (data.pool && data.pool.size) {
    document.getElementById('pool-size').textContent = data.pool.size || '—';
    document.getElementById('pool-used').textContent = data.pool.used || '—';
    document.getElementById('pool-free').textContent = data.pool.free || '—';
  }
  document.getElementById('last-sync').textContent = data.last_sync || 'never';

  // Drives
  renderDrives(data);
}

// ── Drive cards ──────────────────────────────────────────────────────────────

function usagePct(pctStr) {
  return parseInt(pctStr) || 0;
}

function driveCard(drive, type) {
  const mounted  = drive.mounted;
  const present  = drive.present;
  const enabled  = drive.enabled !== false;
  const pct      = usagePct(drive.pct);

  let dotClass = 'dot-grey';
  if (!present)       dotClass = 'dot-red';
  else if (!enabled)  dotClass = 'dot-grey';
  else if (mounted)   dotClass = 'dot-green';
  else                dotClass = 'dot-yellow';

  let cardClass = `drive-card type-${type}`;
  if (!enabled) cardClass += ' disabled';
  if (!present) cardClass += ' missing';

  let statusText = '—';
  if (!present)      statusText = 'Not found';
  else if (!enabled) statusText = 'Disabled';
  else if (!mounted) statusText = 'Not mounted';

  let usageHtml = '';
  if (mounted && drive.used) {
    const barClass = pct >= 90 ? 'danger' : pct >= 75 ? 'high' : '';
    usageHtml = `
      <div class="usage-bar-wrap">
        <div class="usage-bar-bg">
          <div class="usage-bar-fill ${barClass}" style="width:${pct}%"></div>
        </div>
        <div class="usage-stats">
          <span>${drive.used} used</span>
          <span>${drive.free} free</span>
        </div>
      </div>`;
  } else if (!mounted && present && enabled) {
    usageHtml = `<div class="usage-stats"><span style="color:var(--yellow)">${statusText}</span></div>`;
  }

  const typeLabel = type === 'parity' ? 'Parity' : type === 'cache' ? 'Cache' : 'Data';

  return `
    <div class="${cardClass}">
      <div class="drive-header">
        <span class="drive-status-dot ${dotClass}"></span>
        <span class="drive-slot">${drive.slot}</span>
        <span class="drive-type-badge">${typeLabel}</span>
      </div>
      <div class="drive-device">${drive.device}</div>
      <div class="drive-label">${drive.label}${drive.size ? ' · ' + drive.size : ''}</div>
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

// ── Actions ──────────────────────────────────────────────────────────────────

function toggleArray() {
  if (opRunning) return;
  opRunning = true;
  setButtonsDisabled(true);

  const action = arrayState === 'started' ? 'stop' : 'start';
  runCmd([action], action + ' array')
    .then(() => refreshStatus())
    .catch(() => {})
    .finally(() => {
      opRunning = false;
      setButtonsDisabled(false);
    });
}

function runSync() {
  if (opRunning) return;
  opRunning = true;
  setButtonsDisabled(true);
  log('cmd', 'Starting SnapRAID parity sync...');

  runCmd(['sync'], 'parity sync')
    .then(() => refreshStatus())
    .catch(() => {})
    .finally(() => {
      opRunning = false;
      setButtonsDisabled(false);
    });
}

function setButtonsDisabled(disabled) {
  document.getElementById('btn-start-stop').disabled = disabled;
  document.getElementById('btn-sync').disabled = disabled;
}
