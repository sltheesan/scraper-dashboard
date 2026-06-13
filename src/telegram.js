// Telegram bot — long-polling, no external dependency.
//
// Flow: user messages the bot → it replies with the profile list as tappable
// buttons → tapping a profile fetches its data (same pipeline as the dashboard
// "Fetch" button) and edits the message with a formatted summary.
//
// Access is gated by the dashboard-managed allowlist (TelegramSetting). The
// bot token comes from .env (TELEGRAM_BOT_TOKEN); if unset, the bot never runs.

import { config } from './config.js';
import { Profile } from './models/Profile.js';
import { isAllowed, getTelegramSettings } from './models/TelegramSetting.js';
import { runAndParse, fetchYesterday } from './scrapeRunner.js';
import { logEvent } from './logBroker.js';
import { COMMON_FIELDS, COMMON_LABELS } from './parsers/common.js';
import { renderProfileCard, closeRenderer } from './imageRender.js';
import { recordActivity } from './activityLog.js';

// Identify a Telegram user for the audit log: prefer @username, fall back to id.
const tgActor = (chatId, username) => (username ? `@${username}` : String(chatId));

let token = '';
let log = console;
let running = false;
let offset = 0;
let me = null;
let pollController = null;

// Profiles currently being fetched via the bot — prevents a double-tap from
// running two overlapping fetches on the same shared context.
const inFlight = new Set();

function apiUrl(method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

// Generic Bot API call with a hard timeout. Throws on Telegram-level errors.
async function call(method, body, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// sendPhoto needs multipart/form-data (we upload a PNG buffer, not a URL).
async function sendPhoto(chatId, pngBuffer, { caption, reply_markup } = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  if (reply_markup) form.append('reply_markup', JSON.stringify(reply_markup));
  form.append('photo', new Blob([pngBuffer], { type: 'image/png' }), 'card.png');

  const res = await fetch(apiUrl('sendPhoto'), { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'sendPhoto failed');
  return data.result;
}

function fmtNum(v) {
  if (v == null) return '—';
  return typeof v === 'number' ? v.toLocaleString('en-US') : esc(v);
}

// Display timestamps in Indochina Time (GMT+7, no DST), regardless of the
// server's own clock/timezone.
const DISPLAY_TZ = 'Asia/Bangkok';
function fmtICT(date = new Date()) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return `${s} ICT`;
}

// Date-only (no time) in ICT — used to label yesterday's data.
function fmtICTDate(date) {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
  return `${s} ICT`;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---- Rendering ----

async function sendProfileList(chatId, messageId) {
  // Case-insensitive, natural alphabetical order (e.g. ASIA100 before ASIA20),
  // independent of MongoDB's default byte-order collation.
  const profiles = (await Profile.find()).sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }),
  );
  if (!profiles.length) {
    await call('sendMessage', { chat_id: chatId, text: 'No profiles in the system yet.' });
    return;
  }
  const buttons = profiles.map((p) => ({ text: p.name, callback_data: `f:${p._id}` }));
  const reply_markup = { inline_keyboard: chunk(buttons, 2) };
  const text = `📋 <b>Select a profile to fetch</b>  (${profiles.length})`;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', reply_markup };
  if (messageId) {
    await call('editMessageText', { ...payload, message_id: messageId }).catch(() =>
      call('sendMessage', payload),
    );
  } else {
    await call('sendMessage', payload);
  }
}

function formatResult(profile, parsed, when) {
  if (!parsed) {
    return `ℹ️ <b>${esc(profile.name)}</b>\nLogged in, but no data could be parsed from the page.`;
  }
  const lines = COMMON_FIELDS.map(
    (k) => `• ${COMMON_LABELS[k]}: <b>${fmtNum(parsed.data?.[k])}</b>`,
  );
  const header = `📊 <b>${esc(profile.name)}</b> <i>(${esc(profile.kind)})</i>\n🕒 ${esc(when)}`;
  return `${header}\n\n${lines.join('\n')}`;
}

function resultKeyboard(profile) {
  // Both kinds support today/yesterday (zoomwlb via yesterday* elements,
  // cgaming via the prior day's table row).
  return {
    inline_keyboard: [
      [
        { text: '🔄 Today', callback_data: `f:${profile._id}` },
        { text: '📅 Yesterday', callback_data: `y:${profile._id}` },
      ],
      [{ text: '‹ Back to list', callback_data: 'list' }],
    ],
  };
}

// Replace the status message with the final text (or send fresh if it's gone).
async function finishText(chatId, messageId, text, reply_markup) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', reply_markup };
  if (messageId) {
    await call('editMessageText', { ...payload, message_id: messageId }).catch(() => call('sendMessage', payload));
  } else {
    await call('sendMessage', payload);
  }
}

// ---- Fetch on tap ----

