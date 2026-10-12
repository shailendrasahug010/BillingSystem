import { z } from "zod";
import { Code, Gstin, patchOf, GstRegistration, Hsn, Id, IsoDate, Mobile, Money, Pan, PageQuery, Percent, Pincode, Qty, Rate, StateCode } from "./common.js";

// ---------- Catalogue ----------

export const UnitBody = z.strictObject({
  name: z.string().trim().min(1).max(50),
  symbol: z.string().trim().min(1).max(10),
  uqc: z.string().trim().toUpperCase().length(3),
  decimals: z.number().int().min(0).max(3).default(0),
});

export const BrandBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().max(20).optional(),
});

export const CategoryBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  parentId: Id.nullable().optional(),
});

export const PriceLevelBody = z.strictObject({
  name: z.string().trim().min(1).max(50),
  isDefault: z.boolean().default(false),
});

export const TaxRateRuleBody = z.strictObject({
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable().optional(),
  gstRate: Percent,
  cessRate: Percent.default("0"),
  cessPerUnit: Rate.default("0"),
  condition: z
    .strictObject({ unitValueLte: Money.optional(), unitValueGt: Money.optional() })
    .nullable()
    .optional(),
  priority: z.number().int().min(0).max(100).default(0),
  reference: z.string().trim().max(200).optional(),
});

export const TaxCategoryBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["taxable", "exempt", "nil_rated", "non_gst", "zero_rated"]).default("taxable"),
  description: z.string().trim().max(300).optional(),
  rules: z.array(TaxRateRuleBody).max(50).default([]),
});

export const ProductUnitInput = z.strictObject({
  unitId: Id,
  conversionFactor: Qty,
  isDefaultSale: z.boolean().default(false),
  isDefaultPurchase: z.boolean().default(false),
});

export const ProductPriceInput = z.strictObject({
  priceLevelId: Id,
  unitId: Id,
  price: Rate,
  discountPercent: Percent.default("0"),
});

export const ProductBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  nameLocal: z.string().trim().max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  code: Code.optional(),
  sku: z.string().trim().max(40).optional(),
  hsnCode: Hsn.optional(),
  taxCategoryId: Id,
  brandId: Id.nullable().optional(),
  categoryId: Id.nullable().optional(),
  baseUnitId: Id,
  packSize: z.string().trim().max(50).optional(),
  purchasePrice: Rate.default("0"),
  sellingPrice: Rate.default("0"),
  mrp: Rate.nullable().optional(),
  pricesIncludeTax: z.boolean().default(false),
  minStock: Qty.nullable().optional(),
  reorderQty: Qty.nullable().optional(),
  preferredSupplierId: Id.nullable().optional(),
  trackBatches: z.boolean().default(false),
  trackExpiry: z.boolean().default(false),
  /** TCS goods (394(1), old 206C(1) and (1F)): the seller collects TCS on them when the business turns TCS on; null for other goods. */
  tcsGoods: z.enum(["liquor", "tendu", "timber_lease", "timber", "forest", "scrap", "minerals", "motor_vehicle", "luxury"]).nullable().optional(),
  isActive: z.boolean().default(true),
  barcodes: z.array(z.string().trim().min(4).max(64)).max(10).default([]),
  units: z.array(ProductUnitInput).max(10).default([]),
  prices: z.array(ProductPriceInput).max(30).default([]),
  /** Opening stock posted to the ledger on create (main godown). */
  openingStock: Qty.optional(),
  openingStockCost: Rate.optional(),
});

/** On edit, openingStock sets the opening quantity: the stock moves by the difference. */
export const ProductPatch = patchOf(ProductBody);

export const ProductListQuery = PageQuery.extend({
  brandId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  stock: z.enum(["all", "low", "out"]).default("all"),
  active: z.enum(["true", "false", "all"]).default("true"),
});

// ---------- Customers & suppliers ----------

const partyAddress = {
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  stateCode: StateCode,
  pincode: Pincode.optional(),
};

export const CustomerBody = z.strictObject({
  code: Code.optional(),
  name: z.string().trim().min(1).max(150),
  businessName: z.string().trim().max(200).optional(),
  customerType: z.enum(["b2b", "b2c"]).default("b2c"),
  gstRegistration: GstRegistration.optional(),
  mobile: Mobile.optional(),
  altMobile: Mobile.optional(),
  email: z.email().optional(),
  ...partyAddress,
  gstin: Gstin.optional(),
  pan: Pan.optional(),
  creditLimit: Money.nullable().optional(),
  creditDays: z.number().int().min(0).max(365).default(0),
  priceLevelId: Id.nullable().optional(),
  categoryId: Id.nullable().optional(),
  routeId: Id.nullable().optional(),
  salesRepId: Id.nullable().optional(),
  openingBalance: Money.default("0"),
  openingBalanceSide: z.enum(["debit", "credit"]).default("debit"),
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().default(true),
  /** Language of the messages sent to the customer; null: the business's language for documents. */
  messageLocale: z.enum(["en", "hi"]).nullable().optional(),
  /** No automatic or bulk payment reminders. */
  remindersOptOut: z.boolean().optional(),
  /** No TCS on sales to them: a declaration that the goods are for making things (Form 27C), or a government body. */
  tcsExempt: z.boolean().optional(),
});

