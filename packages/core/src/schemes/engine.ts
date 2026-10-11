import { dec, type Dec, type DecimalInput, pct, roundAmount, roundQty, sum, ZERO } from "../money/decimal.js";

/**
 * Trade schemes on sales, as distributors run them for the companies they
 * stock: free goods (buy 10 get 1 free; buy a case of A, get 2 of B free)
 * and discounts by slab (2% off 5 boxes or more of a brand; ₹3 a piece off
 * 100 pieces or more), for a period, for every customer or only some.
 *
 * The bill screen runs this to give what the bill earns as it is made (and
 * to say how much more earns the next slab); the server runs it again on
 * save, with the schemes it has, and refuses a scheme the bill did not earn
 * (a bill made offline is held for review instead). Same code both sides, so
 * the same bill always earns the same.
 */

export type SchemeKind = "free_goods" | "discount";
/** What a slab is counted in: stock units of the products, or their value in rupees. */
export type SchemeMeasure = "qty" | "value";

export interface SchemeSlab {
  /** Least quantity (stock units) or value (rupees) of the scheme's products on the bill. */
  from: DecimalInput;
  /** Free goods: stock units of the free product given (for each `from` when the scheme repeats). */
  freeQty?: DecimalInput | null;
  /** Discount: percent off the value of the scheme's products. */
  discountPercent?: DecimalInput | null;
  /** Discount: rupees off for each stock unit of them. */
  discountPerUnit?: DecimalInput | null;
}

export interface SchemeRule {
  id: string;
  name: string;
  kind: SchemeKind;
  measure: SchemeMeasure;
  /** The products it is on: any of these products, or any product of these brands or categories. */
  productIds: readonly string[];
  brandIds: readonly string[];
  categoryIds: readonly string[];
  /** One or more slabs; the highest one the bill reaches counts. */
  slabs: readonly SchemeSlab[];
  /** Free goods: given again for each further `from` (buy 10 get 1: 20 get 2). */
  repeat: boolean;
  /**
   * Free goods: the product given. Null: each product given free on itself,
   * counted on its own (buy 10 of it, get 1 of it); with a product named, the
   * scheme's products count together (any 12 soaps of the brand, get a
   * shampoo free).
   */
  freeProductId: string | null;
  validFrom: string;
  /** Last day it runs; null while it has no end. */
  validTo: string | null;
  /** Who gets it: customers of these categories or rate lists; both empty: every customer. */
  customerCategoryIds: readonly string[];
  priceLevelIds: readonly string[];
  active: boolean;
}

/** A line of the bill as a scheme sees it. */
export interface SchemeLine {
  key: string;
  productId: string;
  brandId?: string | null;
  categoryId?: string | null;
  /** Quantity in stock units (packs times what a pack holds). */
  qtyBase: DecimalInput;
  /** What the line comes to before any scheme: quantity times rate, less its own discounts. */
  value: DecimalInput;
}

export interface SchemeCustomer {
  categoryId?: string | null;
  priceLevelId?: string | null;
}

export interface SchemeInput {
  /** The bill's date: a scheme runs on the days from its start to its end. */
  date: string;
  customer: SchemeCustomer | null;
  lines: readonly SchemeLine[];
  schemes: readonly SchemeRule[];
  /** Schemes left off this bill (the person said no to them). */
  declined?: Iterable<string>;
  /**
   * Price of one stock unit of a product for this customer: free goods are
   * weighed with it against a discount when two schemes want the same line.
   */
  unitValue?: (productId: string) => DecimalInput | null | undefined;
}

/** One scheme given on the bill (a scheme given on each product by itself is given once per product). */
export interface AppliedScheme {
  scheme: SchemeRule;
  /** The lines it was earned on. */
  lineKeys: string[];
  /** The product it was counted on, for a scheme given on each product by itself. */
  productId: string | null;
  /** Quantity (stock units) or value it was counted on, and the slab reached (its index in the scheme's slabs). */
  measure: Dec;
  slab: number;
  /** A discount: what each line gets off, in rupees. */
  discounts: Array<{ lineKey: string; amount: Dec }>;
  /** Free goods: what is given, in stock units. */
  free: Array<{ productId: string; qty: Dec }>;
  /** Rupees: the discount, or the free goods at their price. */
  benefit: Dec;
}

/** How much more of a scheme's products earns its next slab (or its first). */
export interface SchemeHint {
  scheme: SchemeRule;
  productId: string | null;
  /** Counted so far, and how much more is needed (stock units or rupees, as the scheme counts). */
  measure: Dec;
  short: Dec;
  /** The slab it reaches then. */
  slab: number;
}

