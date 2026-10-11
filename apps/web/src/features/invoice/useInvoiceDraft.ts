import {
  addDays,
  applySchemes,
  calculateDocument,
  determineSupplyType,
  DomainError,
  evaluateCredit,
  NO_TAX,
  dec,
  pct,
  resolveTax,
  roundAmount,
  roundRate,
  schemeCovers,
  stateTaxComponent,
  suggestProducts,
  buildReorderList,
  type DocumentTotals,
  type PaymentMethod,
  type Suggestion,
  type ReorderRow,
  type CreditCheck,
  type PartyGstRegistration,
  type SuggestionProduct,
  type SchemeLine,
  type SchemeRule,
  type ZeroRatedKind,
  type ZeroRatedType,
  zeroRatedKindFor,
  zeroRatedTypeOf,
} from "@digitalbahi/core";
import { useCallback, useMemo, useReducer, useRef, type Dispatch } from "react";
import { BUSINESS, customerById, PRODUCTS, productById, SCHEMES, TODAY, WORKSPACE } from "../../data/db";
import { useCustomerInsight } from "../../data/hooks";
import { storeAssociations, useStoreVersion, type CustomerInsight } from "../../data/store";
import type { Customer, Product } from "../../data/types";
import { useSuggestionFeedback, type SuggestionFeedback } from "./suggestionFeedback";
import { saleUnits, startUnit, unitByLetter } from "./units";
import { unitForWord } from "../../lib/spoken";

export interface DraftLine {
  key: string;
  productId: string;
  /** The unit sold in: null for the stock unit, else one of the product's packs (box, strip). */
  unitId: string | null;
  qty: number;
  /** Given free on the scheme (10+1), in the line's unit: moves stock, carries no value. */
  freeQty: number;
  rate: number;
  discountPercent: number;
}

export interface Draft {
  customerId: string | null;
  date: string;
  lines: DraftLine[];
  received: string;
  method: PaymentMethod;
  /** Line to focus after an add (qty field). */
  focusKey: string | null;
  /** Export or supply to SEZ: paying IGST or not (null = under the LUT while it is valid), and the shipping bill. */
  zeroRated: ZeroRatedChoice;
  /** Trade schemes left off this bill (the customer is not given them). */
  declinedSchemes: string[];
}

export interface ZeroRatedChoice {
  withPayment: boolean | null;
  shippingBillNumber: string;
  shippingBillDate: string;
  portCode: string;
}

type Action =
  | { type: "customer"; customerId: string | null }
  /** `spoken`: the quantity and unit word said with the name (voice search), in that unit when the product is sold in it. */
  | { type: "add"; productId: string; qty?: number; spoken?: { qty: number; unit: string | null; letter?: string | null }; pick?: { unitId: string | null; qty: number } }
  /** An out-of-stock line swapped for another product: the same count, in a unit of the same name when it has one. */
  | { type: "replace"; key: string; productId: string }
  | { type: "update"; key: string; patch: Partial<Omit<DraftLine, "key" | "productId" | "unitId">> }
  | { type: "unit"; key: string; unitId: string | null }
  | { type: "remove"; key: string }
  /** Undo of a remove: the line back where it was (`customerId`: the bill's customer when it was taken off). */
  | { type: "unremove"; line: DraftLine; index: number; customerId: string | null }
  | { type: "received"; value: string }
  | { type: "method"; value: PaymentMethod }
  | { type: "focused" }
  | { type: "zeroRated"; patch: Partial<ZeroRatedChoice> }
  /** A trade scheme given on this bill again (on) or left off it. */
  | { type: "scheme"; schemeId: string; on: boolean }
  | { type: "reset"; customerId?: string | null }
  /** A bill left half made, brought back (see keptDraft). */
  | { type: "restore"; draft: Omit<Draft, "focusKey"> };

let lineSeq = 0;

/**
 * The customer's rate-list price, exactly as the server prices it: the price
 * for the customer's rate list (else the default list), else the product's
 * selling price.
 */
export function rateFor(product: Product, customer: Customer | null, unitId: string | null = null): number {
  const factor = factorOf(product, unitId);
  const level = customer?.priceLevelId ?? WORKSPACE.defaultPriceLevelId;
  let base: number;
  if (product.prices) {
    // A pack's own price on the rate list, else the list's price for the stock unit times the pack.
    const own = unitId && level ? product.unitPrices?.[`${level}|${unitId}`] : undefined;
    if (own !== undefined) return own;
    base = (level ? product.prices[level] : undefined) ?? product.rate;
  } else base = customer?.priceLevel === "wholesale" ? product.wholesaleRate : product.rate;
  return factor === 1 ? base : roundRate(dec(base).times(factor)).toNumber();
}

