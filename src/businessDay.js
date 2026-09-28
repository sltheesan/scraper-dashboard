// Business-day helpers.
//
// Both platforms (cgaming, zoomwlb) run a "day" that starts at a configurable
// CUTOVER time (default 11:00 ICT) and ends one second before the next cutover.
// e.g. cutover 11:00 => business day D covers [D 11:00:00 .. D+1 10:59:59].
//
// The whole codebase runs in the business timezone (Asia/Bangkok, forced in
// server.js), so plain local-date math here is already ICT.

export const DEFAULT_CUTOVER = '11:00';
const CUTOVER_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True if `s` is a valid "HH:MM" 24-hour string. */
export function isValidCutover(s) {
  return CUTOVER_RE.test(String(s ?? '').trim());
}

/** Parse "HH:MM" -> { h, m }. Falls back to 11:00 on bad input. */
export function parseCutover(cutover) {
  const m = CUTOVER_RE.exec(String(cutover ?? '').trim());
  if (!m) return { h: 11, m: 0 };
  return { h: Number(m[1]), m: Number(m[2]) };
}

/**
 * The business day that `now` falls in, as a midnight-aligned local Date.
 * Instants before the cutover time belong to the previous calendar date.
 * Implemented by shifting the clock back by the cutover offset, then taking
 * that instant's calendar date.
 */
export function businessDayDate(now = new Date(), cutover = DEFAULT_CUTOVER) {
  const { h, m } = parseCutover(cutover);
  const shifted = new Date(now.getTime() - (h * 60 + m) * 60000);
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
}

/** The business day immediately before the one `now` is in (midnight Date). */
export function yesterdayBusinessDate(now = new Date(), cutover = DEFAULT_CUTOVER) {
  const d = businessDayDate(now, cutover);
  d.setDate(d.getDate() - 1);
  return d;
}

/** ms from `now` until the next occurrence of the cutover (+ offsetMin). */
export function msUntilCutover(now = new Date(), cutover = DEFAULT_CUTOVER, offsetMin = 0) {
  const { h, m } = parseCutover(cutover);
  const next = new Date(now);
  next.setHours(h, m + offsetMin, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}
