// Parser for the cgaming "bank-summary" daily report table.
//
// Picks the row whose Report Date STARTS today (in local time) and pulls out
// the fields the user wants stored.

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

function localDayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function midnightLocal(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
 * Parse the bank-summary table and return { reportDate, reportDateString, data, raw }
 * for the row whose start date is today, or null if no such row exists.
 */
export function parseBankSummary(table, { now = new Date() } = {}) {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) {
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

  const todayKey = localDayKey(now);

  for (const row of table.rows) {
    const dateStr = row[idx.reportDate];
    const start = parseStartDate(dateStr);
    if (!start) continue;
    if (localDayKey(start) !== todayKey) continue;

    const newRegRaw = String(row[idx.newRegister] ?? '');
    const [newRegAcct, newRegDep] = newRegRaw.split('/').map((s) => s.trim());

    const raw = Object.fromEntries(
      table.headers.map((h, i) => [h, row[i] ?? null]),
    );

    return {
      reportDate: midnightLocal(start),
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
    };
  }

  return null;
}