export interface SchemeResult {
  applied: AppliedScheme[];
  /** The scheme discount on each line (one scheme's discount per line). */
  discountByLine: Map<string, { schemeId: string; amount: Dec }>;
  /** Free goods to give: one entry per scheme and product. */
  free: Array<{ schemeId: string; productId: string; qty: Dec }>;
  /** Schemes in force for this customer on the day that are on a product of the bill, given or not (declined ones too). */
  available: SchemeRule[];
  hints: SchemeHint[];
}

/** Whether a scheme runs on a day. */
export function schemeInForce(scheme: Pick<SchemeRule, "active" | "validFrom" | "validTo">, date: string): boolean {
  return scheme.active && scheme.validFrom <= date && (scheme.validTo === null || date <= scheme.validTo);
}

/** Whether a customer gets a scheme (one for some customers only: of its categories or rate lists). */
export function schemeForCustomer(scheme: Pick<SchemeRule, "customerCategoryIds" | "priceLevelIds">, customer: SchemeCustomer | null): boolean {
  if (scheme.customerCategoryIds.length === 0 && scheme.priceLevelIds.length === 0) return true;
  if (!customer) return false;
  return (
    (customer.categoryId != null && scheme.customerCategoryIds.includes(customer.categoryId)) ||
    (customer.priceLevelId != null && scheme.priceLevelIds.includes(customer.priceLevelId))
  );
}

/** Whether a scheme is on a line's product. */
export function schemeCovers(scheme: Pick<SchemeRule, "productIds" | "brandIds" | "categoryIds">, line: Pick<SchemeLine, "productId" | "brandId" | "categoryId">): boolean {
  return (
    scheme.productIds.includes(line.productId) ||
    (line.brandId != null && scheme.brandIds.includes(line.brandId)) ||
    (line.categoryId != null && scheme.categoryIds.includes(line.categoryId))
  );
}

/** The slabs from the lowest; a slab of nothing counts for nothing. */
function orderedSlabs(scheme: SchemeRule): Array<{ index: number; from: Dec; slab: SchemeSlab }> {
  return scheme.slabs
    .map((slab, index) => ({ index, from: dec(slab.from), slab }))
    .filter((s) => s.from.gt(0))
    .sort((a, b) => a.from.comparedTo(b.from) || a.index - b.index);
}

/** The highest slab a measure reaches, or null. */
function reached(scheme: SchemeRule, measure: Dec): { index: number; from: Dec; slab: SchemeSlab } | null {
  let best: { index: number; from: Dec; slab: SchemeSlab } | null = null;
  for (const s of orderedSlabs(scheme)) if (s.from.lte(measure)) best = s;
  return best;
}

const measureOf = (scheme: SchemeRule, lines: readonly SchemeLine[]) => sum(lines.map((l) => (scheme.measure === "qty" ? dec(l.qtyBase) : dec(l.value))));

/** What a scheme gives on these lines (several entries for one given on each product by itself); empty when nothing. */
function evaluate(scheme: SchemeRule, lines: readonly SchemeLine[], unitValue: SchemeInput["unitValue"]): AppliedScheme[] {
  const covered = lines.filter((l) => schemeCovers(scheme, l));
  if (!covered.length) return [];
  const priceOf = (productId: string) => {
    const v = unitValue?.(productId);
    return v === null || v === undefined ? ZERO : dec(v);
  };

  if (scheme.kind === "discount") {
    const measure = measureOf(scheme, covered);
    const s = reached(scheme, measure);
    if (!s) return [];
    const percent = dec(s.slab.discountPercent ?? 0);
    const perUnit = dec(s.slab.discountPerUnit ?? 0);
    const discounts = covered
      .map((l) => {
        const value = dec(l.value);
        let amount = roundAmount(pct(value, percent)).plus(roundAmount(dec(l.qtyBase).times(perUnit)));
        // Never more than the line comes to.
        if (amount.gt(value)) amount = value.isNegative() ? ZERO : value;
        return { lineKey: l.key, amount };
      })
      .filter((d) => d.amount.gt(0));
    if (!discounts.length) return [];
    return [{ scheme, lineKeys: covered.map((l) => l.key), productId: null, measure, slab: s.index, discounts, free: [], benefit: sum(discounts.map((d) => d.amount)) }];
  }

  // Free goods: counted together for a named free product, else on each product by itself.
  const groups: Array<{ productId: string | null; lines: SchemeLine[] }> = scheme.freeProductId
    ? [{ productId: null, lines: covered }]
    : [...new Set(covered.map((l) => l.productId))].map((productId) => ({ productId, lines: covered.filter((l) => l.productId === productId) }));
  const out: AppliedScheme[] = [];
  for (const g of groups) {
    const measure = measureOf(scheme, g.lines);
    const s = reached(scheme, measure);
    if (!s) continue;
    const times = scheme.repeat ? measure.dividedToIntegerBy(s.from) : dec(1);
    const qty = roundQty(times.times(dec(s.slab.freeQty ?? 0)));
    if (qty.lte(0)) continue;
    const productId = scheme.freeProductId ?? g.productId!;
    out.push({
      scheme,
      lineKeys: g.lines.map((l) => l.key),
      productId: g.productId,
      measure,
      slab: s.index,
      discounts: [],
      free: [{ productId, qty }],
      benefit: roundAmount(qty.times(priceOf(productId))),
    });
  }
  return out;
}

