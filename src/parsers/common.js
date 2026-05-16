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

// Fixed HTML id map for zoomwlb-style dashboards.
// commonKey -> id attribute on the page (case-sensitive — these are camelCase
// on the live page, despite the dashboard rendering the labels in ALL CAPS).
export const ZOOMWLB_FIELD_IDS = {
  newRegistrationCount: 'todayNewPlayer',
  newDepositCount: 'todayFirstDeposit',
  totalDepositCount: 'todayDepositSuccessCount',
  totalDepositAmount: 'todayDepositSuccessAmount',
  totalWithdrawalCount: 'todayWithdrawalSuccessCount',
  totalWithdrawalAmount: 'todayWithdrawalSuccessAmount',
};

export function emptyCommonData() {
  return Object.fromEntries(COMMON_FIELDS.map((k) => [k, null]));
}
