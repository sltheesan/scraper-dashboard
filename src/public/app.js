// Bootstrap: verify auth, then load profiles.
(async () => {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('not authenticated');
    const { username } = await res.json();
    document.getElementById('user').textContent = username;
  } catch {
    window.location.href = '/login';
    return;
  }
  loadProfiles();
})();

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

// ---- Live activity log (SSE) ----
const logPanel = document.getElementById('log-panel');
const logStatus = document.getElementById('log-status');
const logAutoscroll = document.getElementById('log-autoscroll');
let logHasContent = false;

document.getElementById('log-clear').addEventListener('click', () => {
  logPanel.innerHTML = '<div class="muted" style="padding: 12px;">Cleared.</div>';
  logHasContent = false;
});

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function appendLogEvent(event) {
  if (!logHasContent) {
    logPanel.innerHTML = '';
    logHasContent = true;
  }
  const line = document.createElement('div');
  line.className = `log-line lvl-${event.level || 'info'}`;
  line.innerHTML = `
    <span class="log-ts">${formatTime(event.ts)}</span>
    <span class="log-source">${escapeHtml(event.source || '')}</span>
    <span class="log-profile">${escapeHtml(event.profile || '')}</span>
    <span class="log-msg">${escapeHtml(event.message || '')}</span>
  `;
  logPanel.appendChild(line);

  // Cap DOM size — drop oldest if we exceed ~500 lines.
  while (logPanel.children.length > 500) {
    logPanel.removeChild(logPanel.firstChild);
  }

  if (logAutoscroll.checked) {
    logPanel.scrollTop = logPanel.scrollHeight;
  }
}

function openLogStream() {
  const es = new EventSource('/api/logs/stream');
  logStatus.textContent = 'connecting…';
  es.onopen = () => { logStatus.textContent = 'live'; };
  es.onmessage = (e) => {
    try {
      appendLogEvent(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => {
    logStatus.textContent = 'reconnecting…';
    // EventSource auto-reconnects with a backoff.
  };
}

openLogStream();

// ---- Scheduler settings (global) ----
const settingsModal = document.getElementById('settings-modal');
const fetchEnabledEl = document.getElementById('fetch-enabled');
const fetchMinutesEl = document.getElementById('fetch-minutes');
const refreshEnabledEl = document.getElementById('refresh-enabled');
const refreshMinutesEl = document.getElementById('refresh-minutes');
const settingsError = document.getElementById('settings-error');

document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () => settingsModal.hidden = true);
document.getElementById('settings-cancel').addEventListener('click', () => settingsModal.hidden = true);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.hidden = true; });

function applySlot(slot, enabledEl, minutesEl) {
  enabledEl.checked = !!slot?.enabled;
  minutesEl.value = Math.max(1, Math.round((slot?.intervalMs || 300000) / 60000));
}

function readSlot(enabledEl, minutesEl) {
  const minutes = Math.max(1, Number(minutesEl.value) || 5);
  return { enabled: enabledEl.checked, intervalMs: minutes * 60 * 1000 };
}

async function openSettings() {
  settingsError.hidden = true;
  applySlot({}, fetchEnabledEl, fetchMinutesEl);
  applySlot({}, refreshEnabledEl, refreshMinutesEl);
  settingsModal.hidden = false;
  try {
    const res = await fetch('/api/settings/scheduler');
    if (!res.ok) throw new Error('Failed to load settings');
    const { settings } = await res.json();
    applySlot(settings.fetch, fetchEnabledEl, fetchMinutesEl);
    applySlot(settings.refresh, refreshEnabledEl, refreshMinutesEl);
  } catch (err) {
    settingsError.textContent = err.message;
    settingsError.hidden = false;
  }
}

document.getElementById('settings-save').addEventListener('click', async () => {
  settingsError.hidden = true;
  const payload = {
    fetch: readSlot(fetchEnabledEl, fetchMinutesEl),
    refresh: readSlot(refreshEnabledEl, refreshMinutesEl),
  };
  try {
    const res = await fetch('/api/settings/scheduler', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || 'Save failed');
    }
    settingsModal.hidden = true;
  } catch (err) {
    settingsError.textContent = err.message;
    settingsError.hidden = false;
  }
});

const tbody = document.getElementById('profiles-body');
const table = document.getElementById('profiles-table');
const empty = document.getElementById('empty');

async function loadProfiles() {
  const res = await fetch('/api/profiles');
  if (!res.ok) {
    tbody.innerHTML = '';
    empty.hidden = false;
    table.hidden = true;
    return;
  }
  const profiles = await res.json();
  render(profiles);
}