/** How much more earns the next slab of a scheme on these lines. */
function hintsFor(scheme: SchemeRule, lines: readonly SchemeLine[]): SchemeHint[] {
  const covered = lines.filter((l) => schemeCovers(scheme, l));
  if (!covered.length) return [];
  const groups: Array<{ productId: string | null; lines: SchemeLine[] }> =
    scheme.kind === "free_goods" && !scheme.freeProductId
      ? [...new Set(covered.map((l) => l.productId))].map((productId) => ({ productId, lines: covered.filter((l) => l.productId === productId) }))
      : [{ productId: null, lines: covered }];
  const slabs = orderedSlabs(scheme);
  const out: SchemeHint[] = [];
  for (const g of groups) {
    const measure = measureOf(scheme, g.lines);
    const now = reached(scheme, measure);
    // The next point where the bill earns more: the next slab, or (repeating free goods) the next multiple of this one.
    const candidates: Array<{ at: Dec; slab: number }> = [];
    const next = slabs.find((s) => s.from.gt(measure));
    if (next) candidates.push({ at: next.from, slab: next.index });
    if (now && scheme.kind === "free_goods" && scheme.repeat) candidates.push({ at: measure.dividedToIntegerBy(now.from).plus(1).times(now.from), slab: now.index });
    const best = candidates.sort((a, b) => a.at.comparedTo(b.at))[0];
    if (best) out.push({ scheme, productId: g.productId, measure, short: best.at.minus(measure), slab: best.slab });
  }
  return out;
}

/**
 * What the bill earns. Each line takes at most one discount scheme and
 * counts towards at most one free-goods scheme: where schemes want the same
 * line, the one worth more to the customer goes first (then the other counts
 * on the lines left), ties by id, so both sides choose alike.
 */
export function applySchemes(input: SchemeInput): SchemeResult {
  const declined = new Set(input.declined ?? []);
  const available = input.schemes.filter(
    (s) => schemeInForce(s, input.date) && schemeForCustomer(s, input.customer) && input.lines.some((l) => schemeCovers(s, l)),
  );
  const live = available.filter((s) => !declined.has(s.id));
  const applied: AppliedScheme[] = [];
  for (const kind of ["discount", "free_goods"] as const) {
    let candidates = live.filter((s) => s.kind === kind);
    const used = new Set<string>();
    for (;;) {
      const lines = input.lines.filter((l) => !used.has(l.key));
      let best: { scheme: SchemeRule; given: AppliedScheme[]; benefit: Dec } | null = null;
      for (const scheme of candidates) {
        const given = evaluate(scheme, lines, input.unitValue);
        if (!given.length) continue;
        const benefit = sum(given.map((g) => g.benefit));
        if (!best || benefit.gt(best.benefit) || (benefit.eq(best.benefit) && scheme.id < best.scheme.id)) best = { scheme, given, benefit };
      }
      if (!best) break;
      applied.push(...best.given);
      for (const g of best.given) for (const k of g.lineKeys) used.add(k);
      const taken = best.scheme;
      candidates = candidates.filter((s) => s !== taken);
    }
  }

  const discountByLine = new Map<string, { schemeId: string; amount: Dec }>();
  const free: SchemeResult["free"] = [];
  for (const a of applied) {
    for (const d of a.discounts) discountByLine.set(d.lineKey, { schemeId: a.scheme.id, amount: d.amount });
    for (const f of a.free) {
      const same = free.find((x) => x.schemeId === a.scheme.id && x.productId === f.productId);
      if (same) same.qty = same.qty.plus(f.qty);
      else free.push({ schemeId: a.scheme.id, productId: f.productId, qty: f.qty });
    }
  }
  const hints = live.flatMap((s) => hintsFor(s, input.lines));
  return { applied, discountByLine, free, available, hints };
}

