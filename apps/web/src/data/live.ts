import type { MeResponse } from "@digitalbahi/contracts";
import {
  dec,
  resolveTax,
  type AssociationRule,
  type CustomerProductStats,
  type CustomerSummary,
  type PaymentBehaviour,
  type TaxCategory,
  type TaxRateRule,
} from "@digitalbahi/core";
import { api, ApiError, fetchAll } from "../lib/api";
import { accessKey, applyPull, pageChanges, type FeedState, type PullPage } from "./feed";
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
  SUPPLIERS,
  supplierById,
  type Supplier,
  TODAY,
  WORKSPACE,
} from "./db";
import { touch, type CustomerInsight } from "./store";
import type { Customer, Invoice, Product } from "./types";

// ---------------------------------------------------------------- API shapes (subset)

export interface CatalogProduct {
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
  trackBatches: boolean;
  trackExpiry: boolean;
  barcodes: Array<{ barcode: string; unitId: string | null }>;
  units: Array<{ unitId: string; conversionFactor: string; isDefaultSale: boolean }>;
  prices: Array<{ priceLevelId: string; unitId: string; price: string; discountPercent: string }>;
  stock: string;
}

export interface Catalog {
  products: CatalogProduct[];
  taxCategories: Array<{ id: string; name: string; kind: TaxCategory["kind"]; rules: Array<TaxRateRule & { gstRate: string }> }>;
  priceLevels: Array<{ id: string; name: string; isDefault: boolean }>;
  units: Array<{ id: string; symbol: string; uqc: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string; parentId: string | null }>;
}

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  businessName: string | null;
  customerType: "b2b" | "b2c";
  /** regular, consumer, sez (an SEZ unit), overseas (a buyer abroad)… */
  gstRegistration?: string;
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
  /** Messages in this language (null: the business's); payment reminders stopped (when, by staff or a STOP reply). */
  messageLocale?: "en" | "hi" | null;
  remindersOptOut?: boolean;
  remindersOptOutAt?: string | null;
  remindersOptOutBy?: "staff" | "reply" | null;
  /** Edits are checked against it (If-Match), so one made offline cannot silently undo a later one. */
  version?: number;
}

/** The customers as the server sent them (all fields), for edits made on this device. */
const customerRows = new Map<string, CustomerRow>();
export const customerRow = (id: string) => customerRows.get(id);

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
    gstRegistration: c.gstRegistration ?? (c.gstin ? "regular" : "consumer"),
    balance: Number(c.balance),
    overdue: Number(c.overdue),
    messageLocale: c.messageLocale ?? null,
    remindersOptOut: c.remindersOptOut ?? false,
    remindersOptOutAt: c.remindersOptOutAt ?? null,
    remindersOptOutBy: c.remindersOptOutBy ?? null,
    ...(c.version !== undefined ? { version: c.version } : {}),
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
  const packs = p.prices.filter((x) => x.unitId !== p.baseUnitId);
  const unitPrices = Object.fromEntries(packs.map((x) => [`${x.priceLevelId}|${x.unitId}`, Number(x.price)]));
  const unitDiscounts = Object.fromEntries(packs.map((x) => [`${x.priceLevelId}|${x.unitId}`, Number(x.discountPercent)]));
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
    unitPrices,
    unitDiscounts,
    pricesIncludeTax: p.pricesIncludeTax,
    active: p.isActive,
    unitId: p.baseUnitId,
    packUnits: p.units.map((u) => ({ unitId: u.unitId, symbol: cat.units.find((x) => x.id === u.unitId)?.symbol ?? "", factor: Number(u.conversionFactor) })),
    trackBatches: p.trackBatches,
    trackExpiry: p.trackExpiry,
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
    logoFileId: b.logoFileId,
  });
  // Where customers pay, printed on invoices and receipts.
  const pay = me.settings["invoice.payment_details"] as { bankName: string; accountNumber: string; ifsc: string; upiId: string } | undefined;
  BUSINESS.bank = { name: pay?.bankName ?? "", account: pay?.accountNumber ?? "", ifsc: pay?.ifsc ?? "", upi: pay?.upiId ?? "" };
  const roundOff = me.settings["invoice.round_off"] as typeof WORKSPACE.roundOff | undefined;
  const creditPolicy = me.settings["credit.policy"] as typeof WORKSPACE.creditPolicy | undefined;
  Object.assign(WORKSPACE, {
    businessId: b.id,
    chargeTax: b.gstRegistration === "regular",
    permissions: new Set(me.permissions),
    printLocale: (me.settings["invoice.default_print_locale"] as string | undefined) ?? "en",
    invoiceTerms: (me.settings["invoice.terms"] as string | undefined) ?? "",
    lut: (me.settings["gst.lut"] as typeof WORKSPACE.lut | undefined) ?? null,
    einvoice: me.settings["einvoice.enabled"] === true,
    ewayThreshold: typeof me.settings["ewaybill.threshold"] === "number" ? me.settings["ewaybill.threshold"] : 50000,
    suggestionWeights: (me.settings["suggestions.weights"] as typeof WORKSPACE.suggestionWeights | undefined) ?? null,
    unitLetters: (me.settings["invoice.unit_letters"] as typeof WORKSPACE.unitLetters | undefined) ?? null,
    defaultUnit: (me.settings["invoice.default_unit"] as string | undefined) ?? null,
    role: b.role,
    ...(roundOff ? { roundOff } : {}),
    ...(creditPolicy ? { creditPolicy } : {}),
  });
}