function discountFor(product: Product, customer: Customer | null, unitId: string | null = null): number {
  if (product.discounts) {
    const level = customer?.priceLevelId ?? WORKSPACE.defaultPriceLevelId;
    const own = unitId && level ? product.unitDiscounts?.[`${level}|${unitId}`] : undefined;
    return own ?? (level ? product.discounts[level] : undefined) ?? 0;
  }
  return customer?.priceLevel === "wholesale" ? 2 : 0;
}

/** How many stock units the line's unit holds (1 for the stock unit). */
export function factorOf(product: Product, unitId: string | null): number {
  if (!unitId || unitId === product.unitId) return 1;
  return product.packUnits?.find((u) => u.unitId === unitId)?.factor ?? 1;
}

/** The symbol of the line's unit (PCS, BOX, STRIP). */
export function unitSymbolOf(product: Product, unitId: string | null): string {
  if (!unitId || unitId === product.unitId) return product.unit;
  return product.packUnits?.find((u) => u.unitId === unitId)?.symbol ?? product.unit;
}

function reducer(state: Draft, action: Action): Draft {
  switch (action.type) {
    case "customer": {
      const customer = action.customerId ? customerById.get(action.customerId) ?? null : null;
      // Re-price existing lines to the new customer's rate list.
      const lines = state.lines.map((l) => ({ ...l, rate: rateFor(productById.get(l.productId)!, customer, l.unitId) }));
      return { ...state, customerId: action.customerId, lines };
    }
    case "add": {
      const product = productById.get(action.productId)!;
      // In the unit new lines start in (strips of a product sold by the strip); a suggested quantity, counted
      // in the product's own unit, only when it is whole packs of it (20 tablets: 2 strips of 10).
      const start = startUnit(product);
      const units = saleUnits(product);
      const said = action.spoken ? (action.spoken.letter ? unitByLetter(units, null, action.spoken.letter) : unitForWord(units, action.spoken.unit)) : undefined;
      const inStart = !action.spoken && !action.pick && start !== null && (action.qty === undefined || action.qty % start.factor === 0);
      const unitId = action.pick ? action.pick.unitId : said ? said.unitId : inStart ? start.unitId : action.spoken ? (start?.unitId ?? null) : null;
      const qty = action.pick ? action.pick.qty : action.spoken ? action.spoken.qty : inStart && action.qty !== undefined ? action.qty / start.factor : (action.qty ?? 1);
      // Another scan or suggestion of the same product adds to its line in that unit.
      const existing = state.lines.find((l) => l.productId === action.productId && l.unitId === unitId);
      if (existing) {
        return {
          ...state,
          lines: state.lines.map((l) => (l.key === existing.key ? { ...l, qty: l.qty + qty } : l)),
          focusKey: existing.key,
        };
      }
      const customer = state.customerId ? customerById.get(state.customerId) ?? null : null;
      lineSeq += 1;
      const key = `l${lineSeq}`;
      return {
        ...state,
        lines: [...state.lines, { key, productId: product.id, unitId, qty, freeQty: 0, rate: rateFor(product, customer, unitId), discountPercent: discountFor(product, customer, unitId) }],
        focusKey: key,
      };
    }
    case "update":
      return { ...state, lines: state.lines.map((l) => (l.key === action.key ? { ...l, ...action.patch } : l)) };
    case "unit": {
      // Another unit: the same count in that unit, at that unit's price for this customer.
      const customer = state.customerId ? customerById.get(state.customerId) ?? null : null;
      return {
        ...state,
        lines: state.lines.map((l) => {
          if (l.key !== action.key) return l;
          const p = productById.get(l.productId)!;
          const unitId = action.unitId && action.unitId !== p.unitId ? action.unitId : null;
          return { ...l, unitId, rate: rateFor(p, customer, unitId), discountPercent: discountFor(p, customer, unitId) };
        }),
      };
    }
    case "replace": {
      const customer = state.customerId ? customerById.get(state.customerId) ?? null : null;
      const product = productById.get(action.productId)!;
      return {
        ...state,
        lines: state.lines.map((l) => {
          if (l.key !== action.key) return l;
          const was = unitSymbolOf(productById.get(l.productId)!, l.unitId);
          const unitId = saleUnits(product).find((u) => u.symbol === was)?.unitId ?? null;
          return { ...l, productId: product.id, unitId, rate: rateFor(product, customer, unitId), discountPercent: discountFor(product, customer, unitId) };
        }),
      };
    }
    case "remove":
      return { ...state, lines: state.lines.filter((l) => l.key !== action.key) };
    case "unremove": {
      const { line } = action;
      const product = productById.get(line.productId);
      // Back on the bill meanwhile (added again in that unit): it stays as it is, not twice.
      if (!product || state.lines.some((l) => l.key === line.key || (l.productId === line.productId && l.unitId === line.unitId))) return state;
      // Another customer chosen since: at that customer's price, as the bill's other lines were re-priced.
      const customer = state.customerId ? customerById.get(state.customerId) ?? null : null;
      const back = state.customerId === action.customerId ? line : { ...line, rate: rateFor(product, customer, line.unitId) };
      const lines = [...state.lines];
      lines.splice(Math.min(action.index, lines.length), 0, back);
      return { ...state, lines };
    }
    case "received":
      return { ...state, received: action.value };
    case "method":
      return { ...state, method: action.value };
    case "focused":
      return { ...state, focusKey: null };
    case "zeroRated":
      return { ...state, zeroRated: { ...state.zeroRated, ...action.patch } };
    case "scheme": {
      const others = state.declinedSchemes.filter((id) => id !== action.schemeId);
      return { ...state, declinedSchemes: action.on ? others : [...others, action.schemeId] };
    }
    case "reset":
      return initialDraft(action.customerId ?? null);
    case "restore": {
      // Products and customers since removed drop out; the bill is for today, as a new one is.
      const kept = action.draft;
      const lines = kept.lines
        .filter((l) => productById.has(l.productId))
        .map((l) => {
          lineSeq += 1;
          return { ...l, key: `l${lineSeq}`, freeQty: l.freeQty ?? 0 };
        });
      return {
        ...initialDraft(kept.customerId && customerById.has(kept.customerId) ? kept.customerId : null),
        lines,
        received: kept.received,
        method: kept.method,
        zeroRated: kept.zeroRated,
        // Kept before schemes came: none left off.
        declinedSchemes: kept.declinedSchemes ?? [],
      };
    }
  }
}

