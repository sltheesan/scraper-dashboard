// Background scraper scheduler.
//
// Two independent global schedules drive every profile:
//   - fetch:   extract + save to DB
//   - refresh: navigate-only to keep the site session alive
// A shared running-lock per profile prevents fetch and refresh from
// colliding on the same context.

import { config } from './config.js';
import { Profile } from './models/Profile.js';
import { getSettings } from './models/ScheduleSetting.js';
import { runAndParse, saveScrape } from './scrapeRunner.js';
import { runRefresh } from './scraper.js';
import { acquireContext } from './contextPool.js';
import { logEvent } from './logBroker.js';

const fetchTimers = new Map();   // profileId(str) -> timeout
const refreshTimers = new Map(); // profileId(str) -> timeout
const running = new Set();       // profileId(str)s currently busy (either kind)
let settings = {
  fetch: { enabled: false, intervalMs: 300000 },
  refresh: { enabled: false, intervalMs: 300000 },
};
let logger = console;
let started = false;

export async function startScheduler(log = console) {
  logger = log;
  settings = await getSettings();
  started = true;
  await rescheduleAll();
  log.info?.({ settings }, 'scheduler started');
  logEvent({ source: 'scheduler', message: describeSettings('Scheduler started — ', settings) });
}

export function stopScheduler() {
  started = false;
  for (const t of fetchTimers.values()) clearTimeout(t);
  for (const t of refreshTimers.values()) clearTimeout(t);
  fetchTimers.clear();
  refreshTimers.clear();
}

function describeSettings(prefix, s) {
  const parts = [];
  parts.push(`fetch ${s.fetch.enabled ? `every ${Math.round(s.fetch.intervalMs / 60000)} min` : 'off'}`);
  parts.push(`refresh ${s.refresh.enabled ? `every ${Math.round(s.refresh.intervalMs / 60000)} min` : 'off'}`);
  return prefix + parts.join(', ');
}

function clearTimer(map, profileId) {
  const id = String(profileId);
  const t = map.get(id);
  if (t) {
    clearTimeout(t);
    map.delete(id);
  }
}

function scheduleFetch(profile) {
  const id = String(profile._id);
  clearTimer(fetchTimers, id);
  if (!started || !settings.fetch.enabled) return;
  const delay = settings.fetch.intervalMs + Math.floor(Math.random() * 1000);
  fetchTimers.set(id, setTimeout(() => runFetchTick(id), delay));
}

function scheduleRefresh(profile) {
  const id = String(profile._id);
  clearTimer(refreshTimers, id);
  if (!started || !settings.refresh.enabled) return;
  const delay = settings.refresh.intervalMs + Math.floor(Math.random() * 1000);
  refreshTimers.set(id, setTimeout(() => runRefreshTick(id), delay));
}

function scheduleProfile(profile) {
  scheduleFetch(profile);
  scheduleRefresh(profile);
}

async function runFetchTick(profileId) {
  const id = String(profileId);
  fetchTimers.delete(id);

  if (running.has(id)) {
    const profile = await Profile.findById(id).catch(() => null);
    if (profile) scheduleFetch(profile);
    return;
  }
  running.add(id);

  let profileName;
  try {
    const profile = await Profile.findById(id);
    if (!profile || !settings.fetch.enabled) return;
    profileName = profile.name;

    logEvent({ source: 'fetch', profile: profile.name, message: 'Scheduled fetch starting' });

    const { result, parsed } = await runAndParse(profile, {
      headless: config.headless,
      log: logger,
    });

    if (!result.loggedIn) {
      profile.status = 'logged_out';
      await profile.save();
      logger.warn?.({ profile: profile.name }, 'scheduled fetch: session expired');
      logEvent({
        level: 'warn',
        source: 'fetch',
        profile: profile.name,
        message: 'Session expired — Login required',
      });
    } else {
      const saved = await saveScrape(profile, parsed, result);
      profile.status = 'logged_in';
      profile.lastScrapeAt = new Date();
      await profile.save();
      logEvent({
        source: 'fetch',
        profile: profile.name,
        message: saved
          ? 'Scraped + saved'
          : parsed
            ? 'Parsed but not saved'
            : 'No values found',
      });
    }
  } catch (err) {
    logger.error?.({ err, profileId: id }, 'scheduled fetch failed');
    logEvent({
      level: 'error',
      source: 'fetch',
      profile: profileName,
      message: `Fetch error: ${err.message}`,
    });
  } finally {
    running.delete(id);
    const profile = await Profile.findById(id).catch(() => null);
    if (profile) scheduleFetch(profile);
  }
}

async function runRefreshTick(profileId) {
  const id = String(profileId);
  refreshTimers.delete(id);

  if (running.has(id)) {
    const profile = await Profile.findById(id).catch(() => null);
    if (profile) scheduleRefresh(profile);
    return;
  }
  running.add(id);

  let profileName;
  try {
    const profile = await Profile.findById(id);
    if (!profile || !settings.refresh.enabled) return;
    profileName = profile.name;

    logEvent({ source: 'refresh', profile: profile.name, message: 'Refresh tick' });

    const context = await acquireContext(profile, { headless: config.headless });
    const result = await runRefresh(profile, context, { log: logger });

    if (!result.loggedIn) {
      profile.status = 'logged_out';
      await profile.save();
      logEvent({
        level: 'warn',
        source: 'refresh',
        profile: profile.name,
        message: 'Session expired — Login required',
      });
    } else {
      profile.status = 'logged_in';
      profile.lastLoginAt = new Date(); // session is alive
      await profile.save();
      logEvent({ source: 'refresh', profile: profile.name, message: 'Session refreshed' });
    }
  } catch (err) {
    logger.error?.({ err, profileId: id }, 'refresh tick failed');
    logEvent({
      level: 'error',
      source: 'refresh',
      profile: profileName,
      message: `Refresh error: ${err.message}`,
    });
  } finally {
    running.delete(id);
    const profile = await Profile.findById(id).catch(() => null);
    if (profile) scheduleRefresh(profile);
  }
}

export async function rescheduleAll() {
  for (const t of fetchTimers.values()) clearTimeout(t);
  for (const t of refreshTimers.values()) clearTimeout(t);
  fetchTimers.clear();
  refreshTimers.clear();
  if (!started) return;
  const profiles = await Profile.find();
  for (const p of profiles) scheduleProfile(p);
}

export async function reschedule(profileId) {
  const profile = await Profile.findById(profileId).catch(() => null);
  if (!profile) {
    clearTimer(fetchTimers, profileId);
    clearTimer(refreshTimers, profileId);
    return;
  }
  scheduleProfile(profile);
}

export function applySettings(next) {
  settings = { ...settings, ...next };
}

export function getSnapshot() {
  return {
    settings,
    fetchTimers: fetchTimers.size,
    refreshTimers: refreshTimers.size,
    runningCount: running.size,
  };
}