const can = (p: string) => WORKSPACE.permissions?.has(p) ?? true;

function applyCatalog(catalog: Catalog): void {
  WORKSPACE.priceLevels = catalog.priceLevels.map((l) => ({ id: l.id, name: l.name, isDefault: l.isDefault }));
  WORKSPACE.defaultPriceLevelId = catalog.priceLevels.find((l) => l.isDefault)?.id ?? null;
  const taxById = new Map<string, TaxCategory>(catalog.taxCategories.map((c) => [c.id, { id: c.id, name: c.name, kind: c.kind, rules: c.rules }]));
  const products = catalog.products.filter((p) => p.isActive).map((p) => mapProduct(p, catalog, taxById));
  replaceAll(PRODUCTS, products);
  replaceMap(productById, products.map((p) => [p.id, p]));
  replaceAll(BRANDS, catalog.brands.map((b) => ({ id: b.id, name: b.name })));
  replaceMap(WORKSPACE.units, catalog.units.map((u) => [u.id, u.symbol]));
  WORKSPACE.unitList = catalog.units.map((u) => ({ id: u.id, symbol: u.symbol, name: u.name }));
  WORKSPACE.taxCategories = catalog.taxCategories.map((c) => {
    let rate: number | null = null;
    try {
      rate = resolveTax(taxById.get(c.id)!, { date: TODAY }).gstRate.toNumber();
    } catch {
      // A category with no rule in force today cannot be picked by rate.
    }
    return { id: c.id, name: c.name, kind: c.kind, rate };
  });
  WORKSPACE.categories = catalog.categories.map((c) => ({ id: c.id, name: c.name }));
}

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  companyName: string | null;
  mobile: string | null;
  city: string | null;
  gstin: string | null;
  stateCode: string;
  gstRegistration: string;
  balance: string;
  creditDays: number;
}

const mapSupplier = (s: SupplierRow): Supplier => ({ ...s, balance: Number(s.balance) });

/** Reloads the catalogue snapshot (after product edits, purchases or adjustments change prices, costs or stock). */
export async function refreshCatalog(): Promise<void> {
  if (!can("product.view")) return;
  applyCatalog(await api.get<Catalog>("/catalog"));
  touch();
}

export async function refreshSuppliers(): Promise<void> {
  if (!can("supplier.view")) return;
  const rows = (await fetchAll<SupplierRow>("/suppliers", { active: "true" })).map(mapSupplier);
  replaceAll(SUPPLIERS, rows);
  replaceMap(supplierById, rows.map((s) => [s.id, s]));
  touch();
}

/** Reloads the godown list (after one is added or changed). */
export async function refreshWarehouses(): Promise<void> {
  if (!can("product.view")) return;
  WORKSPACE.warehouses = (await api.get<{ data: typeof WORKSPACE.warehouses }>("/warehouses")).data;
  touch();
}

/** Reloads all customers and routes (after an import). */
export async function refreshCustomers(): Promise<void> {
  if (!can("customer.view")) return;
  const [customers, routes] = await Promise.all([
    fetchAll<CustomerRow>("/customers", { active: "true" }),
    api.get<{ data: Array<{ id: string; name: string }> }>("/routes").then((r) => r.data),
  ]);
  const routeName = new Map(routes.map((r) => [r.id, r.name]));
  replaceAll(ROUTES, routes.map((r) => r.name));
  const mapped = customers.map((c) => mapCustomer(c, routeName));
  replaceAll(CUSTOMERS, mapped);
  replaceMap(customerById, mapped.map((c) => [c.id, c]));
  replaceMap(customerRows, customers.map((c) => [c.id, c]));
  touch();
}

