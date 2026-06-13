// Shared scrape pipeline used by both the manual fetch endpoint and the
// background scheduler. Splits "fetch + parse" (read-only) from "save".

import { Scrape } from './models/Scrape.js';
import { runFetch } from './scraper.js';
import { acquireContext } from './contextPool.js';
import { findBankSummaryTable, parseBankSummary } from './parsers/cgaming.js';
import { parseZoomwlb } from './parsers/zoomwlb.js';

/**
 * Acquire the pooled context, run the fetch, parse to the common schema.
 * Returns { result, parsed } — never saves.
 *
 * `result.loggedIn === false` means the profile session expired/missing.
 */
export async function runAndParse(profile, { headless, log, period = 'today' } = {}) {
  const context = await acquireContext(profile, { headless });
  const result = await runFetch(profile, context, { log, period });
  if (!result.loggedIn) return { result, parsed: null };

  // The day the data is for: today, or yesterday when requested. cgaming uses
  // it to pick the matching table row; zoomwlb to stamp the snapshot's date.
  const now = period === 'yesterday' ? startOfYesterday() : new Date();

  let parsed = null;
  if (profile.kind === 'cgaming') {
    const table = findBankSummaryTable(result.tables);
    if (table) parsed = parseBankSummary(table, { now });
  } else if (profile.kind === 'zoomwlb') {
    parsed = parseZoomwlb(result.fields, { now });
  }
  return { result, parsed };
}

// Same wall-clock time, one day earlier (parseZoomwlb floors it to midnight).
function startOfYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

// Midnight (local/ICT) of yesterday — the reportDate key used to store and look
// up an archived day. Matches parseZoomwlb's midnightLocal(startOfYesterday()).
export function yesterdayReportDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
  const doc = await Scrape
    .findOne({ profileId: profile._id, reportDate: yesterdayReportDate() })
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
