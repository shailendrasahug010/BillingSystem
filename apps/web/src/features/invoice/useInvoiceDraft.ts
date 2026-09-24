import {
  addDays,
  calculateDocument,
  DomainError,
  evaluateCredit,
  NO_TAX,
  resolveTax,
  stateTaxComponent,
  suggestProducts,
  buildReorderList,
  type DocumentTotals,
  type PaymentMethod,
  type Suggestion,
  type ReorderRow,
  type CreditCheck,
  type SuggestionProduct,
} from "@vyapaar/core";
import { useMemo, useReducer, type Dispatch } from "react";
import { BUSINESS, customerById, PRODUCTS, productById, TODAY } from "../../data/mock";
import { customerInsight, storeAssociations, type CustomerInsight } from "../../data/store";
import type { Customer, Product } from "../../data/types";

export interface DraftLine {
  key: string;
  productId: string;
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
}

type Action =
  | { type: "customer"; customerId: string | null }
  | { type: "add"; productId: string; qty?: number }
  | { type: "update"; key: string; patch: Partial<Omit<DraftLine, "key" | "productId">> }
  | { type: "remove"; key: string }
  | { type: "received"; value: string }
  | { type: "method"; value: PaymentMethod }
  | { type: "focused" }
  | { type: "reset"; customerId?: string | null };

let lineSeq = 0;

export function rateFor(product: Product, customer: Customer | null): number {
  return customer?.priceLevel === "wholesale" ? product.wholesaleRate : product.rate;
}

function reducer(state: Draft, action: Action): Draft {
  switch (action.type) {
    case "customer": {
      const customer = action.customerId ? customerById.get(action.customerId) ?? null : null;
      // Re-price existing lines to the new customer's rate list.
      const lines = state.lines.map((l) => ({ ...l, rate: rateFor(productById.get(l.productId)!, customer) }));
      return { ...state, customerId: action.customerId, lines };
    }
    case "add": {
      const existing = state.lines.find((l) => l.productId === action.productId);
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
        lines: [...state.lines, { key, productId: product.id, qty, rate: rateFor(product, customer), discountPercent: customer?.priceLevel === "wholesale" ? 2 : 0 }],
        focusKey: key,
      };
    }
    case "update":
      return { ...state, lines: state.lines.map((l) => (l.key === action.key ? { ...l, ...action.patch } : l)) };
    case "remove":
      return { ...state, lines: state.lines.filter((l) => l.key !== action.key) };
    case "received":
      return { ...state, received: action.value };
    case "method":
      return { ...state, method: action.value };
    case "focused":
      return { ...state, focusKey: null };
    case "reset":
      return initialDraft(action.customerId ?? null);
  }
}

function initialDraft(customerId: string | null): Draft {
  return { customerId, date: TODAY, lines: [], received: "", method: "cash", focusKey: null };
}

const suggestionProducts: Map<string, SuggestionProduct> = new Map(
  PRODUCTS.map((p) => [p.id, { id: p.id, name: p.name, active: true, stockQty: p.stock, minStock: p.minStock, orderMultiple: p.caseSize }]),
);

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
}

export function useInvoiceDraft(initialCustomerId: string | null = null): DraftView {
  const [draft, dispatch] = useReducer(reducer, initialCustomerId, initialDraft);
  const customer = draft.customerId ? customerById.get(draft.customerId) ?? null : null;
  const insight = useMemo(() => (customer ? customerInsight(customer.id) : null), [customer]);
  const placeOfSupply = customer?.stateCode ?? BUSINESS.stateCode;
  const supplyType = placeOfSupply === BUSINESS.stateCode ? "intra_state" : "inter_state";

  const { totals, error } = useMemo(() => {
    if (draft.lines.length === 0) return { totals: null, error: null };
    try {
      const t = calculateDocument({
        supplyType,
        chargeTax: true,
        amountPaid: draft.received.trim() === "" ? 0 : Number(draft.received) || 0,
        lines: draft.lines.map((l) => {
          const p = productById.get(l.productId)!;
          const tax =
            p.taxCategory.kind === "taxable"
              ? resolveTax(p.taxCategory, { date: draft.date, unitValue: l.rate })
              : { ...NO_TAX, kind: p.taxCategory.kind };
          return {
            key: l.key,
            qty: l.qty > 0 ? l.qty : 0.001,
            rate: l.rate >= 0 ? l.rate : 0,
            discountPercent: Math.min(100, Math.max(0, l.discountPercent || 0)),
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
  }, [draft.lines, draft.received, draft.date, supplyType]);

  const suggestions = useMemo(() => {
    if (!insight) return [];
    return suggestProducts(
      {
        asOf: TODAY,
        summary: insight.summary,
        stats: insight.stats,
        associations: storeAssociations(),
        customerAssociations: insight.customerAssociations,
        cartProductIds: draft.lines.map((l) => l.productId),
        products: suggestionProducts,
      },
      { limit: 24 },
    );
  }, [insight, draft.lines]);

  const reorder = useMemo(() => (insight ? buildReorderList({ stats: insight.stats, products: suggestionProducts }) : []), [insight]);

  const credit = useMemo(() => {
    if (!customer || !insight || !totals) return null;
    return evaluateCredit({
      creditLimit: customer.creditLimit ? String(customer.creditLimit) : null,
      outstanding: insight.outstanding.toFixed(2),
      newAmount: totals.balanceDue,
      openDocuments: insight.openInvoices.map((i) => ({ id: i.id, number: i.number, date: i.date, dueDate: i.dueDate, balance: (i.total - i.paid).toFixed(2) })),
      asOf: TODAY,
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
  };
}
