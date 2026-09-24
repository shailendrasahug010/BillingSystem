import { addDays, daysBetween, financialYearOf } from "@vyapaar/core";
import { badRequest } from "./errors.js";

export interface Period {
  from: string;
  to: string;
  /** The comparable earlier period ("vs last month so far"). */
  previous: { from: string; to: string };
}

const pad = (n: number) => String(n).padStart(2, "0");
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
function shiftMonth(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}

/** Named reporting ranges in the business calendar, each with the period to compare against. */
export function resolvePeriod(
  range: "today" | "yesterday" | "last7" | "thisMonth" | "lastMonth" | "thisFy" | "custom",
  today: string,
  fyStartMonth: number,
  custom?: { from?: string | undefined; to?: string | undefined },
): Period {
  switch (range) {
    case "today":
      return { from: today, to: today, previous: { from: addDays(today, -1), to: addDays(today, -1) } };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y, previous: { from: addDays(y, -1), to: addDays(y, -1) } };
    }
    case "last7":
      return { from: addDays(today, -6), to: today, previous: { from: addDays(today, -13), to: addDays(today, -7) } };
    case "thisMonth":
      return { from: monthStart(today), to: today, previous: { from: monthStart(shiftMonth(today, -1)), to: shiftMonth(today, -1) } };
    case "lastMonth": {
      const start = monthStart(shiftMonth(today, -1));
      return { from: start, to: addDays(monthStart(today), -1), previous: { from: monthStart(shiftMonth(today, -2)), to: addDays(start, -1) } };
    }
    case "thisFy": {
      const fy = financialYearOf(today, fyStartMonth);
      return { from: fy.startDate, to: today, previous: { from: shiftMonth(fy.startDate, -12), to: shiftMonth(today, -12) } };
    }
    case "custom": {
      if (!custom?.from || !custom.to) throw badRequest("INVALID_PERIOD", {}, "from");
      if (custom.to < custom.from) throw badRequest("INVALID_PERIOD", {}, "to");
      const days = daysBetween(custom.from, custom.to);
      if (days > 1830) throw badRequest("PERIOD_TOO_LONG", { maxDays: 1830 }, "to");
      return { from: custom.from, to: custom.to, previous: { from: addDays(custom.from, -(days + 1)), to: addDays(custom.from, -1) } };
    }
  }
}

/** Guards free-form report ranges. */
export function assertRange(from: string, to: string): void {
  if (to < from) throw badRequest("INVALID_PERIOD", {}, "to");
  if (daysBetween(from, to) > 1830) throw badRequest("PERIOD_TOO_LONG", { maxDays: 1830 }, "to");
}