/**
 * A change made offline: the values the device had before it (per field)
 * and when it was made. Sent with If-Match; when the customer changed
 * meanwhile, the change is merged field by field instead of refused.
 */
export const OfflineEdit = z.strictObject({
  base: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  madeAt: z.iso.datetime({ offset: true }),
});

export const CustomerPatch = patchOf(CustomerBody.omit({ openingBalance: true, openingBalanceSide: true })).extend({ offline: OfflineEdit.optional() });

/** Up to 1000 a page: a device loading every customer or supplier needs only a few requests. */
const LongPage = { limit: z.coerce.number().int().min(1).max(1000).default(50) };

export const CustomerListQuery = PageQuery.extend({
  ...LongPage,
  type: z.enum(["all", "b2b", "b2c"]).default("all"),
  routeId: z.uuid().optional(),
  outstanding: z.enum(["any", "yes", "overdue"]).default("any"),
  sort: z.enum(["outstanding", "name", "recent"]).default("name"),
  active: z.enum(["true", "false", "all"]).default("true"),
});

export const SupplierBody = z.strictObject({
  code: Code.optional(),
  name: z.string().trim().min(1).max(150),
  companyName: z.string().trim().max(200).optional(),
  gstRegistration: GstRegistration.default("regular"),
  mobile: Mobile.optional(),
  email: z.email().optional(),
  ...partyAddress,
  gstin: Gstin.optional(),
  pan: Pan.optional(),
  creditDays: z.number().int().min(0).max(365).default(0),
  creditLimit: Money.nullable().optional(),
  openingBalance: Money.default("0"),
  openingBalanceSide: z.enum(["debit", "credit"]).default("credit"),
  bankAccountName: z.string().trim().max(100).optional(),
  bankAccountNumber: z.string().trim().regex(/^\d{6,20}$/).optional(),
  bankIfsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).optional(),
  bankName: z.string().trim().max(100).optional(),
  upiId: z.string().trim().max(100).optional(),
  /** No TDS on purchases from this supplier (a nil or lower deduction certificate). */
  tdsExempt: z.boolean().optional(),
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().default(true),
});

export const SupplierPatch = patchOf(SupplierBody.omit({ openingBalance: true, openingBalanceSide: true }));

export const SupplierListQuery = PageQuery.extend({
  ...LongPage,
  outstanding: z.enum(["any", "yes"]).default("any"),
  active: z.enum(["true", "false", "all"]).default("true"),
});

export const LedgerQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

export const WarehouseBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  code: Code,
  city: z.string().trim().max(100).optional(),
  stateCode: StateCode.optional(),
  isDefault: z.boolean().default(false),
});

export const RouteBody = z.strictObject({
  name: z.string().trim().min(1).max(100),
  visitDays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  salespersonId: Id.nullable().optional(),
});

/**
 * The order customers are called on along a route: those listed get places
 * 1, 2, 3… (and move onto the route). The rest of the route follow by name,
 * or with `others: "remove"` are taken off it (the list is then the route).
 */
export const RouteOrderBody = z.strictObject({ customerIds: z.array(Id).max(1000), others: z.enum(["after", "remove"]).default("after") });

/** Why a call ended without an order. */
export const VISIT_REASONS = ["shop_closed", "owner_absent", "stock_enough", "no_money", "rate_issue", "other"] as const;

/** A call on a customer that left no bill, order or payment: checked in, or no order and why (Phase 5.4). */
export const VisitBody = z
  .strictObject({
    customerId: Id,
    routeId: Id.nullable().optional(),
    visitDate: IsoDate.optional(),
    outcome: z.enum(["visited", "no_order"]),
    reason: z.enum(VISIT_REASONS).optional(),
    note: z.string().trim().max(500).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    /** When it happened on the phone (made offline: earlier than it arrives). */
    visitedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((b) => b.outcome !== "no_order" || b.reason !== undefined, { message: "Say why there was no order", path: ["reason"] });

/** Today's beat: the person's routes for the day (or one route), with `insights` the customers' buying for offline suggestions. */
export const BeatQuery = z.object({
  date: IsoDate.optional(),
  routeId: Id.optional(),
  insights: z.enum(["0", "1"]).default("0"),
});

export const BeatReportQuery = z.object({ from: IsoDate, to: IsoDate });

export const CustomerCategoryBody = z.strictObject({ name: z.string().trim().min(1).max(100) });

export const SettingBody = z.strictObject({ value: z.unknown() });

export const TaxRateEndBody = z.strictObject({ effectiveTo: IsoDate });

/** Rows of a spreadsheet (header -> cell text), validated and imported all-or-nothing. */
export const ImportBody = z.strictObject({
  dryRun: z.boolean().default(false),
  rows: z.array(z.record(z.string().trim().max(60), z.string().max(500).nullish())).min(1).max(5000),
});

const ImportRows = z.array(z.record(z.string().trim().max(60), z.string().max(500).nullish())).max(5000);

/** Masters read from a Tally XML file, imported together, all or nothing. */
export const TallyImportBody = z
  .strictObject({ dryRun: z.boolean().default(false), customers: ImportRows.default([]), suppliers: ImportRows.default([]), products: ImportRows.default([]) })
  .refine((b) => b.customers.length + b.suppliers.length + b.products.length > 0, { message: "nothing to import" });