function initialDraft(customerId: string | null): Draft {
  return { customerId, date: TODAY, lines: [], received: "", method: "cash", focusKey: null, zeroRated: { withPayment: null, shippingBillNumber: "", shippingBillDate: "", portCode: "" }, declinedSchemes: [] };
}

/**
 * A line as it is billed: a line of the draft with the scheme discount it
 * earned, or goods a scheme gives free (their own line, in the stock unit,
 * at 100% off).
 */
export interface BillLine extends DraftLine {
  /** Rupees off under a scheme, besides the line's own discount. */
  schemeDiscount: number;
  schemeId: string | null;
  free: boolean;
}

/** How much more of a scheme's products earns more, said under a line. */
export interface SchemeNudge {
  schemeId: string;
  name: string;
  /** More needed: stock units (unit given) or rupees. */
  short: number;
  unit: string | null;
  /** What it earns then: goods free (a product's name when another product), or a discount. */
  freeQty?: number;
  freeProduct?: string | null;
  percent?: number;
  perUnit?: number;
}

export interface BillSchemes {
  /** The scheme discount on each line of the draft, by its key. */
  discounts: Map<string, { schemeId: string; name: string; amount: number }>;
  /** Goods given free (the bill's last lines). */
  free: BillLine[];
  nudges: Map<string, SchemeNudge[]>;
  /** Schemes this bill earns that were left off it. */
  declined: Array<{ id: string; name: string }>;
  /** Scheme names by id (for the free lines). */
  names: Map<string, string>;
  /** Rupees the customer gets: scheme discounts plus free goods at their rate. */
  saved: number;
}

const NO_SCHEMES: BillSchemes = { discounts: new Map(), free: [], nudges: new Map(), declined: [], names: new Map(), saved: 0 };

/**
 * What the bill earns under the business's schemes, worked out from exactly
 * what will be sent (quantities to 3 decimals, rates to 4, discounts to 2),
 * so the server, running the same engine, finds the same.
 */