async function doFetch(chatId, profileId, period = 'today', username) {
  const profile = await Profile.findById(profileId).catch(() => null);
  if (!profile) {
    await call('sendMessage', { chat_id: chatId, text: 'Profile not found.' });
    return;
  }

  const key = String(profile._id);
  if (inFlight.has(key)) {
    await call('sendMessage', { chat_id: chatId, text: `⏳ ${esc(profile.name)} is already being fetched…` });
    return;
  }
  inFlight.add(key);

  // Audit: a Telegram user fetched this profile.
  recordActivity({ actorType: 'telegram', actor: tgActor(chatId, username), action: 'fetch', target: profile.name, details: period });

  const periodLabel = period === 'yesterday' ? "yesterday's" : "today's";

  // Fresh status message — independent of whatever message triggered the tap
  // (the previous result may be a photo, which can't be edited into text).
  let statusId = null;
  try {
    const m = await call('sendMessage', {
      chat_id: chatId,
      text: `⏳ Fetching ${periodLabel} data for <b>${esc(profile.name)}</b>…`,
      parse_mode: 'HTML',
    });
    statusId = m.message_id;
  } catch { /* ignore */ }

  logEvent({ source: 'telegram', profile: profile.name, message: `Telegram fetch started (${period})` });
  const kb = resultKeyboard(profile);

  try {
    // Yesterday comes from the archive (instant) with live fallback; today is live.
    const { result, parsed, cached } = period === 'yesterday'
      ? await fetchYesterday(profile, { headless: config.headless, log })
      : { ...(await runAndParse(profile, { headless: config.headless, log, period })), cached: false };

    if (!result.loggedIn) {
      const wasOut = profile.status === 'logged_out';
      profile.status = 'logged_out';
      await profile.save();
      logEvent({ level: 'warn', source: 'telegram', profile: profile.name, message: 'Telegram fetch: session expired' });
      if (!wasOut) sendSessionAlert(profile, 'Telegram fetch');
      await finishText(chatId, statusId,
        `⚠️ <b>${esc(profile.name)}</b>\nSession expired — open the dashboard and click <b>Login</b>.`, kb);
      return;
    }

    if (!cached) {
      profile.status = 'logged_in';
      await profile.save();
    }

    // Timestamp/label shown in the message, in Indochina Time (GMT+7).
    // Today → real-time fetch moment; Yesterday → the data's date.
    let when;
    if (period === 'yesterday') {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      when = `Yesterday · ${fmtICTDate(y)}`;
    } else {
      when = fmtICT();
    }

    // Reply format is configurable in the dashboard: image card, text
    // summary, or both. (At least one is always enabled — guarded server-side.)
    if (parsed) {
      const { sendImage, sendText } = await getTelegramSettings();
      const text = formatResult(profile, parsed, when);

      let png = null;
      if (sendImage) {
        png = await renderProfileCard(profile, parsed, when);
      }

      if (png) {
        // Image wanted and rendered. Include the text as caption only if the
        // user also wants text; otherwise send the bare card.
        await sendPhoto(chatId, png, { caption: sendText ? text : undefined, reply_markup: kb });
        if (statusId) await call('deleteMessage', { chat_id: chatId, message_id: statusId }).catch(() => {});
        logEvent({ source: 'telegram', profile: profile.name, message: `Telegram fetch: ${sendText ? 'image + text' : 'image'} sent` });
        return;
      }

      // Text-only mode, or image was requested but rendering failed → text.
      await finishText(chatId, statusId, text, kb);
      logEvent({
        source: 'telegram',
        profile: profile.name,
        message: sendImage ? 'Telegram fetch: image failed, sent text' : 'Telegram fetch: text sent',
      });
      return;
    }

    await finishText(chatId, statusId, formatResult(profile, null, when), kb);
    logEvent({ source: 'telegram', profile: profile.name, message: 'Telegram fetch: no values' });
  } catch (err) {
    log.error?.({ err }, 'telegram fetch failed');
    profile.status = 'error';
    await profile.save().catch(() => {});
    logEvent({ level: 'error', source: 'telegram', profile: profile.name, message: `Telegram fetch failed: ${err.message}` });
    await finishText(chatId, statusId, `❌ <b>${esc(profile.name)}</b>\nFetch failed: ${esc(err.message)}`, kb);
  } finally {
    inFlight.delete(key);
  }
}

// ---- Update handling ----

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  if (chatId == null) return;
  const username = msg.from?.username;

  if (!(await isAllowed({ chatId, username }))) {
    recordActivity({ actorType: 'telegram', actor: tgActor(chatId, username), action: 'access_denied', details: msg.text ? `msg: ${msg.text.slice(0, 40)}` : '' });
    const handleLine = username ? `\nYour username: <code>@${esc(username)}</code>` : '';
    await call('sendMessage', {
      chat_id: chatId,
      text:
        `⛔ You are not authorized to use this bot.\n\n` +
        `Your chat ID is: <code>${chatId}</code>${handleLine}\n` +
        `Ask the admin to add it in the dashboard → <b>Telegram</b>.`,
      parse_mode: 'HTML',
    });
    return;
  }
  // Any message (incl. /start) shows the profile list.
  await sendProfileList(chatId);
}