/** What a bill says it gave under schemes, to check against what it earned. */
export interface SchemeClaims {
  discounts: ReadonlyArray<{ lineKey: string; schemeId: string; amount: DecimalInput }>;
  free: ReadonlyArray<{ schemeId: string; productId: string; qty: DecimalInput }>;
}

export interface SchemeProblem {
  schemeId: string;
  /**
   * unknown: no such scheme; not_in_force: not running on the bill's day;
   * not_for_customer: for other customers; not_earned / too_much: the bill
   * did not earn it, or earned less.
   */
  reason: "unknown" | "not_in_force" | "not_for_customer" | "not_earned" | "too_much";
  lineKey?: string;
  productId?: string;
  claimed?: string;
  allowed?: string;
}

/**
 * Checks what a bill gave under schemes against what it earns. The schemes
 * it gave none of count as declined, so a scheme given in place of a better
 * one the customer said no to is checked as the bill screen chose it.
 */
export function checkSchemeClaims(input: Omit<SchemeInput, "declined">, claims: SchemeClaims): SchemeProblem[] {
  const problems: SchemeProblem[] = [];
  const claimed = new Set([...claims.discounts.map((d) => d.schemeId), ...claims.free.map((f) => f.schemeId)]);
  for (const id of claimed) {
    const scheme = input.schemes.find((s) => s.id === id);
    if (!scheme) problems.push({ schemeId: id, reason: "unknown" });
    else if (!schemeInForce(scheme, input.date)) problems.push({ schemeId: id, reason: "not_in_force" });
    else if (!schemeForCustomer(scheme, input.customer)) problems.push({ schemeId: id, reason: "not_for_customer" });
  }
  if (problems.length) return problems;
  const result = applySchemes({ ...input, declined: input.schemes.filter((s) => !claimed.has(s.id)).map((s) => s.id) });
  for (const d of claims.discounts) {
    const earned = result.discountByLine.get(d.lineKey);
    const amount = roundAmount(d.amount);
    if (amount.lte(0)) continue;
    if (!earned || earned.schemeId !== d.schemeId) problems.push({ schemeId: d.schemeId, reason: "not_earned", lineKey: d.lineKey, claimed: amount.toFixed(2), allowed: "0.00" });
    else if (amount.gt(earned.amount)) problems.push({ schemeId: d.schemeId, reason: "too_much", lineKey: d.lineKey, claimed: amount.toFixed(2), allowed: earned.amount.toFixed(2) });
  }
  const given = new Map<string, Dec>();
  for (const f of claims.free) {
    const k = `${f.schemeId}|${f.productId}`;
    given.set(k, (given.get(k) ?? ZERO).plus(dec(f.qty)));
  }
  for (const [k, qty] of given) {
    const [schemeId, productId] = k.split("|") as [string, string];
    if (qty.lte(0)) continue;
    const earned = result.free.find((f) => f.schemeId === schemeId && f.productId === productId)?.qty ?? ZERO;
    if (qty.gt(earned)) problems.push({ schemeId, reason: earned.isZero() ? "not_earned" : "too_much", productId, claimed: roundQty(qty).toFixed(3), allowed: earned.toFixed(3) });
  }
  return problems;
}

/** Checks a scheme as entered; returns the first problem's code (for the API's error) or null. */
export function schemeRuleProblem(scheme: Omit<SchemeRule, "id" | "active">): string | null {
  if (!scheme.productIds.length && !scheme.brandIds.length && !scheme.categoryIds.length) return "SCHEME_NO_PRODUCTS";
  if (!scheme.slabs.length) return "SCHEME_NO_SLABS";
  if (scheme.validTo !== null && scheme.validTo < scheme.validFrom) return "SCHEME_ENDS_BEFORE_START";
  const froms = new Set<string>();
  for (const s of scheme.slabs) {
    const from = dec(s.from);
    if (from.lte(0)) return "SCHEME_SLAB_FROM";
    if (froms.has(from.toFixed(3))) return "SCHEME_SLAB_TWICE";
    froms.add(from.toFixed(3));
    if (scheme.kind === "free_goods") {
      if (dec(s.freeQty ?? 0).lte(0)) return "SCHEME_SLAB_BENEFIT";
    } else {
      const percent = dec(s.discountPercent ?? 0);
      const perUnit = dec(s.discountPerUnit ?? 0);
      if (percent.isNegative() || perUnit.isNegative() || (percent.isZero() && perUnit.isZero())) return "SCHEME_SLAB_BENEFIT";
      if (percent.gt(100)) return "DISCOUNT_PERCENT_RANGE";
    }
  }
  return null;
}