export function billSchemes(draft: Pick<Draft, "lines" | "date" | "declinedSchemes">, customer: Customer | null, schemes: ReadonlyArray<SchemeRule & { name: string }> = SCHEMES): { lines: BillLine[]; schemes: BillSchemes } {
  const plain = draft.lines.map((l): BillLine => ({ ...l, schemeDiscount: 0, schemeId: null, free: false }));
  if (!schemes.length || !draft.lines.length) return { lines: plain, schemes: NO_SCHEMES };
  const input: SchemeLine[] = draft.lines.flatMap((l) => {
    const p = productById.get(l.productId);
    if (!p) return [];
    const qty = dec(Math.max(0, l.qty).toFixed(3));
    const gross = roundAmount(qty.times(dec(Math.max(0, l.rate).toFixed(4))));
    const discount = Math.min(100, Math.max(0, l.discountPercent || 0)).toFixed(2);
    return [{ key: l.key, productId: p.id, brandId: p.brandId || null, categoryId: p.categoryId ?? null, qtyBase: qty.times(factorOf(p, l.unitId)), value: gross.minus(roundAmount(pct(gross, discount))) }];
  });
  const result = applySchemes({
    date: draft.date,
    customer: customer ? { categoryId: customer.categoryId ?? null, priceLevelId: customer.priceLevelId ?? WORKSPACE.defaultPriceLevelId } : null,
    lines: input,
    schemes,
    declined: draft.declinedSchemes,
    unitValue: (id) => {
      const p = productById.get(id);
      return p ? rateFor(p, customer, null) : null;
    },
  });
  const names = new Map(schemes.map((x) => [x.id, x.name]));
  const discounts = new Map([...result.discountByLine].map(([key, d]) => [key, { schemeId: d.schemeId, name: names.get(d.schemeId) ?? "", amount: d.amount.toNumber() }]));
  const lines = plain.map((l) => {
    const d = discounts.get(l.key);
    return d ? { ...l, schemeDiscount: d.amount, schemeId: d.schemeId } : l;
  });
  const free = result.free.flatMap((f): BillLine[] => {
    const p = productById.get(f.productId);
    if (!p) return [];
    return [{ key: `free:${f.schemeId}:${f.productId}`, productId: p.id, unitId: null, qty: f.qty.toNumber(), freeQty: 0, rate: rateFor(p, customer, null), discountPercent: 100, schemeDiscount: 0, schemeId: f.schemeId, free: true }];
  });
  // Said under the bill's last line of the scheme's products, once the bill is half way to more.
  const nudges = new Map<string, SchemeNudge[]>();
  for (const h of result.hints) {
    if (h.short.gt(h.measure)) continue;
    const covered = input.filter((l) => (h.productId ? l.productId === h.productId : schemeCovers(h.scheme, l)));
    const last = covered[covered.length - 1];
    if (!last) continue;
    const slab = h.scheme.slabs[h.slab]!;
    const at = h.measure.plus(h.short);
    const nudge: SchemeNudge = {
      schemeId: h.scheme.id,
      name: names.get(h.scheme.id) ?? "",
      short: h.short.toNumber(),
      unit: h.scheme.measure === "qty" ? (productById.get(last.productId)?.unit ?? null) : null,
    };
    if (h.scheme.kind === "free_goods") {
      const from = dec(slab.from);
      nudge.freeQty = (h.scheme.repeat ? at.dividedToIntegerBy(from) : dec(1)).times(dec(slab.freeQty ?? 0)).toNumber();
      const freeId = h.scheme.freeProductId ?? h.productId;
      nudge.freeProduct = freeId && freeId !== last.productId ? (productById.get(freeId)?.name ?? null) : null;
    } else {
      if (slab.discountPercent) nudge.percent = Number(slab.discountPercent);
      if (slab.discountPerUnit) nudge.perUnit = Number(slab.discountPerUnit);
    }
    nudges.set(last.key, [...(nudges.get(last.key) ?? []), nudge]);
  }
  const declined = result.available.filter((x) => draft.declinedSchemes.includes(x.id)).map((x) => ({ id: x.id, name: names.get(x.id) ?? "" }));
  const saved = [...discounts.values()].reduce((a, d) => a + d.amount, 0) + free.reduce((a, f) => a + f.qty * f.rate, 0);
  return { lines: [...lines, ...free], schemes: { discounts, free, nudges, declined, names, saved } };
}

