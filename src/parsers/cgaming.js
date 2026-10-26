// Parser for the cgaming "bank-summary" daily report table.
//
// Picks the row whose Report Date belongs to the requested BUSINESS day (the
// day boundary is the configurable cutover, default 11:00 ICT) and pulls out
// the fields the user wants stored.

import { businessDayDate, DEFAULT_CUTOVER } from '../businessDay.js';

function parseNumber(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/,/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// "05/15/2026 11:00:00 - 05/16/2026 10:59:59" -> Date(2026, 4, 15, 11, 0, 0)
function parseStartDate(s) {
  if (typeof s !== 'string') return null;
  const start = s.split(/\s+-\s+/)[0];
  const m = start && start.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh = '0', mi = '0', ss = '0'] = m;
  return new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(mi),
    Number(ss),
  );
}

export function findBankSummaryTable(tables) {
  return tables.find((t) =>
    String(t.className || '').split(/\s+/).includes('bank-summary'),
  );
}

function headerIndex(headers, name) {
  const target = name.toLowerCase().replace(/\s+/g, ' ').trim();
  return headers.findIndex(
    (h) => String(h).toLowerCase().replace(/\s+/g, ' ').trim() === target,
  );
}

/**
 * Parse the bank-summary table and return { reportDate, reportDateString, data,
 * raw, fallback } for the row belonging to `targetDate`'s business day.
 *
 * @param {Date}    opts.targetDate   Midnight-aligned business day to match.
 * @param {string}  opts.cutover      "HH:MM" business-day boundary.
 * @param {boolean} opts.allowFallback When the target row is absent (e.g. the
 *   source hasn't published today's period yet), return the most recent EARLIER
 *   complete day instead, flagged `fallback: true`. Off by default (yesterday
 *   must be exact).
 * Returns null when nothing suitable is found.
 */
export function parseBankSummary(
  table,
  { targetDate, cutover = DEFAULT_CUTOVER, allowFallback = false } = {},
) {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
    return null;
  }
  if (!(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) {
    return null;
  }

  const idx = {
    reportDate: headerIndex(table.headers, 'Report Date'),
    newRegister: headerIndex(table.headers, 'New Register Account / Deposit'),
    totalDeposit: headerIndex(table.headers, 'Total Deposit'),
    totalWithdrawal: headerIndex(table.headers, 'Total Withdrawal'),
    totalTrxDeposit: headerIndex(table.headers, 'Total TRX Deposit'),
    totalTrxWithdrawal: headerIndex(table.headers, 'Total TRX Withdrawal'),
  };

  if (idx.reportDate < 0) return null;

  const targetMs = targetDate.getTime();
  let exact = null;
  let fallbackRow = null; // most recent row strictly before the target day

  for (const row of table.rows) {
    const dateStr = row[idx.reportDate];
    const start = parseStartDate(dateStr);
    if (!start) continue;
    const bday = businessDayDate(start, cutover);
    const bms = bday.getTime();

    if (bms === targetMs) {
      exact = { row, dateStr, bday };
      break;
    }
    if (allowFallback && bms < targetMs) {
      if (!fallbackRow || bms > fallbackRow.bday.getTime()) {
        fallbackRow = { row, dateStr, bday };
      }
    }
  }

  const hit = exact || (allowFallback ? fallbackRow : null);
  if (!hit) return null;

  const { row, dateStr, bday } = hit;
  const newRegRaw = String(row[idx.newRegister] ?? '');
  const [newRegAcct, newRegDep] = newRegRaw.split('/').map((s) => s.trim());

  const raw = Object.fromEntries(
    table.headers.map((h, i) => [h, row[i] ?? null]),
  );

  return {
    reportDate: bday,
    reportDateString: dateStr,
    data: {
      newRegistrationCount: parseNumber(newRegAcct),
      newDepositCount: parseNumber(newRegDep),
      totalDepositCount: parseNumber(row[idx.totalTrxDeposit]),
      totalDepositAmount: parseNumber(row[idx.totalDeposit]),
      totalWithdrawalCount: parseNumber(row[idx.totalTrxWithdrawal]),
      totalWithdrawalAmount: parseNumber(row[idx.totalWithdrawal]),
    },
    raw,
    fallback: !exact,
  };
}
