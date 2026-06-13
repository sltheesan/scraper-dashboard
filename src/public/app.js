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

// All dashboard timestamps are shown in Indochina Time (GMT+7).
const DISPLAY_TZ = 'Asia/Bangkok';

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false, timeZone: DISPLAY_TZ });
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

// ---- Backup & Restore (inside Settings modal) ----
const backupStatus = document.getElementById('backup-status');
const backupFile = document.getElementById('backup-file');

document.getElementById('backup-download').addEventListener('click', downloadBackup);
document.getElementById('backup-restore').addEventListener('click', restoreBackup);

async function downloadBackup() {
  backupStatus.textContent = 'Building backup…';
  try {
    const res = await fetch('/api/backup');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const dispo = res.headers.get('Content-Disposition') || '';
    const m = dispo.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : `scraper-backup-${Date.now()}.json`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    backupStatus.textContent = `Downloaded ${filename} (${(blob.size / 1024).toFixed(1)} KB).`;
  } catch (err) {
    backupStatus.textContent = `Download failed: ${err.message}`;
  }
}

async function restoreBackup() {
  const file = backupFile.files[0];
  if (!file) { backupStatus.textContent = 'Choose a backup file first.'; return; }
  const ok = window.confirm(
    `Restore from "${file.name}"?\n\n` +
    `This will REPLACE every collection — profiles, scrapes, settings, ` +
    `activity log — with the contents of the backup.\n\n` +
    `Continue?`,
  );
  if (!ok) return;

  backupStatus.textContent = 'Restoring…';
  try {
    const text = await file.text();
    const res = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
    const total = Object.values(body.summary || {}).reduce((a, b) => a + b, 0);
    const lines = Object.entries(body.summary || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
    backupStatus.textContent = `Restored ${total} docs — ${lines}`;
    backupFile.value = '';
    // Refresh the in-memory profile table so it matches the restored DB.
    loadProfiles();
  } catch (err) {
    backupStatus.textContent = `Restore failed: ${err.message}`;
  }
}

// ---- Telegram bot settings ----
const telegramModal = document.getElementById('telegram-modal');
const telegramStatus = document.getElementById('telegram-status');
const telegramRestricted = document.getElementById('telegram-restricted');
const telegramSendImage = document.getElementById('telegram-sendimage');
const telegramSendText = document.getElementById('telegram-sendtext');
const telegramAllow = document.getElementById('telegram-allow');
const telegramNewEntry = document.getElementById('telegram-newentry');
const telegramAlerts = document.getElementById('telegram-alerts');
const telegramNewAlert = document.getElementById('telegram-newalert');
const telegramError = document.getElementById('telegram-error');

document.getElementById('open-telegram').addEventListener('click', openTelegram);
document.getElementById('telegram-close').addEventListener('click', () => { telegramModal.hidden = true; });
telegramModal.addEventListener('click', (e) => { if (e.target === telegramModal) telegramModal.hidden = true; });
document.getElementById('telegram-addentry').addEventListener('click', addEntry);
telegramNewEntry.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } });
document.getElementById('telegram-addalert').addEventListener('click', addAlertChat);
document.getElementById('telegram-testalert').addEventListener('click', sendTestAlertNow);
telegramNewAlert.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAlertChat(); } });

function flashButton(id, label) {
  const btn = document.getElementById(id);
  const prev = btn.dataset.label || btn.textContent;
  btn.dataset.label = prev;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = btn.dataset.label; }, 1800);
}

function renderAlertChats(ids) {
  if (!ids.length) {
    telegramAlerts.innerHTML = '<p class="muted" style="margin:0 0 8px;">No alert recipients yet.</p>';
    return;
  }
  telegramAlerts.innerHTML = ids.map((id) => `
    <div class="field-row" style="grid-template-columns: 1fr auto;">
      <code>${escapeHtml(id)}</code>
      <button type="button" class="ghost small danger remove-alertchat" data-id="${escapeHtml(id)}">Remove</button>
    </div>
  `).join('');
}