function render(profiles) {
  if (!profiles.length) {
    table.hidden = true;
    empty.hidden = false;
    tbody.innerHTML = '';
    return;
  }
  empty.hidden = true;
  table.hidden = false;
  tbody.innerHTML = profiles.map(rowHtml).join('');
}

function rowHtml(p) {
  const lastScrape = p.lastScrapeAt
    ? new Date(p.lastScrapeAt).toLocaleString()
    : '—';
  return `
    <tr data-id="${p.id}">
      <td><strong>${escapeHtml(p.name)}</strong></td>
      <td class="truncate" title="${escapeHtml(p.targetUrl)}">${escapeHtml(p.targetUrl)}</td>
      <td><span class="muted">${escapeHtml(p.kind || '')}</span></td>
      <td><span class="status status-${p.status}">${p.status}</span></td>
      <td class="muted">${lastScrape}</td>
      <td class="row-actions">
        <button class="login-btn ghost">Login</button>
        <button class="fetch-btn">Fetch</button>
        <button class="ghost edit-btn">Edit</button>
        <button class="ghost danger delete-btn">Delete</button>
      </td>
    </tr>
  `;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Row action delegation
tbody.addEventListener('click', async (e) => {
  const row = e.target.closest('tr');
  if (!row) return;
  const id = row.dataset.id;

  if (e.target.classList.contains('edit-btn')) {
    const res = await fetch(`/api/profiles/${id}`);
    if (res.ok) openModal(await res.json());
  } else if (e.target.classList.contains('delete-btn')) {
    const name = row.querySelector('strong').textContent;
    if (!confirm(`Delete profile "${name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
    if (res.ok) loadProfiles();
  } else if (e.target.classList.contains('fetch-btn')) {
    const name = row.querySelector('strong').textContent;
    runFetch(id, name, e.target);
  } else if (e.target.classList.contains('login-btn')) {
    const name = row.querySelector('strong').textContent;
    startLogin(id, name, e.target);
  }
});

// ---- Login flow ----
const loginModal = document.getElementById('login-modal');
const loginNameEl = document.getElementById('login-profile-name');
const loginStatusEl = document.getElementById('login-status');
const loginSaveBtn = document.getElementById('login-save');
const loginCancelBtn = document.getElementById('login-cancel');
let activeLoginId = null;

async function startLogin(id, name, button) {
  loginNameEl.textContent = name;
  loginStatusEl.textContent = 'Opening browser…';
  loginSaveBtn.disabled = true;
  loginCancelBtn.disabled = false;
  loginModal.hidden = false;
  button.disabled = true;

  try {
    const res = await fetch(`/api/profiles/${id}/login`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Failed to start login');

    activeLoginId = id;
    loginStatusEl.textContent = body.alreadyOpen
      ? 'A login window for this profile is already open.'
      : 'Browser opened. Complete the login, then click "Save session".';
    loginSaveBtn.disabled = false;
  } catch (err) {
    loginStatusEl.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

loginSaveBtn.addEventListener('click', async () => {
  if (!activeLoginId) return;
  loginSaveBtn.disabled = true;
  loginCancelBtn.disabled = true;
  loginStatusEl.textContent = 'Saving session…';
  try {
    const res = await fetch(`/api/profiles/${activeLoginId}/login/finish`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to save session');
    }
    activeLoginId = null;
    loginModal.hidden = true;
    loadProfiles();
  } catch (err) {
    loginStatusEl.textContent = err.message;
    loginSaveBtn.disabled = false;
    loginCancelBtn.disabled = false;
  }
});

loginCancelBtn.addEventListener('click', async () => {
  if (!activeLoginId) {
    loginModal.hidden = true;
    return;
  }
  loginCancelBtn.disabled = true;
  loginSaveBtn.disabled = true;
  try {
    await fetch(`/api/profiles/${activeLoginId}/login/cancel`, { method: 'POST' });
  } catch {}
  activeLoginId = null;
  loginModal.hidden = true;
});

// ---- Fetch action ----
const fetchModal = document.getElementById('fetch-modal');
const fetchModalBody = document.getElementById('fetch-modal-body');
const fetchModalTitle = document.getElementById('fetch-modal-title');

document.getElementById('fetch-modal-close').addEventListener('click', () => {
  fetchModal.hidden = true;
});
fetchModal.addEventListener('click', (e) => {
  if (e.target === fetchModal) fetchModal.hidden = true;
});

async function runFetch(id, name, button) {
  fetchModalTitle.textContent = `Fetch result: ${name}`;
  fetchModalBody.innerHTML = '<p class="muted">Running fetch — this can take 10–30 seconds…</p>';
  fetchModal.hidden = false;

  const prevText = button.textContent;
  button.disabled = true;
  button.textContent = 'Fetching…';

  try {
    const res = await fetch(`/api/profiles/${id}/fetch`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));

    if (res.status === 409 && body.error === 'logged_out') {
      fetchModalBody.innerHTML = `
        <div class="alert alert-warn">
          <strong>Session expired or missing.</strong>
          <p>Close this dialog and click <strong>Login</strong> on the profile row to refresh the session.</p>
          <p class="muted">Landed on: ${escapeHtml(body.url || '')}</p>
        </div>
      `;
      loadProfiles();
      return;
    }

    if (!res.ok) {
      fetchModalBody.innerHTML = `
        <div class="alert alert-error">
          <strong>Fetch failed.</strong>
          <p>${escapeHtml(body.message || res.statusText)}</p>
        </div>
      `;
      loadProfiles();
      return;
    }

    fetchModalBody.innerHTML = renderFetchResult(body);
    loadProfiles();
  } catch (err) {
    fetchModalBody.innerHTML = `<div class="alert alert-error"><strong>Network error.</strong><p>${escapeHtml(err.message)}</p></div>`;
  } finally {
    button.disabled = false;
    button.textContent = prevText;
  }
}

const COMMON_LABELS = {
  newRegistrationCount: 'New Registration Count',
  newDepositCount: 'New Deposit Count',
  totalDepositCount: 'Total Deposit Count',
  totalDepositAmount: 'Total Deposit Amount',
  totalWithdrawalCount: 'Total Withdrawal Count',
  totalWithdrawalAmount: 'Total Withdrawal Amount',
};

function formatCellValue(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return v.toLocaleString('en-US');
  return String(v);
}

function buildParsedRows(parsed) {
  return Object.entries(COMMON_LABELS).map(([k, label]) => ({
    label,
    value: formatCellValue(parsed.data?.[k]),
  }));
}

function renderParsedPanel(parsed) {
  const reportDate = new Date(parsed.reportDate).toLocaleDateString();
  const rows = buildParsedRows(parsed)
    .map(({ label, value }) => `
      <tr>
        <th>${escapeHtml(label)}</th>
        <td>${escapeHtml(value)}</td>
      </tr>
    `)
    .join('');

  const subTitle = parsed.kind === 'cgaming'
    ? (parsed.reportDateString || reportDate)
    : new Date().toLocaleString();

  return `
    <div class="parsed-panel">
      <div class="parsed-head">
        <h4>Preview <span class="badge">manual fetch · not saved</span></h4>
        <span class="muted">${escapeHtml(subTitle)}</span>
      </div>
      <table class="kv"><tbody>${rows}</tbody></table>
    </div>
  `;
}

function renderFetchResult(body) {
  const parts = [];

  if (body.parsed) {
    parts.push(renderParsedPanel(body.parsed));
  } else if (body.kind === 'cgaming' && body.tables?.length) {
    parts.push(`
      <div class="alert alert-warn">
        <strong>No row matched today's date.</strong>
        <p>The bank-summary table was found, but no row's start date matches today
        (${new Date().toLocaleDateString()}). Maybe the new period hasn't started yet,
        or the table sort order differs.</p>
      </div>
    `);
  } else if (body.kind === 'zoomwlb') {
    const fieldsHasAnyValue = Object.values(body.fields || {}).some((v) => v != null);
    if (!fieldsHasAnyValue) {
      parts.push(`
        <div class="alert alert-warn">
          <strong>No values extracted.</strong>
          <p>None of the HTML ids in this profile's <strong>Data fields</strong> were
          found on the page. Open the page in a browser, inspect each metric you
          want, copy its <code>id</code> attribute, and update the profile.</p>
        </div>
      `);
    }
  }

  parts.push('<div class="diag muted">');
  parts.push(`<div>URL: ${escapeHtml(body.url || '')}</div>`);
  if (body.title) parts.push(`<div>Title: ${escapeHtml(body.title)}</div>`);
  if (body.frameCount > 1) parts.push(`<div>Frames: ${body.frameCount}</div>`);
  parts.push('</div>');

  const fields = body.fields || {};
  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length) {
    parts.push('<h4>Data fields</h4>');
    parts.push('<table class="kv"><tbody>');
    for (const k of fieldKeys) {
      parts.push(`<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(fields[k] ?? '')}</td></tr>`);
    }
    parts.push('</tbody></table>');
  }

  const tables = body.tables || [];
  if (!tables.length && !fieldKeys.length) {
    parts.push(`
      <div class="alert alert-warn">
        <strong>No tables found.</strong>
        <p>Things to check:</p>
        <ul>
          <li>Is the <strong>Button selector</strong> on the profile correct? Without a click, the table won't appear.</li>
          <li>Did the click need a date range or other input first? (Manual interaction inside the headed login window can pre-select things.)</li>
          <li>Open the page in a normal browser, inspect the button, and copy its CSS selector or id (e.g. <code>#btnSearch</code>).</li>
        </ul>
      </div>
    `);
    return parts.join('');
  }

  tables.forEach((t, i) => {
    const label = t.id
      ? `#${t.id}`
      : t.className
        ? `.${t.className.split(' ').filter(Boolean).join('.')}`
        : `table[${i}]`;
    const frameTag = t.frameUrl && t.frameUrl !== body.url
      ? ` · <span class="muted">in iframe</span>`
      : '';
    parts.push(`<h4>Table ${i + 1} <span class="muted">${escapeHtml(label)} · ${t.rowCount} rows</span>${frameTag}</h4>`);
    parts.push('<div class="table-wrap"><table class="result-table">');
    if (t.headers?.length) {
      parts.push('<thead><tr>');
      for (const h of t.headers) parts.push(`<th>${escapeHtml(h)}</th>`);
      parts.push('</tr></thead>');
    }
    parts.push('<tbody>');
    for (const row of t.rows) {
      parts.push('<tr>');
      for (const cell of row) parts.push(`<td>${escapeHtml(cell)}</td>`);
      parts.push('</tr>');
    }
    parts.push('</tbody></table></div>');
  });

  return parts.join('');
}

// Modal handling
const modal = document.getElementById('modal');
const form = document.getElementById('profile-form');
const formError = document.getElementById('form-error');
const modalTitle = document.getElementById('modal-title');
const fieldsContainer = document.getElementById('data-fields');

document.getElementById('new-profile').addEventListener('click', () => openModal(null));
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('add-field').addEventListener('click', () => addFieldRow());
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

function fieldRowHtml(field = { id: '', label: '' }) {
  return `
    <div class="field-row">
      <input class="field-id" placeholder="HTML id" value="${escapeHtml(field.id)}" />
      <input class="field-label" placeholder="Label" value="${escapeHtml(field.label)}" />
      <button type="button" class="ghost small remove-field" title="Remove">×</button>
    </div>
  `;
}

function addFieldRow(field) {
  fieldsContainer.insertAdjacentHTML('beforeend', fieldRowHtml(field));
}

fieldsContainer.addEventListener('click', (e) => {
  if (e.target.classList.contains('remove-field')) {
    e.target.closest('.field-row').remove();
  }
});

function readDataFields() {
  return [...fieldsContainer.querySelectorAll('.field-row')]
    .map((row) => ({
      id: row.querySelector('.field-id').value.trim(),
      label: row.querySelector('.field-label').value.trim(),
    }))
    .filter((f) => f.id && f.label);
}

function openModal(profile) {
  formError.hidden = true;
  form.reset();
  fieldsContainer.innerHTML = '';

  if (profile) {
    modalTitle.textContent = `Edit profile: ${profile.name}`;
    form.id.value = profile.id;
    form.name.value = profile.name;
    form.kind.value = profile.kind || 'cgaming';
    form.loginUrl.value = profile.loginUrl;
    form.targetUrl.value = profile.targetUrl;
    form.buttonSelector.value = profile.buttonSelector || '';
    form.proxy.value = profile.proxy || '';
    form.notes.value = profile.notes || '';
    (profile.dataFields || []).forEach(addFieldRow);
  } else {
    modalTitle.textContent = 'New profile';
    form.id.value = '';
    form.kind.value = 'cgaming';
  }
  if (!fieldsContainer.children.length) addFieldRow();

  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.hidden = true;

  const data = Object.fromEntries(new FormData(form));
  const id = data.id;
  delete data.id;
  data.dataFields = readDataFields();
  // Drop empty optional strings so they don't override defaults
  for (const k of Object.keys(data)) {
    if (data[k] === '') delete data[k];
  }

  const url = id ? `/api/profiles/${id}` : '/api/profiles';
  const method = id ? 'PATCH' : 'POST';

  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || 'Save failed');
    }
    closeModal();
    loadProfiles();
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
  } finally {
    saveBtn.disabled = false;
  }
});
