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
  isActive: z.boolean().default(true),
  barcodes: z.array(z.string().trim().min(4).max(64)).max(10).default([]),
  units: z.array(ProductUnitInput).max(10).default([]),
  prices: z.array(ProductPriceInput).max(30).default([]),
  /** Opening stock posted to the ledger on create (main godown). */
  openingStock: Qty.optional(),
  openingStockCost: Rate.optional(),
});

export const ProductPatch = patchOf(ProductBody.omit({ openingStock: true, openingStockCost: true }));

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
});

export const CustomerPatch = patchOf(CustomerBody.omit({ openingBalance: true, openingBalanceSide: true }));

export const CustomerListQuery = PageQuery.extend({
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
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().default(true),
});

export const SupplierPatch = patchOf(SupplierBody.omit({ openingBalance: true, openingBalanceSide: true }));

export const SupplierListQuery = PageQuery.extend({
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

export const CustomerCategoryBody = z.strictObject({ name: z.string().trim().min(1).max(100) });

export const SettingBody = z.strictObject({ value: z.unknown() });

export const TaxRateEndBody = z.strictObject({ effectiveTo: IsoDate });

/** Rows of a spreadsheet (header -> cell text), validated and imported all-or-nothing. */
export const ImportBody = z.strictObject({
  dryRun: z.boolean().default(false),
  rows: z.array(z.record(z.string().trim().max(60), z.string().max(500).nullish())).min(1).max(5000),
});
