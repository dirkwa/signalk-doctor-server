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
  if (state.token) {
    headers.set('Authorization', `Bearer ${state.token}`);
    headers.set('X-SK-Auth', state.token);
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

// ── Tab switching ───────────────────────────────────────
function activateTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('is-hidden', v.id !== `view-${name}`);
  });

  if (name === 'snapshots') refreshSnapshots();
}

// ── Boot ────────────────────────────────────────────────
async function boot() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  document.getElementById('refresh').addEventListener('click', () => refreshProbes());
  document.getElementById('recover-all').addEventListener('click', doRecoverAll);
  document.getElementById('recover-updater').addEventListener('click', doRecoverUpdater);

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
}

boot();
