// Daily "yesterday" archive job.
//
// Yesterday's totals are immutable, and the source dashboard only ever exposes
// a single prior day — so we capture each zoomwlb profile's yesterday once per
// day and store it. After that, every "Yesterday" request is an instant DB read
// (see fetchYesterday). Today is never archived here; it stays live.

import { Profile } from './models/Profile.js';
import { Scrape } from './models/Scrape.js';
import { config } from './config.js';
import { runAndParse, saveScrape, yesterdayReportDate } from './scrapeRunner.js';
import { logEvent } from './logBroker.js';
import { sendSessionAlert } from './telegram.js';

const CAPTURE_HOUR = 0;   // 00:15 local (ICT) — just after midnight, day is complete
const CAPTURE_MIN = 15;
const GAP_MS = 1500;      // small pause between profiles to avoid a launch storm

let timer = null;
let running = false;
let log = console;

function msUntilNext(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Capture + store one profile's yesterday (zoomwlb or cgaming). */
async function captureProfile(profile) {
  const { result, parsed } = await runAndParse(profile, {
    headless: config.headless,
    log,
    period: 'yesterday',
  });
  if (!result.loggedIn) {
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
 * Capture yesterday for all zoomwlb profiles.
 * `onlyMissing`: skip profiles that already have yesterday stored (used for the
 * startup catch-up, so restarts don't re-scrape).
 */
export async function captureYesterdayAll({ onlyMissing = false } = {}) {
  if (running) return;
  running = true;
  const rd = yesterdayReportDate();
  try {
    // Both kinds expose yesterday: zoomwlb via yesterday* elements, cgaming via
    // the prior day's bank-summary row.
    const profiles = await Profile.find({ kind: { $in: ['zoomwlb', 'cgaming'] } });
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
    if (done) logEvent({ source: 'capture', message: `Yesterday archive run complete (${done} profile${done === 1 ? '' : 's'})` });
  } finally {
    running = false;
  }
}

export function startDailyCapture(logger = console) {
  log = logger;

  // Catch-up shortly after boot: fill any zoomwlb profiles missing yesterday.
  setTimeout(() => {
    captureYesterdayAll({ onlyMissing: true }).catch((err) =>
      logger.error?.({ err }, 'startup yesterday catch-up failed'),
    );
  }, 15000);

  const schedule = () => {
    timer = setTimeout(async () => {
      await captureYesterdayAll({ onlyMissing: false }).catch((err) =>
        logger.error?.({ err }, 'daily yesterday capture failed'),
      );
      schedule();
    }, msUntilNext(CAPTURE_HOUR, CAPTURE_MIN));
  };
  schedule();

  logger.info?.(`Daily yesterday-capture scheduled for ${String(CAPTURE_HOUR).padStart(2, '0')}:${String(CAPTURE_MIN).padStart(2, '0')} ICT`);
}

export function stopDailyCapture() {
  if (timer) clearTimeout(timer);
  timer = null;
}