/**
 * The bill's lines as POST /invoices takes them: rates and discounts as
 * shown; goods a scheme gives free as their own lines at 100% off; each
 * scheme discount with the scheme that gave it (the server checks the bill
 * earned it).
 */
export function bodyLines(lines: readonly BillLine[]) {
  return lines.map((l) => ({
    productId: l.productId,
    ...(l.unitId ? { unitId: l.unitId } : {}),
    qty: l.qty.toFixed(3),
    ...(l.freeQty > 0 ? { freeQty: l.freeQty.toFixed(3) } : {}),
    rate: l.rate.toFixed(4),
    discountPercent: l.free ? "100.00" : Math.min(100, Math.max(0, l.discountPercent || 0)).toFixed(2),
    ...(l.free && l.schemeId ? { scheme: { id: l.schemeId, free: true } } : {}),
    ...(!l.free && l.schemeId && l.schemeDiscount > 0 ? { scheme: { id: l.schemeId, discount: l.schemeDiscount.toFixed(2) } } : {}),
  }));
}

/** Under the LUT (no IGST) by default while it is valid on the invoice date, as the server decides. */
export function lutValidOn(day: string): boolean {
  return WORKSPACE.lut !== null && WORKSPACE.lut.validUntil >= day;
}

/** The body's `zeroRated` part: the choice made, and the shipping bill for an export when given. */
export function zeroRatedBody(view: DraftView) {
  const z = view.zeroRated;
  if (!z) return {};
  const c = view.draft.zeroRated;
  return {
    zeroRated: {
      withPayment: z.withPayment,
      ...(z.kind === "export" && c.shippingBillNumber.trim() ? { shippingBillNumber: c.shippingBillNumber.trim() } : {}),
      ...(z.kind === "export" && c.shippingBillDate ? { shippingBillDate: c.shippingBillDate } : {}),
      ...(z.kind === "export" && c.portCode.trim() ? { portCode: c.portCode.trim().toUpperCase() } : {}),
    },
  };
}


export interface DraftView {
  draft: Draft;
  dispatch: Dispatch<Action>;
  /** The bill as it is billed and saved: the draft's lines with their scheme discounts, then goods given free. */
  billLines: BillLine[];
  schemes: BillSchemes;
  customer: Customer | null;
  insight: CustomerInsight | null;
  totals: DocumentTotals | null;
  error: DomainError | null;
  supplyType: "intra_state" | "inter_state";
  stateComponent: "SGST" | "UTGST";
  suggestions: Suggestion[];
  reorder: ReorderRow[];
  credit: CreditCheck | null;
  dueDate: string;
  /** An export or supply to SEZ (zero-rated), and whether IGST is paid on it; null for other sales. */
  zeroRated: { kind: ZeroRatedKind; withPayment: boolean; type: ZeroRatedType } | null;
  /** What the suggestions offered and what was taken, sent with the saved bill. */
  feedback: SuggestionFeedback;
  /**
   * Which bill this is on the screen: one more with each reset (saved, put on hold) and each bill
   * brought back, so an Undo offered for one bill does nothing to the next.
   */
  bill: { readonly current: number };
}

