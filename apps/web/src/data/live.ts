import type { MeResponse } from "@vyapaar/contracts";
import {
  dec,
  resolveTax,
  type AssociationRule,
  type CustomerProductStats,
  type CustomerSummary,
  type PaymentBehaviour,
  type TaxCategory,
  type TaxRateRule,
} from "@vyapaar/core";
import { api, fetchAll } from "../lib/api";
import {
  BRANDS,
  BUSINESS,
  customerById,
  CUSTOMERS,
  productById,
  PRODUCTS,
  replaceAll,
  replaceMap,
  ROUTES,
  setToday,
  TODAY,
  WORKSPACE,
} from "./db";
import { touch, type CustomerInsight } from "./store";
import type { Customer, Invoice, Product } from "./types";

// ---------------------------------------------------------------- API shapes (subset)

interface CatalogProduct {
  id: string;
  name: string;
  nameLocal: string | null;
  aliases: string[] | null;
  code: string;
  hsnCode: string | null;
  taxCategoryId: string;
  brandId: string | null;
  categoryId: string | null;
  baseUnitId: string;
  packSize: string | null;
  purchasePrice?: string;
  mrp: string | null;
  sellingPrice: string;
  pricesIncludeTax: boolean;
  minStock: string | null;
  isActive: boolean;
  barcodes: Array<{ barcode: string; unitId: string | null }>;
  units: Array<{ unitId: string; conversionFactor: string; isDefaultSale: boolean }>;
  prices: Array<{ priceLevelId: string; unitId: string; price: string; discountPercent: string }>;
  stock: string;
}

interface Catalog {
  products: CatalogProduct[];
  taxCategories: Array<{ id: string; name: string; kind: TaxCategory["kind"]; rules: Array<TaxRateRule & { gstRate: string }> }>;
  priceLevels: Array<{ id: string; name: string; isDefault: boolean }>;
  units: Array<{ id: string; symbol: string; uqc: string }>;
  brands: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string; parentId: string | null }>;
}

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  businessName: string | null;
  customerType: "b2b" | "b2c";
  mobile: string | null;
  city: string | null;
  gstin: string | null;
  balance: string;
  overdue: string;
  creditLimit: string | null;
  creditDays: number;
  routeId: string | null;
  stateCode: string;
  addressLine1: string | null;
  pincode: string | null;
  priceLevelId: string | null;
  categoryId: string | null;
  isActive: boolean;
}

// ---------------------------------------------------------------- mapping

function mapCustomer(c: CustomerRow, routeName: Map<string, string>): Customer {
  const level = WORKSPACE.priceLevels.find((l) => l.id === c.priceLevelId);
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    businessName: c.businessName ?? c.name,
    type: c.customerType,
    mobile: c.mobile ?? "",
    gstin: c.gstin,
    city: c.city ?? "",
    address: c.addressLine1 ?? "",
    stateCode: c.stateCode,
    pincode: c.pincode ?? "",
    creditLimit: c.creditLimit === null ? null : Number(c.creditLimit),
    creditDays: c.creditDays,
    category: "",
    route: c.routeId ? (routeName.get(c.routeId) ?? "") : "",
    salesRep: "",
    priceLevel: level?.name.toLowerCase() === "wholesale" ? "wholesale" : "retail",
    openingBalance: 0,
    priceLevelId: c.priceLevelId,
    gstRegistration: c.gstin ? "regular" : "consumer",
    balance: Number(c.balance),
    overdue: Number(c.overdue),
  };
}

