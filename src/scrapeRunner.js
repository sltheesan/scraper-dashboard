// Shared scrape pipeline used by both the manual fetch endpoint and the
// background scheduler. Splits "fetch + parse" (read-only) from "save".

import { Scrape } from './models/Scrape.js';
import { runFetch } from './scraper.js';
import { acquireContext } from './contextPool.js';
import { findBankSummaryTable, parseBankSummary } from './parsers/cgaming.js';
import { parseZoomwlb } from './parsers/zoomwlb.js';
import { getPlatformConfig } from './models/ScheduleSetting.js';
import { businessDayDate, yesterdayBusinessDate, DEFAULT_CUTOVER } from './businessDay.js';

/**
 * Acquire the pooled context, run the fetch, parse to the common schema.
 * Returns { result, parsed } — never saves.
 *
 * `result.loggedIn === false` means the profile session expired/missing (or,
 * with `result.accessDenied`, the account was denied access to the report).
 * The business-day boundary (cutover) and the "today not published yet"
 * behavior are read per platform from the settings singleton.
 */
export async function runAndParse(profile, { headless, log, period = 'today' } = {}) {
  const { dayCutover, todayMissing } = await getPlatformConfig(profile.kind);

  const context = await acquireContext(profile, { headless });
  const result = await runFetch(profile, context, { log, period });
  if (!result.loggedIn) return { result, parsed: null };

  // The business day the data is for: the current one, or the previous when
  // "yesterday" is requested. Computed against this platform's cutover so the
  // 00:00→cutover window is attributed to the correct day.
  const now = new Date();
  const targetDate = period === 'yesterday'
    ? yesterdayBusinessDate(now, dayCutover)
    : businessDayDate(now, dayCutover);

  let parsed = null;
  if (profile.kind === 'cgaming') {
    const table = findBankSummaryTable(result.tables);
    if (table) {
      parsed = parseBankSummary(table, {
        targetDate,
        cutover: dayCutover,
        // Only "today" may fall back to the last complete day; "yesterday"
        // must be exact so an archived day is never a stand-in.
        allowFallback: period === 'today' && todayMissing === 'fallback',
      });
    }
  } else if (profile.kind === 'zoomwlb') {
    parsed = parseZoomwlb(result.fields, { targetDate });
  }
  return { result, parsed };
}

// Midnight (ICT) of the previous business day — the reportDate key used to
// store and look up an archived "yesterday". Must match the reportDate that
// runAndParse/​the parsers stamp for period 'yesterday'.
export function yesterdayReportDate(cutover = DEFAULT_CUTOVER) {
  return yesterdayBusinessDate(new Date(), cutover);
}

/**
 * Persist a parsed scrape — one canonical row per (profile, reportDate),
 * upserted so repeated captures of the same day are idempotent.
 *
 * Returns the saved doc, or null if there was nothing to save.
 */
export async function saveScrape(profile, parsed, result) {
  if (!parsed) return null;

  const base = {
    profileId: profile._id,
    kind: profile.kind,
    reportDate: parsed.reportDate,
    reportDateString: parsed.reportDateString,
    data: parsed.data,
    raw: parsed.raw,
    tables: result?.tables || [],
    scrapedAt: new Date(),
  };

  return Scrape.findOneAndUpdate(
    { profileId: profile._id, reportDate: parsed.reportDate },
    { $set: base },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/**
 * Get yesterday's data for a profile, preferring the stored archive.
 * - Archive hit  → returns { cached: true, parsed, result } instantly (no browser).
 * - Archive miss → scrapes live (period 'yesterday'), stores it, returns it.
 *
 * Only meaningful for zoomwlb (cgaming has no yesterday view).
 */
export async function fetchYesterday(profile, { headless, log } = {}) {
  const { dayCutover } = await getPlatformConfig(profile.kind);
  const doc = await Scrape
    .findOne({ profileId: profile._id, reportDate: yesterdayReportDate(dayCutover) })
    .sort({ scrapedAt: -1 });

  if (doc) {
    return {
      cached: true,
      result: { loggedIn: true, url: '(from archive)' },
      parsed: {
        reportDate: doc.reportDate,
        reportDateString: doc.reportDateString,
        data: doc.data,
        raw: doc.raw,
      },
    };
  }

  const { result, parsed } = await runAndParse(profile, { headless, log, period: 'yesterday' });
  if (result.loggedIn && parsed) await saveScrape(profile, parsed, result);
  return { cached: false, result, parsed };
}