export interface ExpenseCategoryRow {
  id: string;
  name: string;
  nameHi: string | null;
  isSystem: boolean;
  isActive: boolean;
}

/** Expense categories, kept for entering expenses without a connection. */
export const EXPENSE_CATEGORIES: ExpenseCategoryRow[] = [];

/** Everything the app keeps in memory for a business: also saved on the device for offline use. */
export interface WorkspaceData {
  catalog: Catalog | null;
  customers: CustomerRow[];
  routes: Array<{ id: string; name: string }>;
  suppliers: SupplierRow[];
  warehouses: typeof WORKSPACE.warehouses;
  /** Absent in copies saved before expenses could be entered offline. */
  expenseCategories?: ExpenseCategoryRow[];
}

async function fetchWorkspace(): Promise<WorkspaceData> {
  const [catalog, customers, routes, suppliers, warehouses, expenseCategories] = await Promise.all([
    can("product.view") ? api.get<Catalog>("/catalog") : Promise.resolve(null),
    can("customer.view") ? fetchAll<CustomerRow>("/customers", { active: "true" }) : Promise.resolve([] as CustomerRow[]),
    can("customer.view") ? api.get<{ data: Array<{ id: string; name: string }> }>("/routes").then((r) => r.data) : Promise.resolve([]),
    can("supplier.view") ? fetchAll<SupplierRow>("/suppliers", { active: "true" }) : Promise.resolve([] as SupplierRow[]),
    can("product.view") ? api.get<{ data: typeof WORKSPACE.warehouses }>("/warehouses").then((r) => r.data) : Promise.resolve([]),
    can("expense.view") ? api.get<{ data: ExpenseCategoryRow[] }>("/expense-categories").then((r) => r.data) : Promise.resolve([] as ExpenseCategoryRow[]),
  ]);
  return { catalog, customers, routes, suppliers, warehouses, expenseCategories };
}

/** Puts workspace data (fresh from the server, or saved on the device) in place. */
export function applyWorkspace(data: WorkspaceData): void {
  WORKSPACE.warehouses = data.warehouses;
  replaceAll(EXPENSE_CATEGORIES, data.expenseCategories ?? []);
  if (data.catalog) applyCatalog(data.catalog);
  const routeName = new Map(data.routes.map((r) => [r.id, r.name]));
  replaceAll(ROUTES, data.routes.map((r) => r.name));
  const mapped = data.customers.map((c) => mapCustomer(c, routeName));
  replaceAll(CUSTOMERS, mapped);
  replaceMap(customerById, mapped.map((c) => [c.id, c]));
  replaceMap(customerRows, data.customers.map((c) => [c.id, c]));
  const supplierRows = data.suppliers.map(mapSupplier);
  replaceAll(SUPPLIERS, supplierRows);
  replaceMap(supplierById, supplierRows.map((s) => [s.id, s]));
  WORKSPACE.ready = true;
  touch();
}

/** Loads the business from the server; returns what it loaded so it can be kept on the device. */
export async function hydrateWorkspace(me: MeResponse): Promise<WorkspaceData> {
  return (await loadWorkspace(me)).data;
}

/** The business as kept on the device, with where its pull feed stopped. */
export interface KeptWorkspace {
  data: WorkspaceData;
  feed?: FeedState;
}

/**
 * Brings the business up to date and puts it in place: with only what
 * changed (the pull feed) when the device has a copy loaded for the same
 * access, else everything (after taking a cursor, so nothing that changes
 * during the load is missed). Returns what to keep on the device.
 */