function mapProduct(p: CatalogProduct, cat: Catalog, taxById: Map<string, TaxCategory>): Product {
  const unit = cat.units.find((u) => u.id === p.baseUnitId);
  const taxCategory = taxById.get(p.taxCategoryId) ?? { id: p.taxCategoryId, name: "?", kind: "taxable" as const, rules: [] };
  let gstRate = 0;
  if (taxCategory.kind === "taxable") {
    try {
      gstRate = resolveTax(taxCategory, { date: TODAY }).gstRate.toNumber();
    } catch {
      gstRate = 0;
    }
  }
  const base = p.prices.filter((x) => x.unitId === p.baseUnitId);
  const prices = Object.fromEntries(base.map((x) => [x.priceLevelId, Number(x.price)]));
  const discounts = Object.fromEntries(base.map((x) => [x.priceLevelId, Number(x.discountPercent)]));
  const wholesale = WORKSPACE.priceLevels.find((l) => l.name.toLowerCase() === "wholesale");
  const saleUnit = p.units.find((u) => u.isDefaultSale) ?? p.units[0];
  return {
    id: p.id,
    name: p.name,
    nameHi: p.nameLocal ?? p.name,
    code: p.code,
    barcode: (p.barcodes.find((b) => !b.unitId || b.unitId === p.baseUnitId) ?? p.barcodes[0])?.barcode ?? "",
    brandId: p.brandId ?? "",
    brand: cat.brands.find((b) => b.id === p.brandId)?.name ?? "",
    category: cat.categories.find((c) => c.id === p.categoryId)?.name ?? "",
    hsn: p.hsnCode ?? "",
    taxCategory,
    gstRate,
    unit: unit?.symbol ?? "",
    uqc: unit?.uqc ?? "NOS",
    packSize: p.packSize ?? "",
    caseSize: saleUnit ? Number(saleUnit.conversionFactor) : 1,
    mrp: Number(p.mrp ?? 0),
    rate: Number(p.sellingPrice),
    wholesaleRate: (wholesale && prices[wholesale.id]) || Number(p.sellingPrice),
    purchasePrice: Number(p.purchasePrice ?? 0),
    stock: Number(p.stock),
    minStock: Number(p.minStock ?? 0),
    aliases: p.aliases ?? [],
    barcodes: p.barcodes.map((b) => b.barcode),
    prices,
    discounts,
    pricesIncludeTax: p.pricesIncludeTax,
    active: p.isActive,
  };
}

// ---------------------------------------------------------------- hydration

/** Applies /me: business header, rules, permissions and the business calendar date. */
export function applyMe(me: MeResponse): void {
  const b = me.business!;
  setToday(me.today);
  Object.assign(BUSINESS, {
    name: b.tradeName ?? b.legalName,
    legalName: b.legalName,
    gstin: b.gstin ?? "",
    stateCode: b.stateCode,
    address: [b.addressLine1, b.addressLine2].filter(Boolean).join(", "),
    city: [b.city, b.pincode].filter(Boolean).join(" "),
    phone: b.phone ?? "",
    email: b.email ?? "",
  });
  const roundOff = me.settings["invoice.round_off"] as typeof WORKSPACE.roundOff | undefined;
  const creditPolicy = me.settings["credit.policy"] as typeof WORKSPACE.creditPolicy | undefined;
  Object.assign(WORKSPACE, {
    businessId: b.id,
    chargeTax: b.gstRegistration === "regular",
    permissions: new Set(me.permissions),
    printLocale: (me.settings["invoice.default_print_locale"] as string | undefined) ?? "en",
    role: b.role,
    ...(roundOff ? { roundOff } : {}),
    ...(creditPolicy ? { creditPolicy } : {}),
  });
}

/** Loads the catalogue snapshot and the customer list into the workspace. */
export async function hydrateWorkspace(me: MeResponse): Promise<void> {
  applyMe(me);
  const can = (p: string) => WORKSPACE.permissions?.has(p) ?? true;
  const [catalog, customers, routes] = await Promise.all([
    can("product.view") ? api.get<Catalog>("/catalog") : Promise.resolve(null),
    can("customer.view") ? fetchAll<CustomerRow>("/customers", { active: "true" }) : Promise.resolve([] as CustomerRow[]),
    can("customer.view") ? api.get<{ data: Array<{ id: string; name: string }> }>("/routes").then((r) => r.data) : Promise.resolve([]),
  ]);
  if (catalog) {
    WORKSPACE.priceLevels = catalog.priceLevels.map((l) => ({ id: l.id, name: l.name, isDefault: l.isDefault }));
    WORKSPACE.defaultPriceLevelId = catalog.priceLevels.find((l) => l.isDefault)?.id ?? null;
    const taxById = new Map<string, TaxCategory>(catalog.taxCategories.map((c) => [c.id, { id: c.id, name: c.name, kind: c.kind, rules: c.rules }]));
    const products = catalog.products.filter((p) => p.isActive).map((p) => mapProduct(p, catalog, taxById));
    replaceAll(PRODUCTS, products);
    replaceMap(productById, products.map((p) => [p.id, p]));
    replaceAll(BRANDS, catalog.brands.map((b) => ({ id: b.id, name: b.name })));
    replaceMap(WORKSPACE.units, catalog.units.map((u) => [u.id, u.symbol]));
  }
  const routeName = new Map(routes.map((r) => [r.id, r.name]));
  replaceAll(ROUTES, routes.map((r) => r.name));
  const mapped = customers.map((c) => mapCustomer(c, routeName));
  replaceAll(CUSTOMERS, mapped);
  replaceMap(customerById, mapped.map((c) => [c.id, c]));
  WORKSPACE.ready = true;
  touch();
}

