import { z } from "zod";
import { Id, IsoDate, Money, PageQuery, PaymentMethod, Percent, Qty, Rate } from "./common.js";

/** Totals the client displayed; the server recomputes and rejects any difference. */
export const ClientTotals = z.strictObject({
  taxableTotal: Money.optional(),
  taxTotal: Money.optional(),
  roundOff: z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/).optional(),
  grandTotal: Money.optional(),
});

export const DocumentLineInput = z.strictObject({
  productId: Id,
  /** Defaults to the product's base unit. */
  unitId: Id.optional(),
  qty: Qty,
  freeQty: Qty.default("0"),
  /** Defaults to the customer's rate list price. */
  rate: Rate.optional(),
  /** Defaults to the rate list's discount for this product. */
  discountPercent: Percent.optional(),
  discountAmount: Money.default("0"),
  batchId: Id.optional(),
});

export const ChargeInput = z.strictObject({
  label: z.string().trim().min(1).max(60),
  amount: Money,
  /** GST % for a taxable charge (e.g. freight billed with the goods). Omit for non-taxable. */
  gstRate: Percent.optional(),
});

export const PaymentAtDocument = z.strictObject({
  amount: Money,
  method: PaymentMethod,
  reference: z.string().trim().max(40).optional(),
  paymentAccountId: Id.optional(),
});

export const InvoiceBody = z.strictObject({
  customerId: Id,
  invoiceDate: IsoDate.optional(),
  warehouseId: Id.optional(),
  shipToStateCode: z.string().regex(/^\d{2}$/).optional(),
  lines: z.array(DocumentLineInput).min(1).max(300),
  documentDiscount: z.strictObject({ percent: Percent.optional(), amount: Money.optional() }).optional(),
  charges: z.array(ChargeInput).max(10).default([]),
  payment: PaymentAtDocument.optional(),
  notes: z.string().trim().max(1000).optional(),
  salespersonId: Id.optional(),
  printLocale: z.enum(["en", "hi"]).optional(),
  clientTotals: ClientTotals.optional(),
});

export const CancelBody = z.strictObject({ reason: z.string().trim().min(3).max(300) });

export const InvoiceListQuery = PageQuery.extend({
  customerId: z.uuid().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  status: z.enum(["posted", "cancelled", "all"]).default("all"),
  paymentStatus: z.enum(["unpaid", "partial", "paid", "open", "all"]).default("all"),
});

export const PurchaseLineInput = z.strictObject({
  productId: Id,
  unitId: Id.optional(),
  qty: Qty,
  freeQty: Qty.default("0"),
  rate: Rate,
  discountPercent: Percent.default("0"),
  discountAmount: Money.default("0"),
  /** Override the product's GST rate with the supplier's (percent). */
  gstRate: Percent.optional(),
  batchNumber: z.string().trim().max(40).optional(),
  mfgDate: IsoDate.optional(),
  expiryDate: IsoDate.optional(),
  mrp: Rate.optional(),
});

export const PurchaseBody = z.strictObject({
  supplierId: Id,
  supplierInvoiceNumber: z.string().trim().min(1).max(30),
  supplierInvoiceDate: IsoDate,
  receivedDate: IsoDate.optional(),
  warehouseId: Id.optional(),
  lines: z.array(PurchaseLineInput).min(1).max(300),
  charges: z.array(ChargeInput).max(10).default([]),
  itcEligibility: z.enum(["eligible", "ineligible", "capital_goods", "input_services"]).default("eligible"),
  isReverseCharge: z.boolean().default(false),
  payment: PaymentAtDocument.optional(),
  notes: z.string().trim().max(1000).optional(),
  clientTotals: ClientTotals.optional(),
});

export const PurchaseListQuery = PageQuery.extend({
  supplierId: z.uuid().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  status: z.enum(["posted", "cancelled", "all"]).default("all"),
});

export const AllocationInput = z.strictObject({
  documentId: Id,
  amount: Money,
});

export const PaymentBody = z.strictObject({
  direction: z.enum(["in", "out"]),
  customerId: Id.optional(),
  supplierId: Id.optional(),
  paymentDate: IsoDate.optional(),
  amount: Money,
  method: PaymentMethod,
  referenceNumber: z.string().trim().max(40).optional(),
  chequeDate: IsoDate.optional(),
  chequeBank: z.string().trim().max(100).optional(),
  paymentAccountId: Id.optional(),
  /** Explicit allocations; omit to allocate to the oldest due documents first. */
  allocations: z.array(AllocationInput).max(200).optional(),
  notes: z.string().trim().max(500).optional(),
});

export const PaymentListQuery = PageQuery.extend({
  direction: z.enum(["in", "out", "all"]).default("all"),
  customerId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  method: PaymentMethod.optional(),
});

export const AdjustmentBody = z.strictObject({
  adjustmentDate: IsoDate.optional(),
  warehouseId: Id.optional(),
  reason: z.enum(["count_correction", "damage", "expiry", "theft", "sample", "internal_use", "other"]),
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.strictObject({
        productId: Id,
        batchId: Id.optional(),
        /** Signed change in base units, e.g. "-3" for three damaged pieces. */
        qtyChange: z.string().regex(/^-?\d{1,12}(\.\d{1,3})?$/),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(300),
});

export const StockQuery = PageQuery.extend({
  warehouseId: z.uuid().optional(),
  level: z.enum(["all", "low", "out"]).default("all"),
});

export const StockLedgerQuery = z.object({
  productId: z.uuid(),
  warehouseId: z.uuid().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const SuggestionQuery = z.object({
  cart: z.string().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});

export const DashboardQuery = z.object({
  range: z.enum(["today", "yesterday", "last7", "thisMonth", "lastMonth", "thisFy", "custom"]).default("thisMonth"),
  /** Trend buckets: 30 days, 12 weeks, 6 months or 3 financial years. */
  grain: z.enum(["daily", "weekly", "monthly", "yearly"]).default("daily"),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

export const SalesReportQuery = z.object({
  from: IsoDate,
  to: IsoDate,
  groupBy: z.enum(["day", "week", "month", "year", "customer", "product", "brand", "category", "salesperson"]).default("day"),
  customerId: z.uuid().optional(),
  productId: z.uuid().optional(),
  brandId: z.uuid().optional(),
});

export const CollectionReportQuery = z.object({
  from: IsoDate,
  to: IsoDate,
  groupBy: z.enum(["day", "week", "month", "year", "method", "customer"]).default("day"),
});

export const PurchaseReportQuery = z.object({
  from: IsoDate,
  to: IsoDate,
  groupBy: z.enum(["day", "month", "year", "supplier", "product", "brand"]).default("month"),
});

export const OutstandingQuery = z.object({
  party: z.enum(["customer", "supplier"]).default("customer"),
  asOf: IsoDate.optional(),
  basis: z.enum(["invoice_date", "due_date"]).default("due_date"),
  buckets: z.string().regex(/^\d+(,\d+)*$/).default("30,60,90"),
});

export const SearchQuery = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

