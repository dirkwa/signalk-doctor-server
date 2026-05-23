// SignalK Doctor — single-page console.
//
// Three tabs:
//   - Health: GET /api/probes → live grid of probe results
//   - Snapshots: GET /api/snapshots + GET /api/last-good
//   - Recovery: POST /api/recover{,/updater} (token-gated)

const ROUTES = {
  session: '/api/session',
  health: '/api/health',
  probes: '/api/probes',
  snapshots: '/api/snapshots',
  lastGood: '/api/last-good',
  recover: '/api/recover',
  recoverUpdater: '/api/recover/updater',
  logsStream: (name, tail) =>
    `/api/containers/${encodeURIComponent(name)}/logs/stream?tail=${tail}`,
  logsOnce: (name, tail) => `/api/containers/${encodeURIComponent(name)}/logs?tail=${tail}`,
};

const state = {
  token: null,
  probes: null,
};

// ── Auth-aware fetch helper ──────────────────────────────
async function api(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  // Per CC-2: the doctor only requires auth on mutating endpoints
  // (POST /api/recover*). Read-only probes stay unauthenticated by
  // design — they are the recovery surface a desperate user reaches
  // for. Attaching the bearer to GETs would just leak the token
  // through proxy logs for no benefit.
  const isMutating = typeof init.method === 'string' && init.method.toUpperCase() !== 'GET';
  if (state.token && isMutating) {
    headers.set('Authorization', `Bearer ${state.token}`);
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return null;
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && body.error) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function loadSession() {
  try {
    const s = await api(ROUTES.session);
    state.token = s?.token ?? null;
  } catch (err) {
    toast(`Session bootstrap failed: ${err.message}`, 'err');
  }
}

// ── Toast helper ─────────────────────────────────────────
let toastTimer = null;
function toast(message, kind = 'info', durationMs = 4000) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast is-${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('is-hidden'), durationMs);
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ── Probes ──────────────────────────────────────────────
async function refreshProbes() {
  document.getElementById('probes-meta').textContent = 'Running probes…';
  try {
    const data = await api(ROUTES.probes);
    state.probes = data;
    renderProbes(data);
  } catch (err) {
    document.getElementById('probes-list').innerHTML =
      `<p class="footnote">Failed to run probes: ${escapeHtml(err.message)}</p>`;
  }
}

function renderProbes(data) {
  document.querySelector('[data-summary=ok]').textContent = data.summary.ok;
  document.querySelector('[data-summary=warn]').textContent = data.summary.warn;
  document.querySelector('[data-summary=fail]').textContent = data.summary.fail;
  document.querySelector('[data-summary=unknown]').textContent = data.summary.unknown;
  document.getElementById('probes-meta').textContent =
    `Ran at ${fmtTime(data.ranAt)} (${relTime(data.ranAt)}) · ${data.durationMs}ms · ${data.results.length} probes`;

  const list = document.getElementById('probes-list');
  list.innerHTML = '';

  // Show failures first, then warnings, then unknowns, then ok.
  const ord = { fail: 0, warn: 1, unknown: 2, ok: 3 };
  const sorted = [...data.results].sort((a, b) => ord[a.status] - ord[b.status]);

  for (const probe of sorted) {
    const row = document.createElement('div');
    row.className = `probe probe-${probe.status}`;
    const detailsBlock = probe.details
      ? `<pre class="probe-details">${escapeHtml(JSON.stringify(probe.details, null, 2))}</pre>`
      : '';
    row.innerHTML = `
      <div>
        <div class="probe-label">${escapeHtml(probe.label)}</div>
        <div class="probe-status">${escapeHtml(probe.status)}</div>
      </div>
      <div class="probe-body">
        <p class="probe-message">${escapeHtml(probe.message)}</p>
        ${detailsBlock}
      </div>
      <div class="probe-duration">${probe.durationMs}ms</div>
    `;
    list.appendChild(row);
  }
}

// ── Snapshots ───────────────────────────────────────────
async function refreshSnapshots() {
  try {
    const [snapshots, lastGood] = await Promise.all([api(ROUTES.snapshots), api(ROUTES.lastGood)]);
    renderSnapshots(snapshots, lastGood);
  } catch (err) {
    document.getElementById('snapshots').innerHTML =
      `<p class="footnote">Failed to load snapshots: ${escapeHtml(err.message)}</p>`;
  }
}

function renderSnapshots(snapshotsResp, lastGood) {
  document.getElementById('snapshots-meta').textContent =
    snapshotsResp.count > 0
      ? `${snapshotsResp.count} Quadlet snapshot${snapshotsResp.count === 1 ? '' : 's'} on disk`
      : 'No Quadlet snapshots yet — none have been written by the updater or doctor.';

  // Last-known-good block.
  const lg = document.getElementById('last-good');
  lg.innerHTML = '';
  if (lastGood && lastGood.quadlets && Object.keys(lastGood.quadlets).length > 0) {
    const block = document.createElement('div');
    block.className = 'snapshot-group';
    const updated = lastGood.updatedAt
      ? `Updated ${fmtTime(lastGood.updatedAt)} (${relTime(lastGood.updatedAt)})`
      : 'Updated time unknown';
    let rows = '';
    for (const [quadlet, entry] of Object.entries(lastGood.quadlets)) {
      rows += `<tr><td>${escapeHtml(quadlet)}</td><td class="mono">${escapeHtml(entry.tag ?? '—')}</td><td class="mono">${escapeHtml(entry.snapshotFile ?? '—')}</td></tr>`;
    }
    block.innerHTML = `
      <h2>Last-known-good</h2>
      <p class="footnote" style="margin-top:0">${updated}</p>
      <table class="snapshot-table">
        <thead><tr><th>Quadlet</th><th>Tag</th><th>Snapshot file</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    lg.appendChild(block);
  } else {
    lg.innerHTML =
      '<p class="footnote">No last-known-good entries yet — the first successful version switch records one.</p>';
  }

  // All snapshots block, grouped by source quadlet filename suffix.
  const grouped = new Map();
  for (const snap of snapshotsResp.snapshots) {
    const m = snap.name.match(/-(.*)$/);
    const group = m ? m[1] : snap.name;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(snap);
  }

  const out = document.getElementById('snapshots');
  out.innerHTML = '';
  if (grouped.size === 0) return;

  for (const [group, snaps] of [...grouped.entries()].sort()) {
    const block = document.createElement('div');
    block.className = 'snapshot-group';
    let rows = '';
    for (const snap of snaps) {
      rows += `<tr><td class="mono">${escapeHtml(snap.name)}</td><td>${fmtTime(snap.mtime)}</td><td>${relTime(snap.mtime)}</td><td>${fmtSize(snap.size)}</td></tr>`;
    }
    block.innerHTML = `
      <h2>${escapeHtml(group)} <span class="footnote" style="margin:0">(${snaps.length} snapshot${snaps.length === 1 ? '' : 's'})</span></h2>
      <table class="snapshot-table">
        <thead><tr><th>File</th><th>Captured</th><th></th><th>Size</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    out.appendChild(block);
  }
}

// ── Modal ───────────────────────────────────────────────
function showConfirm({ title, body, okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = body;
    document.getElementById('confirm-ok').textContent = okLabel;
    dialog.showModal();
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    const onOk = () => {
      dialog.close();
      cleanup();
      resolve(true);
    };
    const onCancel = () => {
      dialog.close();
      cleanup();
      resolve(false);
    };
    function cleanup() {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
    }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

// ── Recover actions ─────────────────────────────────────
async function doRecoverAll() {
  const ok = await showConfirm({
    title: 'Recover all to last-known-good?',
    body: 'This will roll signalk-server AND signalk-updater-server back to their last-known-good Quadlets, daemon-reload, and restart both. Expect 30–60s of downtime.',
    okLabel: 'Recover',
  });
  if (!ok) return;
  await runRecover(ROUTES.recover, 'all');
}

async function doRecoverUpdater() {
  const ok = await showConfirm({
    title: 'Recover updater only?',
    body: 'This restores signalk-updater-server.container from last-known-good and restarts the updater. signalk-server is not touched.',
    okLabel: 'Recover updater',
  });
  if (!ok) return;
  await runRecover(ROUTES.recoverUpdater, 'updater');
}

async function runRecover(path, label) {
  const out = document.getElementById('recover-result');
  out.classList.remove('is-hidden');
  out.textContent = `Recovering ${label}…`;
  try {
    toast(`Recovering ${label}…`, 'info', 30000);
    const result = await api(path, { method: 'POST' });
    out.textContent = JSON.stringify(result, null, 2);
    toast(`Recovery (${label}) completed`, 'ok');
    // Refresh probes so the user sees the new state.
    setTimeout(refreshProbes, 1500);
  } catch (err) {
    out.textContent = `Recovery (${label}) failed:\n${err.message}\n\n${err.body ? JSON.stringify(err.body, null, 2) : ''}`;
    toast(`Recovery failed: ${err.message}`, 'err', 8000);
  }
}

// ── Logs view ───────────────────────────────────────────
//
// Same broker-backed Logs experience as the Updater Console. Pulling
// the doctor's own logs into the doctor surface is the whole point of
// having this tab here — if recovery itself misbehaves, the doctor's
// container logs are where the next clue lives, and getting at them
// shouldn't require shelling into the host.
let logsEventSource = null;
let logsPaused = false;

const LEVEL_RX_PINO = /"level":(\d+)/;
const PINO_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_RX_WORD = /\b(trace|debug|info|warn(?:ing)?|error|fatal)\b/i;
const TS_RX_FRONT = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*/;
const TS_RX_PINO = /"time":(\d{10,13})/;

function parseLogLine(raw) {
  if (!raw) return { time: null, level: '', message: '', raw };
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const lvlNum = obj.level;
      const level = PINO_LEVELS[lvlNum] || (typeof lvlNum === 'string' ? lvlNum : '');
      const time = obj.time ? new Date(Number(obj.time)).toISOString() : null;
      const msg = obj.msg || obj.message || '';
      const extras = Object.entries(obj)
        .filter(([k]) => !['level', 'time', 'msg', 'message', 'hostname', 'pid', 'v'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      return { time, level, message: extras ? `${msg} ${extras}` : msg, raw };
    } catch {
      // not JSON
    }
  }
  let line = raw;
  let time = null;
  const tsMatch = line.match(TS_RX_FRONT);
  if (tsMatch) {
    time = tsMatch[1];
    line = line.slice(tsMatch[0].length);
  } else {
    const pinoTs = line.match(TS_RX_PINO);
    if (pinoTs) time = new Date(Number(pinoTs[1])).toISOString();
  }
  let level = '';
  const lvlMatch = line.match(LEVEL_RX_WORD);
  if (lvlMatch) level = lvlMatch[1].toLowerCase().replace('warning', 'warn');
  if (!level) {
    const num = line.match(LEVEL_RX_PINO);
    if (num) level = PINO_LEVELS[Number(num[1])] || '';
  }
  return { time, level, message: line, raw };
}

function logLevelClass(level) {
  if (level === 'error' || level === 'fatal') return 'log-err';
  if (level === 'warn') return 'log-warn';
  if (level === 'debug' || level === 'trace') return 'log-debug';
  if (level === 'info') return 'log-info';
  return 'log-plain';
}

function fmtLogTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso.slice(11, 19);
  }
}

function isScrolledNearBottom(el) {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
}

function appendLogLine(out, raw) {
  const wasAtBottom = isScrolledNearBottom(out);
  const parsed = parseLogLine(raw);
  const row = document.createElement('div');
  row.className = `log-row ${logLevelClass(parsed.level)}`;
  const time = parsed.time ? fmtLogTime(parsed.time) : '';
  row.innerHTML = `<span class="log-time">${escapeHtml(time)}</span><span class="log-level">${escapeHtml(parsed.level || '')}</span><span class="log-msg">${escapeHtml(parsed.message)}</span>`;
  out.appendChild(row);
  while (out.children.length > 2000) out.removeChild(out.firstChild);
  if (wasAtBottom) out.scrollTop = out.scrollHeight;
}

function clearLogs() {
  const out = document.getElementById('logs-output');
  out.innerHTML = '';
}

function setLogsStatus(state) {
  // state: 'connecting' | 'connected' | 'paused' | 'disconnected' | 'error'
  const el = document.getElementById('logs-status');
  el.textContent = state;
  el.className = `logs-status logs-status-${state}`;
}

function stopLogsStream() {
  if (logsEventSource) {
    logsEventSource.close();
    logsEventSource = null;
  }
  setLogsStatus('disconnected');
}

// Streaming-by-default: every time the Logs tab activates, the
// container dropdown changes, or the lines input changes, we tear down
// the previous stream and open a fresh one. The broker's ring buffer
// means the new connection gets immediate backfill even on first hit.
function startLogsStream() {
  stopLogsStream();
  const containerSel = document.getElementById('logs-container');
  const name = containerSel ? containerSel.value : 'signalk-doctor-server';
  const tail = Number.parseInt(document.getElementById('logs-lines').value, 10) || 500;
  const out = document.getElementById('logs-output');
  clearLogs();
  setLogsStatus('connecting');
  const es = new EventSource(ROUTES.logsStream(name, tail));
  logsEventSource = es;
  es.onopen = () => setLogsStatus(logsPaused ? 'paused' : 'connected');
  es.onmessage = (ev) => {
    if (logsPaused) return;
    appendLogLine(out, ev.data);
  };
  es.addEventListener('end', (ev) => {
    const note = document.createElement('div');
    note.className = 'log-row log-plain';
    note.textContent = `[stream ended: ${ev.data || 'closed'}]`;
    out.appendChild(note);
    stopLogsStream();
  });
  es.addEventListener('error', () => {
    setLogsStatus('error');
    // EventSource auto-reconnects on transient errors; the status
    // pill flips back to "connected" via onopen when it succeeds.
  });
}

function toggleLogsPause() {
  logsPaused = !logsPaused;
  const btn = document.getElementById('logs-pause');
  if (logsPaused) {
    btn.textContent = 'Resume';
    btn.classList.remove('btn-ghost');
    btn.classList.add('btn-primary');
    setLogsStatus('paused');
  } else {
    btn.textContent = 'Pause';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-ghost');
    setLogsStatus(logsEventSource ? 'connected' : 'disconnected');
  }
}

// ── Tab switching ───────────────────────────────────────
function activateTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('is-hidden', v.id !== `view-${name}`);
  });

  if (name === 'snapshots') refreshSnapshots();
  if (name === 'logs') {
    startLogsStream();
  } else {
    // Tear the SSE down so a logs tab left in the background doesn't
    // keep DOM updates ticking and doesn't hold the broker open if
    // it's the only subscriber.
    stopLogsStream();
  }
}

