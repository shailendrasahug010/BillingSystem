/**
 * Bank statements (the CSV or Excel a bank's net banking gives) read into
 * lines, and each line matched to the party it most likely came from or went
 * to: by UPI id, mobile number or name in the narration, helped by an amount
 * that equals one of the party's open bills or their whole balance. A line
 * that is already in the books (a payment of that amount near that date) is
 * marked so it is not entered twice.
 */
export interface StatementLine {
  /** Row in the file (1-based, the header excluded). */
  row: number;
  /** ISO date. */
  date: string;
  narration: string;
  /** UTR, cheque or reference number when the bank gives one. */
  reference: string;
  /** Money in (positive) or out (negative), in rupees. */
  amount: number;
}

export interface StatementRead {
  lines: StatementLine[];
  /** Rows after the header that are not transactions (balances, totals, blank dates). */
  skipped: number;
}

type Field = "date" | "narration" | "reference" | "debit" | "credit" | "amount" | "drcr";

const HEADERS: Array<[Field, RegExp]> = [
  ["date", /^(txn |transaction |value )?date$|^date$|^tran date$|^posting date$/],
  ["narration", /narration|description|particulars|remarks|details|transaction details/],
  ["reference", /ref|chq|cheque|utr|instrument/],
  ["drcr", /^(dr ?\/ ?cr|cr ?\/ ?dr|debit ?\/ ?credit|type)$/],
  ["debit", /withdrawal|debit|^dr\b|paid out|money out/],
  ["credit", /deposit|credit|^cr\b|paid in|money in/],
  ["amount", /^(transaction )?amount( \(inr\)| \(rs\.?\))?$/],
];

const norm = (s: string) => s.toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ").trim();

function headerMap(cells: string[]): Partial<Record<Field, number>> | null {
  const map: Partial<Record<Field, number>> = {};
  cells.forEach((c, i) => {
    const h = norm(c);
    // The running balance is never the transaction's amount.
    if (!h || /balance/.test(h)) return;
    // "Value Date" after "Txn Date": the first date column wins.
    for (const [field, re] of HEADERS) {
      if (map[field] === undefined && re.test(h)) {
        map[field] = i;
        break;
      }
    }
  });
  const hasMoney = (map.debit !== undefined && map.credit !== undefined) || map.amount !== undefined;
  return map.date !== undefined && hasMoney ? map : null;
}

/** Whether a row is a statement's column header (for reading a PDF statement's table). */
export function isStatementHeader(cells: string[]): boolean {
  return headerMap(cells) !== null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 05/10/2026, 05-10-26, 05-Oct-2026, 05 Oct 26, 2026-10-05 → 2026-10-05; "" when not a date. */
export function statementDate(raw: string): string {
  const s = raw.trim().toLowerCase();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.\- ]([a-z]{3,9}|\d{1,2})[/.\- ,]+(\d{2}|\d{4})\b/);
  if (!m) return "";
  const month = /^\d/.test(m[2]!) ? Number(m[2]) : MONTHS.indexOf(m[2]!.slice(0, 3)) + 1;
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const day = Number(m[1]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "1,23,456.50", "₹ 500.00 Cr", "(200)" → rupees; null when blank. */
function money(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.replace(/[₹,\s]|rs\.?|inr/gi, "");
  if (!s || s === "-") return null;
  const m = s.match(/^\(?(-?\d+(?:\.\d+)?)\)?/);
  if (!m) return null;
  const n = Number(m[1]);
  return s.startsWith("(") ? -n : n;
}

/** The statement's transactions, from the rows of its file (whatever is above the header is ignored). */
export function readBankStatement(rows: string[][]): StatementRead | null {
  const headerAt = rows.findIndex((r) => headerMap(r) !== null);
  if (headerAt < 0) return null;
  const map = headerMap(rows[headerAt]!)!;
  const lines: StatementLine[] = [];
  let skipped = 0;
  rows.slice(headerAt + 1).forEach((r, i) => {
    const date = statementDate(r[map.date!] ?? "");
    let amount: number | null = null;
    if (map.debit !== undefined && map.credit !== undefined) {
      const credit = money(r[map.credit]);
      const debit = money(r[map.debit]);
      amount = credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null;
    } else {
      const v = money(r[map.amount!]);
      const type = norm(map.drcr !== undefined ? (r[map.drcr] ?? "") : (r[map.amount!] ?? ""));
      if (v !== null) amount = /\bdr\b|debit|withdrawal/.test(type) ? -Math.abs(v) : /\bcr\b|credit|deposit/.test(type) ? Math.abs(v) : v;
    }
    if (!date || !amount) {
      skipped++;
      return;
    }
    const narration = (map.narration !== undefined ? (r[map.narration] ?? "") : "").replace(/\s+/g, " ").trim();
    let reference = (map.reference !== undefined ? (r[map.reference] ?? "") : "").trim();
    // UPI narrations carry the 12-digit transaction number: "UPI/CR/412345678901/…".
    if (!reference || /^0+$/.test(reference)) reference = narration.match(/(?:^|\D)(\d{12})(?:\D|$)/)?.[1] ?? "";
    lines.push({ row: i + 1, date, narration, reference, amount: Math.round(amount * 100) / 100 });
  });
  return { lines, skipped };
}

export interface StatementParty {
  id: string;
  kind: "customer" | "supplier";
  name: string;
  /** Other names the party goes by (trade name, contact person). */
  aliases?: string[];
  mobiles?: string[];
  upiId?: string | null;
  /** Receivable (customer) or payable (supplier), in rupees. */
  balance: number;
  /** Balances of the party's open bills. */
  openBills: number[];
}

export interface RecordedPayment {
  partyId: string;
  direction: "in" | "out";
  date: string;
  amount: number;
  reference: string | null;
}

export type MatchStatus = "recorded" | "matched" | "likely" | "unmatched";

export interface StatementMatch {
  status: MatchStatus;
  partyId: string | null;
  /** Why: "upi", "mobile", "name", plus "bill" / "balance" when the amount fits. */
  reasons: string[];
}

/** Words that say nothing about who paid. */
const NOISE = new Set(["MS", "M/S", "THE", "AND", "SHRI", "SRI", "SMT", "STORE", "STORES", "TRADERS", "TRADING", "ENTERPRISES", "AGENCY", "AGENCIES", "GENERAL", "KIRANA", "SONS", "CO", "PVT", "LTD", "LIMITED", "PRIVATE", "BROTHERS", "BROS", "MART", "SHOP", "CENTRE", "CENTER", "UPI", "NEFT", "RTGS", "IMPS"]);

const words = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 3 && !NOISE.has(w) && !/^\d+$/.test(w));

