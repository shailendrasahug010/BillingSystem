import type { InvoiceBody } from "@digitalbahi/contracts";
import {
  addDays,
  calculateDocument,
  chargesGst,
  checkSchemeClaims,
  compareTotals,
  daysBetween,
  dec,
  determineSupplyType,
  documentKindFor,
  resolveTax,
  roundRate,
  taxAt,
  todayIn,
  zeroRatedKindFor,
  zeroRatedTypeOf,
  pct,
  roundAmount,
  type BusinessGstRegistration,
  type DocumentLineInput,
  type DocumentTotals,
  type PartyGstRegistration,
  type SchemeClaims,
  type SchemeLine,
  type TaxCategory,
  type TaxRateRule,
  type ZeroRatedType,
} from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import { can } from "../lib/access.js";
import type { RequestCtx } from "../lib/context.js";
import { inSequence } from "../lib/db.js";
import { ApiError, badRequest, conflict, forbidden } from "../lib/errors.js";
import { periodLocked } from "./gst-period.js";
import { schemeRule, schemesOn } from "./schemes.js";
import { getSettings } from "./settings.js";

type Body = z.output<typeof InvoiceBody>;

export interface PreparedLine {
  key: string;
  productId: string;
  productName: string;
  unitId: string;
  batchId: string | null;
  conversionFactor: string;
  rateIncludesTax: boolean;
  freeQty: string;
  /** Free quantity in base units (moves stock, carries no value). */
  freeQtyBase: string;
  hsnCode: string | null;
  uqc: string | null;
  taxCategoryId: string;
  taxRateId: string | null;
  taxability: "taxable" | "exempt" | "nil_rated" | "non_gst" | "zero_rated";
  avgCost: string;
  listRate: string;
  /** The line's discount percent as charged (the rate list's when the request gave none; 100 for goods given free). */
  discountPercent: string;
  /** The scheme that gave the line's scheme discount, or the whole line free. */
  schemeId: string | null;
  schemeDiscount: string;
  schemeFree: boolean;
}

export interface PreparedSale {
  business: typeof schema.businesses.$inferSelect;
  customer: typeof schema.customers.$inferSelect;
  warehouseId: string;
  invoiceDate: string;
  placeOfSupply: string;
  supplyType: "intra_state" | "inter_state";
  documentKind: "tax_invoice" | "bill_of_supply";
  priceLevelId: string | null;
  lines: PreparedLine[];
  totals: DocumentTotals;
  /** Export / supply to SEZ, with or without payment of IGST; null for other sales. */
  zeroRatedType: ZeroRatedType | null;
  shippingBill: { number: string | null; date: string | null; portCode: string | null };
  /** Without payment of IGST under the business's LUT: its ARN, to print on the invoice. */
  lutArn: string | null;
  rateOverridden: boolean;
  settings: Awaited<ReturnType<typeof loadSaleSettings>>;
  /** Rules a bill made offline broke by the time it arrived: it is posted and held for a manager instead of refused. */
  review: ReviewReason[];
}

/** Why a bill made offline is held for review (codes in invoices.review_reasons). */
export interface ReviewReason {
  code: "price_changed" | "customer_inactive" | "product_inactive" | "period_locked" | "late_sync" | "stock_short" | "credit_limit" | "credit_overdue" | "scheme_changed";
  params?: Record<string, string | number>;
}

const loadSaleSettings = (tx: Tx, businessId: string) =>
  getSettings(tx, businessId, ["invoice.round_off", "stock.negative_policy", "credit.policy", "invoice.default_print_locale", "gst.lut"] as const);

/**
 * Turns an invoice request into a fully priced, GST-resolved document using
 * only server data: prices come from the rate list unless the caller may
 * override them, tax comes from the dated rules on the invoice date, and the
 * totals are computed by the same engine the client uses.
 */
/** How long a bill made offline may wait on a device and still keep its own date without the back-date permission. */
const OFFLINE_DAYS = 7;

