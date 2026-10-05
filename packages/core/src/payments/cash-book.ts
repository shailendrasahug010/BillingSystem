import { dec, type DecimalInput } from "../money/decimal.js";

/** Which money a cash book follows: notes and coins, everything that goes through the bank (UPI, transfers, cheques, cards), or both. */
export type CashBookKind = "cash" | "bank" | "all";

export interface CashBookEntry {
  date: string;
  /** Money in (receipts) and out (payments, expenses), one of them non-zero. */
  in: DecimalInput;
  out: DecimalInput;
}

export interface CashBookDay {
  date: string;
  opening: string;
  in: string;
  out: string;
  closing: string;
}

/** Cash for "cash"; every other method for "bank"; everything for "all". */
export function inCashBook(kind: CashBookKind, method: string): boolean {
  return kind === "all" || (kind === "cash") === (method === "cash");
}

/**
 * Running balance over the entries (already in date order), and one line per
 * day with money moving: opening, in, out, closing. The day's closing is the
 * next day's opening.
 */
export function cashBook<T extends CashBookEntry>(opening: DecimalInput, entries: readonly T[]) {
  let running = dec(opening);
  const days: CashBookDay[] = [];
  let totalIn = dec(0);
  let totalOut = dec(0);
  const rows = entries.map((e) => {
    let day = days[days.length - 1];
    if (!day || day.date !== e.date) {
      day = { date: e.date, opening: running.toFixed(2), in: "0.00", out: "0.00", closing: running.toFixed(2) };
      days.push(day);
    }
    running = running.plus(e.in).minus(e.out);
    totalIn = totalIn.plus(e.in);
    totalOut = totalOut.plus(e.out);
    day.in = dec(day.in).plus(e.in).toFixed(2);
    day.out = dec(day.out).plus(e.out).toFixed(2);
    day.closing = running.toFixed(2);
    return { ...e, balance: running.toFixed(2) };
  });
  return { opening: dec(opening).toFixed(2), in: totalIn.toFixed(2), out: totalOut.toFixed(2), closing: running.toFixed(2), rows, days };
}