/** Adds or refreshes one customer after it was created or edited. */
export function upsertCustomer(row: CustomerRow): Customer {
  const mapped = mapCustomer(row, new Map());
  const i = CUSTOMERS.findIndex((c) => c.id === row.id);
  if (i >= 0) CUSTOMERS[i] = mapped;
  else CUSTOMERS.push(mapped);
  customerById.set(mapped.id, mapped);
  touch();
  return mapped;
}

/** Stock moves with every invoice; keep the cached figure close without reloading the catalogue. */
export function adjustStock(productId: string, deltaBaseUnits: number): void {
  const p = productById.get(productId);
  if (p) p.stock = Math.round((p.stock + deltaBaseUnits) * 1000) / 1000;
}

export function resetWorkspace(): void {
  replaceAll(PRODUCTS, []);
  productById.clear();
  replaceAll(CUSTOMERS, []);
  customerById.clear();
  replaceAll(BRANDS, []);
  replaceAll(ROUTES, []);
  WORKSPACE.ready = false;
  WORKSPACE.permissions = new Set();
  touch();
}

// ---------------------------------------------------------------- customer insight

interface InsightResponse {
  summary: CustomerSummary;
  stats: Array<{
    productId: string;
    orderCount: number;
    orderShare: number;
    totalQty: string;
    avgQty: string;
    lastQty: string;
    lastRate: string | null;
    firstPurchasedOn: string;
    lastPurchasedOn: string;
    daysSinceLast: number;
    typicalIntervalDays: number | null;
    recentQtys: string[];
  }>;
  totalSales: string;
  invoiceCount: number;
  avgOrderValue: string;
  outstanding: string;
  overdue: string;
  overdueCount: number;
  oldestOverdueDays: number;
  lastPurchase: string | null;
  behaviour: { avgDaysToPay: number | null; onTimeRatio: number | null; rating: PaymentBehaviour };
  openInvoices: Array<{ id: string; number: string; date: string; dueDate: string; total: string; paid: string; balance: string }>;
  customerAssociations: AssociationRule[];
  storeAssociations: AssociationRule[];
}

export async function fetchInsight(customerId: string): Promise<CustomerInsight> {
  const r = await api.get<InsightResponse>(`/customers/${customerId}/insight`);
  const stats = new Map<string, CustomerProductStats>(
    r.stats.map((s) => [
      s.productId,
      {
        ...s,
        totalQty: dec(s.totalQty),
        avgQty: dec(s.avgQty),
        lastQty: dec(s.lastQty),
        lastRate: s.lastRate === null ? null : dec(s.lastRate),
        recentQtys: s.recentQtys.map((q) => dec(q)),
      },
    ]),
  );
  const openInvoices: Invoice[] = r.openInvoices.map((i) => ({
    id: i.id,
    number: i.number,
    date: i.date,
    dueDate: i.dueDate,
    customerId,
    lines: [],
    taxable: 0,
    tax: 0,
    total: Number(i.total),
    cost: 0,
    paid: Number(i.paid),
    settledOn: null,
  }));
  return {
    summary: r.summary,
    stats,
    totalSales: Number(r.totalSales),
    invoiceCount: r.invoiceCount,
    avgOrderValue: Number(r.avgOrderValue),
    outstanding: Number(r.outstanding),
    overdue: Number(r.overdue),
    overdueCount: r.overdueCount,
    oldestOverdueDays: r.oldestOverdueDays,
    lastPurchase: r.lastPurchase,
    behaviour: r.behaviour,
    openInvoices,
    customerAssociations: r.customerAssociations,
    storeAssociations: r.storeAssociations,
  };
}