async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const data = cq.data || '';

  if (!(await isAllowed({ chatId, username: cq.from?.username }))) {
    await call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not authorized', show_alert: true });
    return;
  }

  if (data === 'list') {
    await call('answerCallbackQuery', { callback_query_id: cq.id });
    await sendProfileList(chatId, messageId);
    return;
  }

  if (data.startsWith('f:')) {
    await call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Fetching…' }).catch(() => {});
    await doFetch(chatId, data.slice(2), 'today', cq.from?.username);
    return;
  }

  if (data.startsWith('y:')) {
    await call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Fetching yesterday…' }).catch(() => {});
    await doFetch(chatId, data.slice(2), 'yesterday', cq.from?.username);
    return;
  }

  await call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
}

async function handleUpdate(u) {
  if (u.message) return handleMessage(u.message);
  if (u.callback_query) return handleCallback(u.callback_query);
}

// ---- Long-poll loop ----

async function poll() {
  while (running) {
    let updates = [];
    const ctrl = new AbortController();
    pollController = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 40000);
    try {
      const res = await fetch(apiUrl('getUpdates'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (data.ok) updates = data.result;
      else log.warn?.(`telegram getUpdates: ${data.description}`);
    } catch (err) {
      clearTimeout(timer);
      if (!running) break;
      if (err.name !== 'AbortError') {
        log.warn?.(`telegram getUpdates failed: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      handleUpdate(u).catch((e) => log.error?.({ err: e }, 'telegram update handler error'));
    }
  }
}

// ---- Lifecycle ----

export async function startTelegramBot(logger = console) {
  if (!config.telegramToken) {
    logger.info?.('Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
    return false;
  }
  token = config.telegramToken;
  log = logger;

  try {
    me = await call('getMe');
  } catch (err) {
    logger.error?.(`Telegram bot not started — getMe failed: ${err.message}`);
    return false;
  }

  // Skip any backlog so a restart doesn't replay old taps.
  try {
    const backlog = await call('getUpdates', { offset: -1, timeout: 0 });
    if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;
  } catch { /* ignore */ }

  running = true;
  poll();
  logger.info?.(`Telegram bot started as @${me.username}`);
  logEvent({ source: 'telegram', message: `Bot online as @${me.username}` });
  return true;
}

export function stopTelegramBot() {
  running = false;
  if (pollController) {
    try { pollController.abort(); } catch { /* ignore */ }
  }
  closeRenderer().catch(() => {});
}

export function getBotInfo() {
  return me ? { username: me.username, id: me.id } : null;
}

/**
 * Send a one-off test message to every configured alert chat. Returns a result
 * with per-recipient outcomes so the dashboard can show success/failure.
 */
export async function sendTestAlert() {
  if (!token) return { ok: false, error: 'Bot is not running (no TELEGRAM_BOT_TOKEN).' };
  const { alertChatIds } = await getTelegramSettings();
  if (!alertChatIds.length) return { ok: false, error: 'No alert chat IDs are set.' };

  const text = `✅ <b>Test alert</b>\nSession-expired alerts are working.\n🕒 ${esc(fmtICT())}`;
  const results = await Promise.all(
    alertChatIds.map(async (chatId) => {
      try {
        await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
        return { chatId, ok: true };
      } catch (err) {
        return { chatId, ok: false, error: err.message };
      }
    }),
  );
  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
  return { ok: sent > 0, sent, failed, results };
}

/**
 * Send a "session expired" alert for a profile to every configured alert chat.
 * Fire-and-forget and fully guarded — safe to call from anywhere; no-op if the
 * bot isn't running or no alert chats are set. Per-recipient failures are
 * swallowed so one bad chat ID doesn't block the others.
 */
export async function sendSessionAlert(profile, source = '') {
  try {
    if (!token) return; // bot not running
    const { alertChatIds } = await getTelegramSettings();
    if (!alertChatIds.length) return;

    const text =
      `🚨 <b>Session expired</b>\n` +
      `Profile: <b>${esc(profile.name)}</b>\n` +
      `🕒 ${esc(fmtICT())}` +
      (source ? `\nDetected by: ${esc(source)}` : '') +
      `\n\nOpen the dashboard and click <b>Login</b> to re-authenticate.`;

    const results = await Promise.all(
      alertChatIds.map((chatId) =>
        call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' })
          .then(() => ({ chatId, ok: true }))
          .catch((err) => ({ chatId, ok: false, error: err.message })),
      ),
    );
    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    logEvent({
      level: failed ? 'warn' : 'warn',
      source: 'alert',
      profile: profile.name,
      message: `Session-expired alert sent to ${sent}/${results.length}${failed ? ` (failed: ${results.filter((r) => !r.ok).map((r) => r.chatId).join(', ')})` : ''} · ${source}`,
    });
  } catch (err) {
    log.warn?.(`session alert failed: ${err.message}`);
  }
}
