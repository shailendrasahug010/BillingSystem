import {
  addDays,
  calculateDocument,
  determineSupplyType,
  DomainError,
  evaluateCredit,
  NO_TAX,
  dec,
  resolveTax,
  roundRate,
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
  type ZeroRatedKind,
  type ZeroRatedType,
  zeroRatedKindFor,
  zeroRatedTypeOf,
} from "@digitalbahi/core";
import { useMemo, useReducer, type Dispatch } from "react";
import { BUSINESS, customerById, PRODUCTS, productById, TODAY, WORKSPACE } from "../../data/db";
import { useCustomerInsight } from "../../data/hooks";
import { storeAssociations, useStoreVersion, type CustomerInsight } from "../../data/store";
import type { Customer, Product } from "../../data/types";
import { useSuggestionFeedback, type SuggestionFeedback } from "./suggestionFeedback";

export interface DraftLine {
  key: string;
  productId: string;
  /** The unit sold in: null for the stock unit, else one of the product's packs (box, strip). */
  unitId: string | null;
  qty: number;
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
}

export interface ZeroRatedChoice {
  withPayment: boolean | null;
  shippingBillNumber: string;
  shippingBillDate: string;
  portCode: string;
}

type Action =
  | { type: "customer"; customerId: string | null }
  | { type: "add"; productId: string; qty?: number }
  | { type: "update"; key: string; patch: Partial<Omit<DraftLine, "key" | "productId" | "unitId">> }
  | { type: "unit"; key: string; unitId: string | null }
  | { type: "remove"; key: string }
  | { type: "received"; value: string }
  | { type: "method"; value: PaymentMethod }
  | { type: "focused" }
  | { type: "zeroRated"; patch: Partial<ZeroRatedChoice> }
  | { type: "reset"; customerId?: string | null };

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
      // Another scan or suggestion of the same product adds to its line in the stock unit.
      const existing = state.lines.find((l) => l.productId === action.productId && l.unitId === null);
      const qty = action.qty ?? 1;
      if (existing) {
        return {
          ...state,
          lines: state.lines.map((l) => (l.key === existing.key ? { ...l, qty: l.qty + qty } : l)),
          focusKey: existing.key,
        };
      }
      const product = productById.get(action.productId)!;
      const customer = state.customerId ? customerById.get(state.customerId) ?? null : null;
      lineSeq += 1;
      const key = `l${lineSeq}`;
      return {
        ...state,
        lines: [...state.lines, { key, productId: product.id, unitId: null, qty, rate: rateFor(product, customer), discountPercent: discountFor(product, customer) }],
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
    case "remove":
      return { ...state, lines: state.lines.filter((l) => l.key !== action.key) };
    case "received":
      return { ...state, received: action.value };
    case "method":
      return { ...state, method: action.value };
    case "focused":
      return { ...state, focusKey: null };
    case "zeroRated":
      return { ...state, zeroRated: { ...state.zeroRated, ...action.patch } };
    case "reset":
      return initialDraft(action.customerId ?? null);
  }
}

function initialDraft(customerId: string | null): Draft {
  return { customerId, date: TODAY, lines: [], received: "", method: "cash", focusKey: null, zeroRated: { withPayment: null, shippingBillNumber: "", shippingBillDate: "", portCode: "" } };
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
}

export function useInvoiceDraft(initialCustomerId: string | null = null): DraftView {
  const [draft, dispatch] = useReducer(reducer, initialCustomerId, initialDraft);
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
        lines: draft.lines.map((l) => {
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
  }, [draft.lines, draft.received, draft.date, supplyType, withoutPayment]);

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
  };
}