/**
 * `order`: pricing an order (no GST period check). `trustSchemes`: the lines'
 * schemes were checked when they were given (an order being billed), so they
 * are kept as they are.
 */
export async function prepareSale(tx: Tx, ctx: RequestCtx, body: Body, today: string, options: { order?: boolean; trustSchemes?: boolean } = {}): Promise<PreparedSale> {
  const businessId = ctx.businessId;
  const [business] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  const [customer] = await tx
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, body.customerId), eq(schema.customers.businessId, businessId), isNull(schema.customers.deletedAt)));
  if (!customer) throw badRequest("REFERENCE_NOT_FOUND", {}, "customerId");
  // A bill made offline is a fact by the time it arrives (the customer has it):
  // what it broke since is noted for a manager instead of refusing it.
  const offline = body.offline !== undefined;
  const review: ReviewReason[] = [];
  if (!customer.isActive) {
    if (!offline) throw badRequest("CUSTOMER_INACTIVE", {}, "customerId");
    review.push({ code: "customer_inactive", params: { customer: customer.businessName ?? customer.name } });
  }

  const invoiceDate = body.invoiceDate ?? today;
  if (invoiceDate > today) throw badRequest("FUTURE_DATE_NOT_ALLOWED", {}, "invoiceDate");
  // A bill made offline carries the day it was made; that is not back-dating
  // (the day comes from the device's clock). One that took over a week to
  // arrive is held for review.
  const madeOfflineThatDay = body.offline?.savedAt !== undefined && todayIn(ctx.timeZone, new Date(body.offline.savedAt)) === invoiceDate;
  if (invoiceDate < today && !can(ctx, "invoice.backdate")) {
    if (!madeOfflineThatDay) throw forbidden("invoice.backdate");
    if (invoiceDate < addDays(today, -OFFLINE_DAYS)) review.push({ code: "late_sync", params: { days: daysBetween(invoiceDate, today) } });
  }
  // The month's GSTR-1 is locked or filed: a new bill there would change it (one made offline is held instead).
  if (!options.order && (await periodLocked(tx, businessId, invoiceDate))) {
    if (!offline) throw conflict("GST_PERIOD_LOCKED");
    review.push({ code: "period_locked", params: { month: invoiceDate.slice(0, 7) } });
  }

  let warehouseId = body.warehouseId;
  const [wh] = await tx
    .select({ id: schema.warehouses.id })
    .from(schema.warehouses)
    .where(
      and(
        eq(schema.warehouses.businessId, businessId),
        isNull(schema.warehouses.deletedAt),
        warehouseId ? eq(schema.warehouses.id, warehouseId) : eq(schema.warehouses.isDefault, true),
      ),
    );
  if (!wh) throw warehouseId ? badRequest("REFERENCE_NOT_FOUND", {}, "warehouseId") : new ApiError(409, "NO_DEFAULT_WAREHOUSE");
  warehouseId = wh.id;

  const registration = business!.gstRegistration as BusinessGstRegistration;
  // Exports (a buyer abroad) and supplies to SEZ are zero-rated; only a regular registrant makes them.
  const zeroRatedKind = chargesGst(registration) ? zeroRatedKindFor(customer.gstRegistration) : null;
  if (body.zeroRated && !zeroRatedKind) throw badRequest("ZERO_RATED_NOT_ALLOWED", {}, "zeroRated");
  if (body.zeroRated?.shippingBillDate && body.zeroRated.shippingBillDate < invoiceDate) throw badRequest("SHIPPING_BILL_BEFORE_INVOICE", {}, "zeroRated.shippingBillDate");
  // An export's place of supply is outside India (96).
  const placeOfSupply = zeroRatedKind === "export" ? "96" : (body.shipToStateCode ?? customer.stateCode);
  const supplyType = determineSupplyType({
    supplierStateCode: business!.stateCode,
    placeOfSupplyStateCode: placeOfSupply,
    recipientRegistration: customer.gstRegistration as PartyGstRegistration,
  });

  // Rate list: the customer's, else the business default.
  let priceLevelId = customer.priceLevelId;
  if (!priceLevelId) {
    const [def] = await tx
      .select({ id: schema.priceLevels.id })
      .from(schema.priceLevels)
      .where(and(eq(schema.priceLevels.businessId, businessId), eq(schema.priceLevels.isDefault, true)));
    priceLevelId = def?.id ?? null;
  }

  const productIds = [...new Set(body.lines.map((l) => l.productId))];
  const products = await tx
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.businessId, businessId), inArray(schema.products.id, productIds), isNull(schema.products.deletedAt)));
  const productById = new Map(products.map((p) => [p.id, p]));
  const [altUnits, prices, unitRows, categories, rules] = await inSequence([
    () => tx.select().from(schema.productUnits).where(inArray(schema.productUnits.productId, productIds)),
    () => priceLevelId
      ? tx
          .select()
          .from(schema.productPrices)
          .where(and(inArray(schema.productPrices.productId, productIds), eq(schema.productPrices.priceLevelId, priceLevelId)))
      : Promise.resolve([]),
    () => tx.select().from(schema.units).where(eq(schema.units.businessId, businessId)),
    () => tx.select().from(schema.taxCategories).where(eq(schema.taxCategories.businessId, businessId)),
    () => tx.select().from(schema.taxRates).where(eq(schema.taxRates.businessId, businessId)),
  ]);
  const unitById = new Map(unitRows.map((u) => [u.id, u]));
  const categoryById = new Map<string, TaxCategory>(
    categories.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        kind: c.kind,
        rules: rules
          .filter((r) => r.taxCategoryId === c.id)
          .map(
            (r): TaxRateRule => ({
              id: r.id,
              effectiveFrom: r.effectiveFrom,
              effectiveTo: r.effectiveTo,
              gstRate: r.gstRate,
              cessRate: r.cessRate,
              cessPerUnit: r.cessPerUnit,
              condition: (r.condition as TaxRateRule["condition"]) ?? null,
              priority: r.priority,
            }),
          ),
      },
    ]),
  );

  const batchIds = body.lines.map((l) => l.batchId).filter((b): b is string => Boolean(b));
  const batches = batchIds.length
    ? await tx.select().from(schema.batches).where(and(eq(schema.batches.businessId, businessId), inArray(schema.batches.id, batchIds)))
    : [];

  let rateOverridden = false;
  const prepared: PreparedLine[] = [];
  const schemeLines: SchemeLine[] = [];
  const schemeClaims: { discounts: Array<SchemeClaims["discounts"][number]>; free: Array<SchemeClaims["free"][number]> } = { discounts: [], free: [] };
  const engineLines: DocumentLineInput[] = body.lines.map((line, i) => {
    const product = productById.get(line.productId);
    if (!product) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].productId`);
    if (!product.isActive) {
      if (!offline) throw badRequest("PRODUCT_INACTIVE", { product: product.name }, `lines[${i}].productId`);
      if (!review.some((r) => r.code === "product_inactive" && r.params?.product === product.name)) review.push({ code: "product_inactive", params: { product: product.name } });
    }
    const unitId = line.unitId ?? product.baseUnitId;
    let factor = "1";
    if (unitId !== product.baseUnitId) {
      const alt = altUnits.find((u) => u.productId === product.id && u.unitId === unitId);
      if (!alt) throw badRequest("UNIT_NOT_ON_PRODUCT", { product: product.name }, `lines[${i}].unitId`);
      factor = alt.conversionFactor;
    }
    if (line.batchId) {
      const batch = batches.find((b) => b.id === line.batchId);
      if (!batch || batch.productId !== product.id) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].batchId`);
    }
    // A pack without its own price on the customer's rate list is that list's price for the stock unit times the pack.
    const listPrice = prices.find((p) => p.productId === product.id && p.unitId === unitId);
    const basePrice = listPrice ?? prices.find((p) => p.productId === product.id && p.unitId === product.baseUnitId);
    const listRate = listPrice ? dec(listPrice.price) : roundRate(dec(basePrice?.price ?? product.sellingPrice).times(factor));
    const rate = line.rate !== undefined ? dec(line.rate) : listRate;
    if (!rate.eq(listRate)) {
      rateOverridden = true;
      // The rate list changed while the device was offline: the bill keeps the rate it was made at.
      if (offline && !can(ctx, "invoice.override_price") && !review.some((r) => r.code === "price_changed" && r.params?.product === product.name)) {
        review.push({ code: "price_changed", params: { product: product.name, billed: rate.toFixed(2), list: listRate.toFixed(2) } });
      }
    }
    // Goods given free under a scheme: the whole line at 100% off, nothing else taken off it.
    const free = line.scheme?.free === true;
    if (free && ((line.discountPercent !== undefined && !dec(line.discountPercent).eq(100)) || dec(line.discountAmount).gt(0) || dec(line.freeQty).gt(0) || line.scheme?.discount !== undefined)) {
      throw badRequest("SCHEME_FREE_LINE", { product: product.name }, `lines[${i}].scheme`);
    }
    const discountPercent = free ? "100" : (line.discountPercent ?? basePrice?.discountPercent ?? "0");
    const schemeDiscount = free ? dec(0) : roundAmount(line.scheme?.discount ?? 0);

    const category = categoryById.get(product.taxCategoryId);
    if (!category) throw badRequest("REFERENCE_NOT_FOUND", {}, `lines[${i}].productId`);
    const tax = resolveTax(category, {
      date: invoiceDate,
      unitValue: rate.dividedBy(factor),
      unitValueIncludesTax: product.pricesIncludeTax,
    });
    const baseUnit = unitById.get(product.baseUnitId);
    const key = `L${i + 1}`;
    const qtyBase = dec(line.qty).times(factor);
    if (free) schemeClaims.free.push({ schemeId: line.scheme!.id, productId: product.id, qty: qtyBase });
    else {
      // What the line comes to before any scheme, exactly as the engine works it out.
      const gross = roundAmount(dec(line.qty).times(rate));
      schemeLines.push({
        key,
        productId: product.id,
        brandId: product.brandId,
        categoryId: product.categoryId,
        qtyBase,
        value: gross.minus(roundAmount(pct(gross, discountPercent))).minus(roundAmount(line.discountAmount)),
      });
      if (line.scheme && schemeDiscount.gt(0)) schemeClaims.discounts.push({ lineKey: key, schemeId: line.scheme.id, amount: schemeDiscount });
    }
    prepared.push({
      key,
      productId: product.id,
      productName: product.name,
      unitId,
      batchId: line.batchId ?? null,
      conversionFactor: factor,
      rateIncludesTax: product.pricesIncludeTax,
      freeQty: line.freeQty,
      freeQtyBase: dec(line.freeQty).times(factor).toFixed(3),
      hsnCode: product.hsnCode,
      uqc: baseUnit?.uqc ?? null,
      taxCategoryId: product.taxCategoryId,
      taxRateId: tax.ruleId,
      taxability: tax.kind,
      avgCost: product.avgCost,
      listRate: listRate.toFixed(4),
      discountPercent,
      schemeId: line.scheme && (free || schemeDiscount.gt(0)) ? line.scheme.id : null,
      schemeDiscount: schemeDiscount.toFixed(2),
      schemeFree: free,
    });
    return {
      key,
      qty: line.qty,
      rate,
      rateIncludesTax: product.pricesIncludeTax,
      discountPercent,
      discountAmount: dec(line.discountAmount).plus(schemeDiscount),
      conversionFactor: factor,
      tax,
      hsnCode: product.hsnCode,
      uqc: baseUnit?.uqc ?? null,
    };
  });
  if (rateOverridden && !offline && !can(ctx, "invoice.override_price")) throw forbidden("invoice.override_price");

  // Schemes: the bill must have earned what it gives (an order being billed keeps what it was given).
  const named = [...new Set([...schemeClaims.discounts.map((d) => d.schemeId), ...schemeClaims.free.map((f) => f.schemeId)])];
  if (named.length && !options.trustSchemes) {
    const rows = await schemesOn(tx, businessId, invoiceDate, named);
    // Another business's scheme is never written on this bill.
    for (const p of prepared) {
      if (!p.schemeId || rows.some((r) => r.id === p.schemeId)) continue;
      if (!offline) throw new ApiError(422, "SCHEME_NOT_EARNED", { scheme: p.schemeId });
      // Kept as a plain discount (or goods given free), with no scheme to claim it from.
      p.schemeId = null;
      p.schemeDiscount = "0.00";
      p.schemeFree = false;
    }
    const unitValue = (productId: string) => {
      const product = productById.get(productId);
      if (!product) return null;
      return prices.find((p) => p.productId === productId && p.unitId === product.baseUnitId)?.price ?? product.sellingPrice;
    };
    const problems = checkSchemeClaims(
      { date: invoiceDate, customer: { categoryId: customer.categoryId, priceLevelId }, lines: schemeLines, schemes: rows.map(schemeRule), unitValue },
      schemeClaims,
    );
    if (problems.length) {
      const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? id;
      const first = problems[0]!;
      // A bill made offline is a fact: given is given, and a manager looks at it.
      if (!offline) throw new ApiError(422, first.reason === "not_in_force" ? "SCHEME_NOT_RUNNING" : "SCHEME_NOT_EARNED", { scheme: nameOf(first.schemeId) });
      for (const id of new Set(problems.map((p) => p.schemeId))) review.push({ code: "scheme_changed", params: { scheme: nameOf(id) } });
    }
  }

  const settings = await loadSaleSettings(tx, businessId);
  // Without payment of IGST (under the LUT) unless asked otherwise, while the LUT is valid on the invoice date.
  const lut = settings["gst.lut"];
  const withPayment = body.zeroRated?.withPayment ?? !(lut && lut.validUntil >= invoiceDate);
  const zeroRatedType = zeroRatedKind ? zeroRatedTypeOf(zeroRatedKind, withPayment) : null;
  // Without IGST and no valid LUT on that day: under a bond, which has no ARN to print.
  const lutArn = zeroRatedKind && !withPayment && lut && lut.validUntil >= invoiceDate ? lut.arn : null;
  const totals = calculateDocument({
    lines: engineLines,
    supplyType,
    chargeTax: chargesGst(registration),
    withoutPayment: zeroRatedKind !== null && !withPayment,
    documentDiscount: body.documentDiscount ?? null,
    charges: body.charges.map((c, i) => ({ key: `C${i + 1}`, label: c.label, amount: c.amount, tax: c.gstRate ? taxAt(c.gstRate) : null })),
    roundOff: settings["invoice.round_off"],
    amountPaid: body.payment?.amount ?? "0",
  });

  if (body.clientTotals) {
    const mismatches = compareTotals(totals, body.clientTotals);
    if (mismatches.length) {
      const first = mismatches[0]!;
      throw new ApiError(422, "TOTALS_MISMATCH", { field: first.field, expected: first.expected, received: first.received });
    }
  }

  return {
    business: business!,
    customer,
    warehouseId,
    invoiceDate,
    placeOfSupply,
    supplyType,
    documentKind: documentKindFor(registration),
    priceLevelId,
    lines: prepared,
    totals,
    zeroRatedType,
    shippingBill:
      zeroRatedKind === "export"
        ? { number: body.zeroRated?.shippingBillNumber ?? null, date: body.zeroRated?.shippingBillDate ?? null, portCode: body.zeroRated?.portCode ?? null }
        : { number: null, date: null, portCode: null },
    lutArn,
    rateOverridden,
    review,
    settings,
  };
}