const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * The party a statement line most likely belongs to. Money in is looked for
 * among customers, money out among suppliers. "matched": a UPI id or mobile
 * number in the narration, the whole of a name of two words or more, or a
 * name with the amount of an open bill or the balance; "likely": part of a
 * name, or the amount alone when exactly one party has it open.
 */
export function matchStatementLine(line: StatementLine, parties: StatementParty[], recorded: RecordedPayment[]): StatementMatch {
  const direction = line.amount > 0 ? "in" : "out";
  const amount = Math.abs(line.amount);
  const done = recorded.find(
    (p) => p.direction === direction && sameMoney(p.amount, amount) && ((line.reference && p.reference === line.reference) || daysApart(p.date, line.date) <= 3),
  );
  if (done) return { status: "recorded", partyId: done.partyId, reasons: line.reference && done.reference === line.reference ? ["reference"] : ["amount"] };

  const pool = parties.filter((p) => p.kind === (direction === "in" ? "customer" : "supplier"));
  const text = line.narration.toUpperCase();
  const digits = line.narration.replace(/\D+/g, " ");
  const textWords = new Set(words(line.narration));
  const fits = (p: StatementParty) => (p.openBills.some((b) => sameMoney(b, amount)) ? "bill" : sameMoney(p.balance, amount) ? "balance" : null);

  let best: { party: StatementParty; score: number; reasons: string[]; fullName: boolean } | null = null;
  for (const p of pool) {
    const reasons: string[] = [];
    let score = 0;
    if (p.upiId && text.includes(p.upiId.toUpperCase())) {
      score += 100;
      reasons.push("upi");
    }
    if ((p.mobiles ?? []).some((m) => m.length >= 10 && digits.includes(m.slice(-10)))) {
      score += 90;
      reasons.push("mobile");
    }
    let nameScore = 0;
    // Every word of a name of two words or more is as good as a mobile number.
    let fullName = false;
    for (const n of [p.name, ...(p.aliases ?? [])]) {
      const w = words(n);
      const share = w.length ? w.filter((x) => textWords.has(x)).length / w.length : 0;
      nameScore = Math.max(nameScore, share);
      if (share === 1 && w.length >= 2) fullName = true;
    }
    if (nameScore >= 0.5) {
      score += 60 * nameScore;
      reasons.push("name");
    }
    const fit = fits(p);
    if (fit && score > 0) {
      score += 30;
      reasons.push(fit);
    }
    if (score > 0 && (!best || score > best.score)) best = { party: p, score, reasons, fullName };
  }
  if (best) {
    const sure = best.reasons.includes("upi") || best.reasons.includes("mobile") || (best.reasons.includes("name") && (best.score >= 80 || best.fullName));
    return { status: sure ? "matched" : "likely", partyId: best.party.id, reasons: best.reasons };
  }
  // Nothing in the narration: an amount only one party has open is a fair guess.
  const byAmount = pool.filter((p) => fits(p));
  if (byAmount.length === 1) return { status: "likely", partyId: byAmount[0]!.id, reasons: [fits(byAmount[0]!)!] };
  return { status: "unmatched", partyId: null, reasons: [] };
}
