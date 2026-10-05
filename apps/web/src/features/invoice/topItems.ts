import { addDays } from "@digitalbahi/core";
import { INVOICES, productById, TODAY } from "../../data/db";
import { offlineScope } from "../../offline/sync";

/**
 * The products billed most lately, offered when the product search is empty:
 * a tally of the bills saved on this device over the last week (a bill today
 * counts three times), kept in this browser per business. The demo adds its
 * sample bills.
 */
type Tally = Record<string, Record<string, number>>;

const DAYS = 7;
const key = () => `billed-items:${offlineScope()?.businessId ?? "local"}`;

function read(): Tally {
  try {
    const raw = localStorage.getItem(key());
    return raw ? (JSON.parse(raw) as Tally) : {};
  } catch {
    return {};
  }
}

/** A saved bill's products, counted once each for its day. */
export function recordBilled(productIds: readonly string[], date = TODAY): void {
  const since = addDays(TODAY, -(DAYS - 1));
  const tally = read();
  const day = (tally[date] ??= {});
  for (const id of new Set(productIds)) day[id] = (day[id] ?? 0) + 1;
  for (const d of Object.keys(tally)) if (d < since) delete tally[d];
  try {
    localStorage.setItem(key(), JSON.stringify(tally));
  } catch {
    // Storage full or blocked: the list just has less to go on.
  }
}

/** The products billed most today and this week, most first. */
export function topBilled(limit = 8): string[] {
  const since = addDays(TODAY, -(DAYS - 1));
  const score = new Map<string, number>();
  const add = (date: string, id: string, n: number) => {
    if (date < since || date > TODAY) return;
    score.set(id, (score.get(id) ?? 0) + n * (date === TODAY ? 3 : 1));
  };
  for (const [date, day] of Object.entries(read())) for (const [id, n] of Object.entries(day)) add(date, id, n);
  for (const inv of INVOICES) if (inv.date >= since) for (const id of new Set(inv.lines.map((l) => l.productId))) add(inv.date, id, 1);
  return [...score.entries()]
    .filter(([id]) => {
      const p = productById.get(id);
      return p && p.active !== false;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}