telegramAlerts.addEventListener('click', async (e) => {
  const btn = e.target.closest('.remove-alertchat');
  if (!btn) return;
  telegramError.hidden = true;
  try {
    const res = await fetch(`/api/settings/telegram/alert-chats/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to remove');
    const { settings } = await res.json();
    renderAlertChats(settings.alertChatIds);
  } catch (err) {
    telegramError.textContent = err.message;
    telegramError.hidden = false;
  }
});

async function addAlertChat() {
  const value = telegramNewAlert.value.trim();
  telegramError.hidden = true;
  if (!/^-?\d+$/.test(value)) {
    telegramError.textContent = 'Alert chat ID must be a number (e.g. 123456789).';
    telegramError.hidden = false;
    return;
  }
  try {
    const res = await fetch('/api/settings/telegram/alert-chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || 'Failed to add');
    }
    const { settings } = await res.json();
    renderAlertChats(settings.alertChatIds);
    telegramNewAlert.value = '';
  } catch (err) {
    telegramError.textContent = err.message;
    telegramError.hidden = false;
  }
}

// Send a test message to every configured alert chat; show per-recipient summary.
async function sendTestAlertNow() {
  telegramError.hidden = true;
  try {
    const res = await fetch('/api/settings/telegram/test-alert', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || body.error || 'Test failed');
    const failures = (body.results || []).filter((r) => !r.ok);
    if (failures.length) {
      const note = failures.map((f) => `${f.chatId}: ${f.error}`).join('; ');
      telegramError.textContent = `Sent to ${body.sent}/${body.sent + body.failed}. Failures — ${note}`;
      telegramError.hidden = false;
    }
    flashButton('telegram-testalert', `Sent ${body.sent}/${body.sent + body.failed} ✓`);
  } catch (err) {
    telegramError.textContent = `Test alert failed: ${err.message}`;
    telegramError.hidden = false;
  }
}

// Render chat IDs and usernames as one combined list, each tagged with its type.
function renderAccess(settings) {
  const ids = settings.allowedChatIds || [];
  const names = settings.allowedUsernames || [];
  if (!ids.length && !names.length) {
    telegramAllow.innerHTML = '<p class="muted" style="margin:0 0 8px;">No allowed users yet.</p>';
    return;
  }
  const item = (label, type, value) => `
    <div class="field-row" style="grid-template-columns: 1fr auto;">
      <code>${escapeHtml(label)}</code>
      <button type="button" class="ghost small danger remove-access" data-type="${type}" data-value="${escapeHtml(value)}">Remove</button>
    </div>`;
  telegramAllow.innerHTML = [
    ...ids.map((id) => item(id, 'id', id)),
    ...names.map((u) => item('@' + u, 'username', u)),
  ].join('');
}

telegramAllow.addEventListener('click', async (e) => {
  const btn = e.target.closest('.remove-access');
  if (!btn) return;
  telegramError.hidden = true;
  const path = btn.dataset.type === 'username'
    ? `/api/settings/telegram/usernames/${encodeURIComponent(btn.dataset.value)}`
    : `/api/settings/telegram/chat-ids/${encodeURIComponent(btn.dataset.value)}`;
  try {
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to remove');
    const { settings } = await res.json();
    renderAccess(settings);
  } catch (err) {
    telegramError.textContent = err.message;
    telegramError.hidden = false;
  }
});

async function openTelegram() {
  telegramError.hidden = true;
  telegramAllow.innerHTML = '';
  telegramAlerts.innerHTML = '';
  telegramNewEntry.value = '';
  telegramNewAlert.value = '';
  telegramModal.hidden = false;
  try {
    const res = await fetch('/api/settings/telegram');
    if (!res.ok) throw new Error('Failed to load Telegram settings');
    const { settings, tokenConfigured, bot } = await res.json();
    telegramRestricted.checked = settings.restricted;
    telegramSendImage.checked = settings.sendImage;
    telegramSendText.checked = settings.sendText;
    renderAlertChats(settings.alertChatIds || []);
    renderAccess(settings);
    telegramStatus.textContent = !tokenConfigured
      ? '⚠️ No bot token set. Add TELEGRAM_BOT_TOKEN to .env and restart.'
      : bot
        ? `✅ Bot online as @${bot.username}`
        : '⚠️ Token set but bot is not running — check the server logs.';
  } catch (err) {
    telegramError.textContent = err.message;
    telegramError.hidden = false;
  }
}

// PATCH a single boolean flag; revert the checkbox and show the error if the
// server rejects it (e.g. trying to turn off both image and text).
async function patchTelegramFlag(field, checkboxEl) {
  telegramError.hidden = true;
  try {
    const res = await fetch('/api/settings/telegram', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: checkboxEl.checked }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.error || 'Failed to update');
    }
  } catch (err) {
    checkboxEl.checked = !checkboxEl.checked; // revert
    telegramError.textContent = err.message;
    telegramError.hidden = false;
  }
}

telegramRestricted.addEventListener('change', () => patchTelegramFlag('restricted', telegramRestricted));
telegramSendImage.addEventListener('change', () => patchTelegramFlag('sendImage', telegramSendImage));
telegramSendText.addEventListener('change', () => patchTelegramFlag('sendText', telegramSendText));

// Detect whether the entry is a numeric chat ID or an @username, and POST it
// to the matching endpoint.
async function addEntry() {
  const raw = telegramNewEntry.value.trim();
  telegramError.hidden = true;
  if (!raw) return;

  const isId = /^-?\d+$/.test(raw);
  const isUsername = /^@?[A-Za-z0-9_]{1,32}$/.test(raw);
  if (!isId && !isUsername) {
    telegramError.textContent = 'Enter a numeric chat ID (e.g. 123456789) or an @username.';
    telegramError.hidden = false;
    return;
  }

  const [path, body] = isId
    ? ['/api/settings/telegram/chat-ids', { chatId: raw }]
    : ['/api/settings/telegram/usernames', { username: raw }];

  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.message || errBody.error || 'Failed to add');
    }
    const { settings } = await res.json();
    renderAccess(settings);
    telegramNewEntry.value = '';
  } catch (err) {
    telegramError.textContent = err.message;
    telegramError.hidden = false;
  }
}

// ---- Activity Log (persistent audit trail) ----
const activityModal = document.getElementById('activity-modal');
const activityBody = document.getElementById('activity-body');
const activityFilter = document.getElementById('activity-filter');
const activityInfo = document.getElementById('activity-info');
const activityPrev = document.getElementById('activity-prev');
const activityNext = document.getElementById('activity-next');
const activityState = { page: 1, pageSize: 25, total: 0, actorType: '' };

document.getElementById('open-activity').addEventListener('click', () => { activityState.page = 1; openActivity(); });
document.getElementById('activity-close').addEventListener('click', () => { activityModal.hidden = true; });
activityModal.addEventListener('click', (e) => { if (e.target === activityModal) activityModal.hidden = true; });
activityFilter.addEventListener('change', () => { activityState.actorType = activityFilter.value; activityState.page = 1; loadActivity(); });
activityPrev.addEventListener('click', () => { if (activityState.page > 1) { activityState.page -= 1; loadActivity(); } });
activityNext.addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(activityState.total / activityState.pageSize));
  if (activityState.page < pages) { activityState.page += 1; loadActivity(); }
});

function openActivity() {
  activityModal.hidden = false;
  loadActivity();
}

async function loadActivity() {
  activityBody.innerHTML = '<tr><td colspan="5" class="muted" style="padding:16px;">Loading…</td></tr>';
  const params = new URLSearchParams({ page: activityState.page, pageSize: activityState.pageSize });
  if (activityState.actorType) params.set('actorType', activityState.actorType);
  try {
    const res = await fetch(`/api/activity?${params}`);
    if (!res.ok) throw new Error('Failed to load activity');
    const { items, total, page, pageSize } = await res.json();
    activityState.total = total;
    activityState.page = page;
    activityState.pageSize = pageSize;
    renderActivity(items);
    const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = (page - 1) * pageSize + items.length;
    activityInfo.textContent = `${from}–${to} of ${total}`;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    activityPrev.disabled = page <= 1;
    activityNext.disabled = page >= pages;
  } catch (err) {
    activityBody.innerHTML = `<tr><td colspan="5" class="muted" style="padding:16px;">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderActivity(items) {
  if (!items.length) {
    activityBody.innerHTML = '<tr><td colspan="5" class="muted" style="padding:16px;">No activity yet.</td></tr>';
    return;
  }
  activityBody.innerHTML = items.map((a) => {
    const when = new Date(a.createdAt).toLocaleString('en-GB', { timeZone: DISPLAY_TZ });
    const who = `${a.actorType === 'telegram' ? '📱' : '🖥️'} ${escapeHtml(a.actor || a.actorType)}`;
    return `<tr>
      <td class="muted" style="white-space:nowrap;">${escapeHtml(when)}</td>
      <td style="white-space:nowrap;">${who}</td>
      <td><code>${escapeHtml(a.action)}</code></td>
      <td>${escapeHtml(a.target || '')}</td>
      <td class="muted">${escapeHtml(a.details || '')}</td>
    </tr>`;
  }).join('');
}

const tbody = document.getElementById('profiles-body');
const table = document.getElementById('profiles-table');
const empty = document.getElementById('empty');

// ---- Datatable: search / filter / pagination (client-side) ----
const toolbar = document.getElementById('profiles-toolbar');
const profileSearch = document.getElementById('profile-search');
const filterKind = document.getElementById('filter-kind');
const filterStatus = document.getElementById('filter-status');
const pageSizeEl = document.getElementById('page-size');
const pagination = document.getElementById('pagination');
const pageInfo = document.getElementById('page-info');
const pagePrev = document.getElementById('page-prev');
const pageNext = document.getElementById('page-next');
const pageNumbers = document.getElementById('page-numbers');

let allProfiles = [];
const view = { search: '', kind: '', status: '', pageSize: 10, page: 1 };

async function loadProfiles() {
  const res = await fetch('/api/profiles');
  const list = res.ok ? await res.json() : [];
  // Case-insensitive, natural alphabetical order (matches the Telegram bot).
  list.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }));
  allProfiles = list;
  applyView();
}

function getFiltered() {
  const q = view.search.trim().toLowerCase();
  return allProfiles.filter((p) => {
    if (view.kind && p.kind !== view.kind) return false;
    if (view.status && p.status !== view.status) return false;
    if (q) {
      const hay = `${p.name} ${p.targetUrl} ${p.loginUrl || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Filter → paginate → render the current page, then refresh the pager.
function applyView() {
  // No profiles at all: show the empty card, hide table + controls.
  if (!allProfiles.length) {
    toolbar.hidden = true;
    table.hidden = true;
    pagination.hidden = true;
    empty.hidden = false;
    tbody.innerHTML = '';
    return;
  }
  toolbar.hidden = false;
  empty.hidden = true;
  table.hidden = false;

  const filtered = getFiltered();
  const total = filtered.length;
  const size = view.pageSize > 0 ? view.pageSize : (total || 1);
  const pages = Math.max(1, Math.ceil(total / size));
  view.page = Math.min(Math.max(view.page, 1), pages);

  const start = (view.page - 1) * size;
  const pageItems = filtered.slice(start, start + size);

  tbody.innerHTML = pageItems.length
    ? pageItems.map(rowHtml).join('')
    : '<tr><td colspan="6" class="no-results muted">No profiles match your filters.</td></tr>';

  renderPagination(total, pages, start, pageItems.length);
}

function renderPagination(total, pages, start, count) {
  pagination.hidden = false;
  const from = total === 0 ? 0 : start + 1;
  pageInfo.textContent = `${from}–${start + count} of ${total}`;
  pagePrev.disabled = view.page <= 1;
  pageNext.disabled = view.page >= pages;
  pageNumbers.innerHTML = buildPageButtons(pages);
}

// Windowed page buttons: always show first, last, current and its neighbours,
// collapsing the rest into "…".
function buildPageButtons(pages) {
  if (pages <= 1) return '';
  const cur = view.page;
  const wanted = [1, pages, cur, cur - 1, cur + 1]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
  const unique = [...new Set(wanted)];

  let html = '';
  let prev = 0;
  for (const n of unique) {
    if (n - prev > 1) html += '<span class="page-gap">…</span>';
    html += `<button class="page-btn${n === cur ? ' active' : ''}" data-page="${n}">${n}</button>`;
    prev = n;
  }
  return html;
}

profileSearch.addEventListener('input', () => {
  view.search = profileSearch.value;
  view.page = 1;
  applyView();
});
filterKind.addEventListener('change', () => {
  view.kind = filterKind.value;
  view.page = 1;
  applyView();
});
filterStatus.addEventListener('change', () => {
  view.status = filterStatus.value;
  view.page = 1;
  applyView();
});
pageSizeEl.addEventListener('change', () => {
  view.pageSize = Number(pageSizeEl.value);
  view.page = 1;
  applyView();
});
pagePrev.addEventListener('click', () => { view.page -= 1; applyView(); });
pageNext.addEventListener('click', () => { view.page += 1; applyView(); });
pageNumbers.addEventListener('click', (e) => {
  const btn = e.target.closest('.page-btn');
  if (btn) { view.page = Number(btn.dataset.page); applyView(); }
});

function rowHtml(p) {
  const lastScrape = p.lastScrapeAt
    ? new Date(p.lastScrapeAt).toLocaleString('en-GB', { timeZone: DISPLAY_TZ })
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
        <button class="fetch-yest-btn ghost">Yesterday</button>
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
    runFetch(id, name, e.target, 'today');
  } else if (e.target.classList.contains('fetch-yest-btn')) {
    const name = row.querySelector('strong').textContent;
    runFetch(id, name, e.target, 'yesterday');
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

async function runFetch(id, name, button, period = 'today') {
  const periodSuffix = period === 'yesterday' ? ' (Yesterday)' : '';
  fetchModalTitle.textContent = `Fetch result: ${name}${periodSuffix}`;
  fetchModalBody.innerHTML = '<p class="muted">Running fetch — this can take 10–30 seconds…</p>';
  fetchModal.hidden = false;

  const prevText = button.textContent;
  button.disabled = true;
  button.textContent = 'Fetching…';

  try {
    const res = await fetch(`/api/profiles/${id}/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period }),
    });
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

function renderParsedPanel(parsed, cached = false) {
  const reportDate = new Date(parsed.reportDate).toLocaleDateString('en-GB', { timeZone: DISPLAY_TZ });
  const rows = buildParsedRows(parsed)
    .map(({ label, value }) => `
      <tr>
        <th>${escapeHtml(label)}</th>
        <td>${escapeHtml(value)}</td>
      </tr>
    `)
    .join('');

  const subTitle = cached
    ? reportDate
    : parsed.kind === 'cgaming'
      ? (parsed.reportDateString || reportDate)
      : new Date().toLocaleString('en-GB', { timeZone: DISPLAY_TZ });

  const badge = cached
    ? '<span class="badge badge-ok">from archive</span>'
    : '<span class="badge">manual fetch · not saved</span>';

  return `
    <div class="parsed-panel">
      <div class="parsed-head">
        <h4>${cached ? 'Yesterday' : 'Preview'} ${badge}</h4>
        <span class="muted">${escapeHtml(subTitle)}</span>
      </div>
      <table class="kv"><tbody>${rows}</tbody></table>
    </div>
  `;
}

function renderFetchResult(body) {
  // Cached yesterday: just the metrics card from the archive — no live page,
  // so skip the tables/diagnostics sections.
  if (body.cached && body.parsed) {
    return renderParsedPanel(body.parsed, true);
  }

  const parts = [];

  if (body.parsed) {
    parts.push(renderParsedPanel(body.parsed));
  } else if (body.kind === 'cgaming' && body.tables?.length) {
    parts.push(`
      <div class="alert alert-warn">
        <strong>No row matched today's date.</strong>
        <p>The bank-summary table was found, but no row's start date matches today
        (${new Date().toLocaleDateString('en-GB', { timeZone: DISPLAY_TZ })}). Maybe the new period hasn't started yet,
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
