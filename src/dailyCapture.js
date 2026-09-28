// Daily "yesterday" archive job.
//
// Yesterday's totals are immutable once the platform's business day closes (at
// the configurable cutover, default 11:00 ICT). We capture each profile's
// yesterday once — shortly AFTER that platform's cutover, so the day is frozen
// and complete — and store it. After that, every "Yesterday" request is an
// instant DB read (see fetchYesterday). Today is never archived here; it stays
// live.

import { Profile } from './models/Profile.js';
import { Scrape } from './models/Scrape.js';
import { config } from './config.js';
import { runAndParse, saveScrape, yesterdayReportDate } from './scrapeRunner.js';
import { getPlatformConfig } from './models/ScheduleSetting.js';
import { msUntilCutover } from './businessDay.js';
import { logEvent } from './logBroker.js';
import { sendSessionAlert, sendAccessDeniedAlert } from './telegram.js';

const CAPTURE_OFFSET_MIN = 15; // capture this many minutes after each cutover
const GAP_MS = 1500;           // small pause between profiles to avoid a launch storm
const KINDS = ['zoomwlb', 'cgaming'];

const timers = new Map();  // kind -> timeout
const running = new Set(); // kinds currently capturing
let log = console;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Capture + store one profile's yesterday (zoomwlb or cgaming). */
async function captureProfile(profile) {
  const { result, parsed } = await runAndParse(profile, {
    headless: config.headless,
    log,
    period: 'yesterday',
  });
  if (!result.loggedIn) {
    if (result.accessDenied) {
      const wasDenied = profile.status === 'access_denied';
      profile.status = 'access_denied';
      await profile.save().catch(() => {});
      logEvent({ level: 'warn', source: 'capture', profile: profile.name, message: 'Yesterday capture skipped — access denied' });
      if (!wasDenied) sendAccessDeniedAlert(profile, 'daily capture');
      return 'access_denied';
    }
    const wasOut = profile.status === 'logged_out';
    profile.status = 'logged_out';
    await profile.save().catch(() => {});
    logEvent({ level: 'warn', source: 'capture', profile: profile.name, message: 'Yesterday capture skipped — session expired' });
    if (!wasOut) sendSessionAlert(profile, 'daily capture');
    return 'logged_out';
  }
  if (!parsed) {
    logEvent({ level: 'warn', source: 'capture', profile: profile.name, message: 'Yesterday capture — no data parsed' });
    return 'no_data';
  }
  await saveScrape(profile, parsed, result);
  logEvent({ source: 'capture', profile: profile.name, message: 'Yesterday archived' });
  return 'ok';
}

/**
 * Capture yesterday for every profile of one platform kind.
 * `onlyMissing`: skip profiles that already have yesterday stored (startup
 * catch-up, so restarts don't re-scrape).
 */
async function captureKind(kind, { onlyMissing = false } = {}) {
  if (running.has(kind)) return;
  running.add(kind);
  try {
    const { dayCutover } = await getPlatformConfig(kind);
    const rd = yesterdayReportDate(dayCutover);
    const profiles = await Profile.find({ kind });
    let done = 0;
    for (const profile of profiles) {
      if (onlyMissing) {
        const exists = await Scrape.exists({ profileId: profile._id, reportDate: rd });
        if (exists) continue;
      }
      try {
        await captureProfile(profile);
        done += 1;
      } catch (err) {
        log.error?.({ err, profile: profile.name }, 'yesterday capture failed');
        logEvent({ level: 'error', source: 'capture', profile: profile.name, message: `Capture failed: ${err.message}` });
      }
      await sleep(GAP_MS);
    }
    if (done) logEvent({ source: 'capture', message: `Yesterday archive (${kind}) complete — ${done} profile${done === 1 ? '' : 's'}` });
  } finally {
    running.delete(kind);
  }
}

/** Capture yesterday for all platform kinds (used by the startup catch-up). */
export async function captureYesterdayAll({ onlyMissing = false } = {}) {
  for (const kind of KINDS) {
    await captureKind(kind, { onlyMissing });
  }
}

function clearTimer(kind) {
  const t = timers.get(kind);
  if (t) {
    clearTimeout(t);
    timers.delete(kind);
  }
}

/** (Re)arm one kind's timer for its next cutover + offset. */
async function scheduleKind(kind) {
  clearTimer(kind);
  const { dayCutover } = await getPlatformConfig(kind);
  const delay = msUntilCutover(new Date(), dayCutover, CAPTURE_OFFSET_MIN);
  timers.set(
    kind,
    setTimeout(() => {
      captureKind(kind, { onlyMissing: false })
        .catch((err) => log.error?.({ err, kind }, 'daily yesterday capture failed'))
        .finally(() => { scheduleKind(kind).catch(() => {}); });
    }, delay),
  );
}

/** Re-read cutovers and re-arm every kind's timer (call after a settings change). */
export async function rescheduleDailyCapture() {
  for (const kind of KINDS) {
    await scheduleKind(kind);
  }
}

export function startDailyCapture(logger = console) {
  log = logger;

  // Catch-up shortly after boot: fill any profiles missing yesterday.
  setTimeout(() => {
    captureYesterdayAll({ onlyMissing: true }).catch((err) =>
      logger.error?.({ err }, 'startup yesterday catch-up failed'),
    );
  }, 15000);

  rescheduleDailyCapture().catch((err) =>
    logger.error?.({ err }, 'daily capture scheduling failed'),
  );

  logger.info?.(`Daily yesterday-capture scheduled per platform at cutover + ${CAPTURE_OFFSET_MIN} min ICT`);
}

export function stopDailyCapture() {
  for (const kind of KINDS) clearTimer(kind);
}
