import { addDays } from "../dates.js";

/** How often a repeat bill is made. */
export const REPEAT_FREQUENCIES = ["weekly", "monthly"] as const;
export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number];

/** Most bills one run makes for a single repeat (catching up after the server was off). */
export const MAX_REPEAT_CATCH_UP = 12;

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The date of the bill after `from`. Weekly: seven days on. Monthly: the same
 * day next month, kept on `day` (the day the repeat started on), so a bill on
 * the 31st falls on the 30th in April and the 28th or 29th in February, and is
 * back on the 31st in May.
 */
export function nextRepeatDate(frequency: RepeatFrequency, from: string, day: number): string {
  if (frequency === "weekly") return addDays(from, 7);
  const y = Number(from.slice(0, 4));
  const m = Number(from.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const d = Math.min(Math.max(1, day), daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The bill dates due on or before `today`, from `next` (at most MAX_REPEAT_CATCH_UP, none after `end`). */
export function dueRepeatDates(frequency: RepeatFrequency, next: string, day: number, today: string, end: string | null): { dates: string[]; next: string } {
  const dates: string[] = [];
  let at = next;
  while (at <= today && (!end || at <= end) && dates.length < MAX_REPEAT_CATCH_UP) {
    dates.push(at);
    at = nextRepeatDate(frequency, at, day);
  }
  return { dates, next: at };
}
