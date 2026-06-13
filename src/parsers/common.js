// Common schema produced by every parser, regardless of profile kind.
// All numeric fields; nulls allowed when the source page was missing a value.

export const COMMON_FIELDS = [
  'newRegistrationCount',
  'newDepositCount',
  'totalDepositCount',
  'totalDepositAmount',
  'totalWithdrawalCount',
  'totalWithdrawalAmount',
];

export const COMMON_LABELS = {
  newRegistrationCount: 'New Registration Count',
  newDepositCount: 'New Deposit Count',
  totalDepositCount: 'Total Deposit Count',
  totalDepositAmount: 'Total Deposit Amount',
  totalWithdrawalCount: 'Total Withdrawal Count',
  totalWithdrawalAmount: 'Total Withdrawal Amount',
};

// The zoomwlb dashboard renders EVERY period's values simultaneously, in
// separate elements that share a suffix and differ only by a period prefix:
//   <span id="todayNewPlayer">     <span id="yesterdayNewPlayer">  …
// So fetching "yesterday" is just reading the yesterday* ids on the same page —
// no navigation, filter select, or Apply click required.
const ZOOMWLB_FIELD_SUFFIXES = {
  newRegistrationCount: 'NewPlayer',
  newDepositCount: 'FirstDeposit',
  totalDepositCount: 'DepositSuccessCount',
  totalDepositAmount: 'DepositSuccessAmount',
  totalWithdrawalCount: 'WithdrawalSuccessCount',
  totalWithdrawalAmount: 'WithdrawalSuccessAmount',
};

// commonKey -> page element id for the given period ('today' | 'yesterday').
export function zoomwlbFieldIds(period = 'today') {
  const prefix = period === 'yesterday' ? 'yesterday' : 'today';
  return Object.fromEntries(
    Object.entries(ZOOMWLB_FIELD_SUFFIXES).map(([key, suffix]) => [key, prefix + suffix]),
  );
}

// Default (today) map — kept for callers that don't need a specific period.
export const ZOOMWLB_FIELD_IDS = zoomwlbFieldIds('today');

export function emptyCommonData() {
  return Object.fromEntries(COMMON_FIELDS.map((k) => [k, null]));
}
