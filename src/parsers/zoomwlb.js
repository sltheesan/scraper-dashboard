// Parser for zoomwlb-style profiles.
//
// The scraper extracts the fixed set of HTML ids in ZOOMWLB_FIELD_IDS and
// returns them keyed by their commonKey (e.g. "newRegistrationCount").
// This parser just shapes that into the storage format.

import { COMMON_FIELDS } from './common.js';

function parseNumber(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[,\s]/g, '').replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Shape the extracted zoomwlb fields into the storage format.
 *
 * @param {Date} opts.targetDate Midnight-aligned business day this snapshot is
 *   for (computed by the caller from the cutover). Used as the reportDate key.
 */
export function parseZoomwlb(fields, { targetDate } = {}) {
  if (!fields || typeof fields !== 'object') return null;
  if (!(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) return null;

  const anyValue = COMMON_FIELDS.some((k) => fields[k] != null);
  if (!anyValue) return null;

  // zoomwlb dashboard divides amount fields by 1000 in the UI.
  // Scale them back up to the true value before storing.
  const SCALED_BY_1000 = new Set(['totalDepositAmount', 'totalWithdrawalAmount']);

  const data = {};
  for (const key of COMMON_FIELDS) {
    const n = parseNumber(fields[key]);
    data[key] = n != null && SCALED_BY_1000.has(key) ? n * 1000 : n;
  }

  return {
    reportDate: targetDate,
    reportDateString: targetDate.toISOString(),
    data,
    raw: { ...fields },
  };
}
