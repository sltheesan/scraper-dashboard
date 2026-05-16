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
export async function runAndParse(profile, { headless, log } = {}) {
  const context = await acquireContext(profile, { headless });
  const result = await runFetch(profile, context, { log });
  if (!result.loggedIn) return { result, parsed: null };

  let parsed = null;
  if (profile.kind === 'cgaming') {
    const table = findBankSummaryTable(result.tables);
    if (table) parsed = parseBankSummary(table);
  } else if (profile.kind === 'zoomwlb') {
    parsed = parseZoomwlb(result.fields);
  }
  return { result, parsed };
}

/**
 * Persist a parsed scrape.
 * - cgaming: upsert keyed by (profileId, reportDate) — one doc per day, refreshed.
 * - zoomwlb: append a new doc per call (time-series snapshot).
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

  if (profile.kind === 'cgaming') {
    return Scrape.findOneAndUpdate(
      { profileId: profile._id, reportDate: parsed.reportDate },
      { $set: base },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }
  return Scrape.create(base);
}