export async function loadWorkspace(me: MeResponse, kept?: KeptWorkspace): Promise<Required<Pick<KeptWorkspace, "data">> & KeptWorkspace> {
  applyMe(me);
  const access = accessKey(me.permissions);
  const pulled = kept?.feed && kept.feed.access === access ? await pullWorkspace(kept) : null;
  if (pulled) {
    applyWorkspace(pulled.data);
    return pulled;
  }
  let start: PullPage | null = null;
  try {
    start = await api.get<PullPage>("/sync/pull");
  } catch (e) {
    // A server without the feed: the copy is loaded whole every time, as before.
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
  const data = await fetchWorkspace();
  applyWorkspace(data);
  return { data, ...(start ? { feed: { cursor: start.cursor, ...(start.listsHash ? { listsHash: start.listsHash } : {}), access } } : {}) };
}

const PULL_NOW = "digitalbahi:pull";
/** Asks for what others changed now rather than at the next round (a notification about such a change came in). */
export const requestPull = () => window.dispatchEvent(new Event(PULL_NOW));
/** Runs `fn` when a pull is asked for; returns a function that stops listening. */
export function onPullRequest(fn: () => void): () => void {
  window.addEventListener(PULL_NOW, fn);
  return () => window.removeEventListener(PULL_NOW, fn);
}

/**
 * What changed since the device's copy, applied to it (not put in place).
 * Null when it cannot be brought up to date that way (no feed, a cursor too
 * old or not understood): the caller loads everything.
 */
export async function pullWorkspace(kept: KeptWorkspace): Promise<(KeptWorkspace & { changed: boolean }) | null> {
  if (!kept.feed) return null;
  let { data, feed } = kept as Required<KeptWorkspace>;
  let changed = false;
  for (;;) {
    let page: PullPage;
    try {
      page = await api.get<PullPage>("/sync/pull", { cursor: feed.cursor, lists: feed.listsHash });
    } catch (e) {
      if (e instanceof ApiError && (e.code === "INVALID_CURSOR" || e.status === 404)) return null;
      throw e;
    }
    if (page.reset) return null;
    if (pageChanges(page)) {
      data = applyPull(data, page);
      changed = true;
    }
    feed = { ...feed, cursor: page.cursor, ...(page.listsHash ? { listsHash: page.listsHash } : {}) };
    if (!page.more) return { data, feed, changed };
  }
}

/** Adds or refreshes one supplier after it was created or edited. */
export function upsertSupplier(row: SupplierRow): Supplier {
  const mapped = mapSupplier(row);
  const i = SUPPLIERS.findIndex((x) => x.id === row.id);
  if (i >= 0) SUPPLIERS[i] = mapped;
  else SUPPLIERS.push(mapped);
  supplierById.set(mapped.id, mapped);
  touch();
  return mapped;
}

/** Re-reads one supplier's cached balance after a purchase or payment. */
export async function refreshSupplier(id: string): Promise<void> {
  upsertSupplier(await api.get<SupplierRow>(`/suppliers/${id}`));
}

/** Re-reads one customer's cached balance after a payment or return. */
export async function refreshCustomer(id: string): Promise<void> {
  const res = await api.get<CustomerRow & { summary: { overdue: string } }>(`/customers/${id}`);
  upsertCustomer({ ...res, overdue: res.summary.overdue });
}

/** Adds or refreshes one customer after it was created or edited. */
export function upsertCustomer(row: CustomerRow): Customer {
  const route = customerById.get(row.id)?.route;
  const mapped = mapCustomer(row, new Map(route && row.routeId ? [[row.routeId, route]] : []));
  const i = CUSTOMERS.findIndex((c) => c.id === row.id);
  if (i >= 0) CUSTOMERS[i] = mapped;
  else CUSTOMERS.push(mapped);
  customerById.set(mapped.id, mapped);
  customerRows.set(row.id, row);
  touch();
  return mapped;
}

/**
 * Shows a customer's details as changed on this device (an edit waiting to
 * sync), keeping the balance the device has worked out.
 */
export function showCustomerDetails(row: CustomerRow): void {
  const current = customerById.get(row.id);
  if (!current) return;
  const { balance, overdue } = current;
  const shown = upsertCustomer(row);
  shown.balance = balance;
  shown.overdue = overdue;
}

/** Takes a customer off this device's list (one added offline and then removed). */
export function dropCustomer(id: string): void {
  const i = CUSTOMERS.findIndex((c) => c.id === id);
  if (i >= 0) CUSTOMERS.splice(i, 1);
  customerById.delete(id);
  customerRows.delete(id);
  touch();
}

/** Stock moves with every invoice; keep the cached figure close without reloading the catalogue. */
export function adjustStock(productId: string, deltaBaseUnits: number): void {
  const p = productById.get(productId);
  if (p) p.stock = Math.round((p.stock + deltaBaseUnits) * 1000) / 1000;
}

export function resetWorkspace(): void {
  replaceAll(SUPPLIERS, []);
  supplierById.clear();
  replaceAll(PRODUCTS, []);
  productById.clear();
  replaceAll(CUSTOMERS, []);
  customerById.clear();
  customerRows.clear();
  replaceAll(BRANDS, []);
  replaceAll(ROUTES, []);
  replaceAll(EXPENSE_CATEGORIES, []);
  WORKSPACE.ready = false;
  WORKSPACE.permissions = new Set();
  touch();
}

// ---------------------------------------------------------------- customer insight

export interface InsightResponse {
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
  return insightFrom(customerId, await api.get<InsightResponse>(`/customers/${customerId}/insight`));
}

/** A customer's buying as the server sends it (also with today's beat), ready for the suggestion engine. */
export function insightFrom(customerId: string, r: InsightResponse): CustomerInsight {
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
