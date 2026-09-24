/**
 * Business dates are plain ISO calendar dates (YYYY-MM-DD) in the business's
 * time zone (Asia/Kolkata by default). Date arithmetic is done in UTC on those
 * calendar dates so it never shifts by a day around midnight.
 */
const DAY_MS = 86_400_000;

function toUtcMs(iso: string): number {
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid ISO date "${iso}"`);
  return ms;
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

export function addDays(iso: string, days: number): string {
  return new Date(toUtcMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Today's calendar date in the given IANA time zone. */
export function todayIn(timeZone = "Asia/Kolkata", now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts;
}

/** First and last day of a "YYYY-MM" month. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: `${month}-01`, end: addDays(next, -1) };
}
