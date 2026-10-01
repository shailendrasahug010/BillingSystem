import { DEFAULT_CREDIT_POLICY, DEFAULT_ROUND_OFF, todayIn, type CreditPolicy, type RoundOffConfig } from "@digitalbahi/core";
import * as mock from "./mock";
import { LIVE } from "./source";
import type { Brand, Business, Customer, DayAmount, Invoice, Order, Payment, Product } from "./types";

/**
 * The working set every screen reads: the business, its catalogue and its
 * customers (what billing needs, also offline). In demo mode it is the
 * built-in sample data; in live mode it starts empty and is filled from the
 * API after sign-in (see live.ts). The containers are stable objects, so
 * modules can import them once and always see current data.
 */
export let TODAY: string = LIVE ? todayIn("Asia/Kolkata") : mock.TODAY;

export const BUSINESS: Business = LIVE
  ? { name: "", legalName: "", gstin: "", stateCode: "", address: "", city: "", phone: "", email: "", bank: { name: "", account: "", ifsc: "", upi: "" } }
  : mock.BUSINESS;

export const PRODUCTS: Product[] = LIVE ? [] : mock.PRODUCTS;
export const productById: Map<string, Product> = LIVE ? new Map() : mock.productById;
export const BRANDS: Brand[] = LIVE ? [] : mock.BRANDS;
export const CUSTOMERS: Customer[] = LIVE ? [] : mock.CUSTOMERS;
export const customerById: Map<string, Customer> = LIVE ? new Map() : mock.customerById;
export const ROUTES: string[] = LIVE ? [] : mock.ROUTES;
/** Demo only: the counter customer. Live businesses create their own "Cash sale" customer. */
export const WALK_IN_ID: string = LIVE ? "" : mock.WALK_IN_ID;

// Demo-only history (live screens read these from the API instead).
export const INVOICES: Invoice[] = LIVE ? [] : mock.INVOICES;
export const PAYMENTS: Payment[] = LIVE ? [] : mock.PAYMENTS;
export const ORDERS: Order[] = LIVE ? [] : mock.ORDERS;
export const PURCHASES_BY_DAY: DayAmount[] = LIVE ? [] : mock.PURCHASES_BY_DAY;
export const EXPENSES_BY_DAY: DayAmount[] = LIVE ? [] : mock.EXPENSES_BY_DAY;
export const PAYABLE_OUTSTANDING: number = LIVE ? 0 : mock.PAYABLE_OUTSTANDING;
export const NEXT_INVOICE_NUMBER: string = LIVE ? "" : mock.NEXT_INVOICE_NUMBER;
export const FY_SHORT: string = LIVE ? "" : mock.FY_SHORT;
export const invoiceTotals = mock.invoiceTotals;

/** Business rules and context that shape calculations (mirrors the server's settings). */
export const WORKSPACE = {
  ready: !LIVE,
  businessId: null as string | null,
  roundOff: DEFAULT_ROUND_OFF as RoundOffConfig,
  creditPolicy: DEFAULT_CREDIT_POLICY as CreditPolicy,
  /** False for composition / unregistered businesses (bill of supply). */
  chargeTax: true,
  defaultPriceLevelId: null as string | null,
  priceLevels: [] as Array<{ id: string; name: string; isDefault: boolean }>,
  /** null = everything allowed (demo). */
  permissions: null as Set<string> | null,
  printLocale: "en",
  /** E-invoicing applies (IRNs for B2B, SEZ and export bills). */
  einvoice: false,
  /** Value above which a bill needs an e-way bill. */
  ewayThreshold: 50000,
  /** Letter of undertaking for exports and supplies to SEZ without IGST (null = none). */
  lut: null as { arn: string; validUntil: string } | null,
  /** Terms printed on invoices ("" = none). */
  invoiceTerms: LIVE ? "" : "1. Goods once sold will be taken back only as per company return policy. 2. Interest @18% p.a. on payments beyond the due date. 3. Subject to Indore jurisdiction.",
  role: "admin",
  /** Unit id -> symbol (live catalogue). */
  units: new Map<string, string>(),
  /** Live catalogue masters used by editors. */
  unitList: [] as Array<{ id: string; symbol: string; name: string }>,
  /** `rate`: the GST % in force today (null when it cannot be resolved). */
  taxCategories: [] as Array<{ id: string; name: string; kind: string; rate?: number | null }>,
  categories: [] as Array<{ id: string; name: string }>,
  /** Godowns (live). */
  warehouses: [] as Array<{ id: string; name: string; code: string; city: string | null; isDefault: boolean; isActive: boolean }>,
};

export interface Supplier {
  id: string;
  code: string;
  name: string;
  companyName: string | null;
  mobile: string | null;
  city: string | null;
  gstin: string | null;
  stateCode: string;
  gstRegistration: string;
  balance: number;
  creditDays: number;
}

/** Live only: suppliers (purchase entry and supplier payments search them locally). */
export const SUPPLIERS: Supplier[] = [];
export const supplierById = new Map<string, Supplier>();

export function setToday(date: string): void {
  TODAY = date;
}

/** Replaces the contents of a container in place. */
export function replaceAll<T>(target: T[], items: T[]): void {
  target.splice(0, target.length, ...items);
}

export function replaceMap<K, V>(target: Map<K, V>, entries: Iterable<[K, V]>): void {
  target.clear();
  for (const [k, v] of entries) target.set(k, v);
}

export function allowed(permission: string): boolean {
  if (!WORKSPACE.permissions) return true;
  return WORKSPACE.permissions.has(permission);
}