export function useInvoiceDraft(initialCustomerId: string | null = null): DraftView {
  const [draft, apply] = useReducer(reducer, initialCustomerId, initialDraft);
  const bill = useRef(0);
  const dispatch = useCallback<Dispatch<Action>>((action) => {
    if (action.type === "reset" || action.type === "restore") bill.current += 1;
    apply(action);
  }, []);
  const version = useStoreVersion();
  const customer = draft.customerId ? customerById.get(draft.customerId) ?? null : null;
  const insight = useCustomerInsight(customer?.id ?? null);
  const feedback = useSuggestionFeedback(customer?.id ?? null);
  // Only a regular registrant makes zero-rated supplies; an export's place of supply is abroad (96).
  const zeroRatedKind = WORKSPACE.chargeTax ? zeroRatedKindFor(customer?.gstRegistration) : null;
  const withPayment = draft.zeroRated.withPayment ?? !lutValidOn(draft.date);
  const zeroRated = zeroRatedKind ? { kind: zeroRatedKind, withPayment, type: zeroRatedTypeOf(zeroRatedKind, withPayment) } : null;
  const withoutPayment = zeroRated !== null && !zeroRated.withPayment;
  const placeOfSupply = zeroRatedKind === "export" ? "96" : (customer?.stateCode ?? BUSINESS.stateCode);
  const supplyType = determineSupplyType({
    supplierStateCode: BUSINESS.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
    ...(customer?.gstRegistration ? { recipientRegistration: customer.gstRegistration as PartyGstRegistration } : {}),
  });
  const suggestionProducts = useMemo<Map<string, SuggestionProduct>>(
    () => new Map(PRODUCTS.map((p) => [p.id, { id: p.id, name: p.name, active: p.active ?? true, stockQty: p.stock, minStock: p.minStock, orderMultiple: p.caseSize }])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const billed = useMemo(
    () => billSchemes(draft, customer),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.lines, draft.date, draft.declinedSchemes, customer, version],
  );

  const { totals, error } = useMemo(() => {
    if (draft.lines.length === 0) return { totals: null, error: null };
    try {
      // Same inputs as the server (rules, round-off, registration), so the totals shown are the totals posted.
      const t = calculateDocument({
        supplyType,
        chargeTax: WORKSPACE.chargeTax,
        withoutPayment,
        roundOff: WORKSPACE.roundOff,
        amountPaid: draft.received.trim() === "" ? 0 : Number(draft.received) || 0,
        lines: billed.lines.map((l) => {
          const p = productById.get(l.productId)!;
          const factor = factorOf(p, l.unitId);
          // Value-based GST slabs look at the price of one stock unit, as the server does.
          const tax =
            p.taxCategory.kind === "taxable"
              ? resolveTax(p.taxCategory, { date: draft.date, unitValue: dec(l.rate).dividedBy(factor), unitValueIncludesTax: Boolean(p.pricesIncludeTax) })
              : { ...NO_TAX, kind: p.taxCategory.kind };
          return {
            key: l.key,
            qty: l.qty > 0 ? l.qty : 0.001,
            rate: l.rate >= 0 ? l.rate : 0,
            rateIncludesTax: Boolean(p.pricesIncludeTax),
            discountPercent: Math.min(100, Math.max(0, l.discountPercent || 0)),
            discountAmount: l.schemeDiscount,
            conversionFactor: factor,
            tax,
            hsnCode: p.hsn,
            uqc: p.uqc,
          };
        }),
      });
      return { totals: t, error: null };
    } catch (e) {
      return { totals: null, error: e instanceof DomainError ? e : new DomainError("generic", String(e)) };
    }
  }, [billed, draft.lines.length, draft.received, draft.date, supplyType, withoutPayment]);

  const suggestions = useMemo(() => {
    if (!insight) return [];
    return suggestProducts(
      {
        asOf: TODAY,
        summary: insight.summary,
        stats: insight.stats,
        associations: insight.storeAssociations ?? storeAssociations(),
        customerAssociations: insight.customerAssociations,
        cartProductIds: draft.lines.map((l) => l.productId),
        products: suggestionProducts,
      },
      { limit: 24, ...(WORKSPACE.suggestionWeights ? { weights: WORKSPACE.suggestionWeights } : {}) },
    );
  }, [insight, draft.lines, suggestionProducts]);

  const reorder = useMemo(() => (insight ? buildReorderList({ stats: insight.stats, products: suggestionProducts }) : []), [insight, suggestionProducts]);

  const credit = useMemo(() => {
    if (!customer || !insight || !totals) return null;
    return evaluateCredit({
      creditLimit: customer.creditLimit ? String(customer.creditLimit) : null,
      outstanding: insight.outstanding.toFixed(2),
      newAmount: totals.balanceDue,
      openDocuments: insight.openInvoices.map((i) => ({ id: i.id, number: i.number, date: i.date, dueDate: i.dueDate, balance: (i.total - i.paid).toFixed(2) })),
      asOf: TODAY,
      policy: WORKSPACE.creditPolicy,
    });
  }, [customer, insight, totals]);

  return {
    draft,
    dispatch,
    billLines: billed.lines,
    schemes: billed.schemes,
    customer,
    insight,
    totals,
    error,
    supplyType,
    stateComponent: stateTaxComponent(placeOfSupply),
    suggestions,
    reorder,
    credit,
    dueDate: addDays(draft.date, customer?.creditDays ?? 0),
    zeroRated,
    feedback,
    bill,
  };
}