// ── Boot ────────────────────────────────────────────────
async function boot() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  document.getElementById('refresh').addEventListener('click', () => refreshProbes());
  document.getElementById('recover-all').addEventListener('click', doRecoverAll);
  document.getElementById('recover-updater').addEventListener('click', doRecoverUpdater);
  document.getElementById('logs-pause').addEventListener('click', () => toggleLogsPause());
  document.getElementById('logs-clear').addEventListener('click', () => clearLogs());
  document.getElementById('logs-container').addEventListener('change', () => startLogsStream());
  document.getElementById('logs-lines').addEventListener('change', () => startLogsStream());

  // Open Updater Console — port 3003 on the same host.
  const link = document.getElementById('open-updater');
  link.href = `${window.location.protocol}//${window.location.hostname}:3003/`;

  await loadSession();
  await refreshProbes();

  // Light polling: re-run probes every 15s while Health tab is visible.
  setInterval(() => {
    if (
      !document.hidden &&
      !document.getElementById('view-probes').classList.contains('is-hidden')
    ) {
      refreshProbes();
    }
  }, 15000);

  // Suspend the logs SSE when the page is hidden (browser tab in
  // background, laptop lid closed, …). The broker keeps running
  // server-side; the user just stops paying for DOM updates they
  // can't see. Resumes automatically when the page becomes visible
  // again if the Logs tab is still selected.
  document.addEventListener('visibilitychange', () => {
    const logsVisible = !document.getElementById('view-logs').classList.contains('is-hidden');
    if (!logsVisible) return;
    if (document.hidden) {
      stopLogsStream();
    } else {
      startLogsStream();
    }
  });
}

boot();
