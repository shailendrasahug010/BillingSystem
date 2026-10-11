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
  /**
   * Given under a trade scheme: its discount on the line (rupees, besides the
   * line's own), or the whole line given free (at 100% discount). The server
   * checks the bill earned it.
   */
  scheme: z.strictObject({ id: Id, discount: Money.optional(), free: z.boolean().optional() }).optional(),
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
  /**
   * An export (customer registered as overseas) or supply to an SEZ unit: on payment of IGST, or
   * under bond / LUT without it (left out: under the business's LUT while it is valid, else with
   * payment). The shipping bill can be given now or added later.
   */
  zeroRated: z
    .strictObject({
      withPayment: z.boolean(),
      shippingBillNumber: z.string().trim().regex(/^[0-9]{3,20}$/).optional(),
      shippingBillDate: IsoDate.optional(),
      portCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/).optional(),
    })
    .optional(),
  /**
   * A bill made while the device was offline, synced now: numbered from the
   * device's own series. Stock and credit "block" rules only warn, since the
   * customer already has the bill.
   */
  offline: z
    .strictObject({
      deviceId: Id,
      invoiceNumber: z.string().trim().min(1).max(16),
      savedAt: z.iso.datetime({ offset: true }).optional(),
    })
    .optional(),
});

/**
 * The e-invoice's IRN, acknowledgement and signed QR code as the IRP returned them (entered
 * after uploading the JSON on the portal); an IRN of null removes them (entered by mistake).
 */
export const IrnBody = z.union([
  z.strictObject({
    irn: z.string().trim().regex(/^[0-9a-fA-F]{64}$/),
    ackNumber: z.string().trim().regex(/^\d{10,20}$/),
    ackDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/),
    signedQrCode: z.string().trim().max(4000).nullable().optional(),
  }),
  z.strictObject({ irn: z.null() }),
]);

/** The e-way bill number (12 digits) and its date and validity from the portal; a number of null removes it. */
export const EwayBillBody = z.union([
  z.strictObject({
    number: z.string().trim().regex(/^\d{12}$/),
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/),
    validUntil: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/).nullable().optional(),
  }),
  z.strictObject({ number: z.null() }),
]);

/** Transport for e-way bills (Part B); left out, the dispatch trip's vehicle and transporter are used. */
export const EwayFileQuery = z.object({
  ids: z.string().regex(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,199}$/),
  vehicleNo: z.string().trim().max(15).optional(),
  transporterId: z.string().trim().max(15).optional(),
  transporterName: z.string().trim().max(100).optional(),
  distance: z.coerce.number().int().min(0).max(4000).optional(),
});

/** An export's shipping bill, added or corrected after the invoice (null clears a field). */
export const ShippingBillBody = z.strictObject({
  shippingBillNumber: z.string().trim().regex(/^[0-9]{3,20}$/).nullable(),
  shippingBillDate: IsoDate.nullable(),
  portCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/).nullable(),
});

export const DeviceBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  platform: z.enum(["web", "android", "ios", "windows", "mac", "linux"]).default("web"),
  /** The id this device was given before, to keep its series. */
  deviceId: Id.optional(),
});

export const CancelBody = z.strictObject({ reason: z.string().trim().min(3).max(300) });

/** A customer's order: priced like an invoice, no stock or ledger effect until it is invoiced. */
export const SalesOrderBody = z.strictObject({
  customerId: Id,
  orderDate: IsoDate.optional(),
  expectedDeliveryDate: IsoDate.optional(),
  source: z.enum(["counter", "salesperson", "phone", "whatsapp", "app", "link"]).default("app"),
  lines: z.array(DocumentLineInput).min(1).max(300),
  notes: z.string().trim().max(1000).optional(),
  /** A quotation (estimate): priced like an order, numbered on its own, nothing to pack until the customer accepts it. */
  quotation: z.boolean().optional(),
  /** Until when a quotation's prices hold. */
  validUntil: IsoDate.optional(),
});

/** An order from a shop's order link: what and how many; rates come from the shop's rate list. */
export const ShopOrderBody = z.strictObject({
  lines: z
    .array(z.strictObject({ productId: Id, unitId: Id.optional(), qty: Qty.refine((q) => Number(q) > 0, "QTY_MUST_BE_POSITIVE") }))
    .min(1)
    .max(200),
  notes: z.string().trim().max(500).optional(),
});

/** A shop's order link: whether its page also shows the shop's bills, what it owes and a way to pay. */
export const OrderLinkBody = z.strictObject({ showsAccount: z.boolean() });

/** What a shop sees of its own account on its order link. */
export interface ShopAccount {
  /** What it owes now (all bills less payments and returns). */
  balance: string;
  /** The part of it past the bills' due dates. */
  overdue: string;
  /** Its latest bills, newest first. */
  bills: Array<{ id: string; number: string | null; date: string; dueDate: string | null; total: string; due: string; overdue: boolean }>;
  /** Its latest payments, newest first. */
  payments: Array<{ number: string | null; date: string; amount: string; method: string }>;
  /** Where to pay by UPI (the business's own UPI ID, from its payment details), if it has one. */
  upi: { id: string; name: string } | null;
  /** The business takes payments online (its payment gateway is set up): the page offers "Pay online". */
  online: boolean;
}

export const OrderListQuery = PageQuery.extend({
  status: z.enum(["draft", "pending", "confirmed", "packing", "packed", "dispatched", "delivered", "cancelled", "open", "all"]).default("all"),
  customerId: z.uuid().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

export const OrderStatusBody = z.strictObject({
  status: z.enum(["pending", "confirmed", "packing", "packed", "dispatched", "delivered", "cancelled"]),
  note: z.string().trim().max(300).optional(),
});

/** Invoice an order: everything still open, or chosen quantities per line (in the line's unit). */
export const OrderInvoiceBody = z.strictObject({
  invoiceDate: IsoDate.optional(),
  lines: z.array(z.strictObject({ orderLineId: Id, qty: Qty })).min(1).max(300).optional(),
  payment: PaymentAtDocument.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const InvoiceListQuery = PageQuery.extend({
  customerId: z.uuid().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  status: z.enum(["posted", "cancelled", "all"]).default("all"),
  paymentStatus: z.enum(["unpaid", "partial", "paid", "open", "all"]).default("all"),
  /** Bills made offline that were held for a manager (needs_review), or those already reviewed. */
  review: z.enum(["needs_review", "reviewed"]).optional(),
});

/** Marks a bill held for review as reviewed (what was done about it, optionally). */
export const InvoiceReviewBody = z.strictObject({ note: z.string().trim().max(500).optional() });

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
  /** How the supplier's bill names this item (from an imported bill file); remembered for their next bill. */
  supplierItem: z
    .strictObject({
      code: z.string().trim().max(60).optional(),
      name: z.string().trim().max(200).optional(),
    })
    .optional(),
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
  /** Correcting a bill entered wrong: this posted purchase is cancelled in the same step and its payments move to the new bill. */
  replacesPurchaseId: z.uuid().optional(),
  clientTotals: ClientTotals.optional(),
});

/** Lines of a supplier's bill file, to match against suppliers and products before review. */
export const PurchaseImportMatchBody = z.strictObject({
  supplierId: Id.optional(),
  supplierGstin: z.string().trim().max(20).optional(),
  supplierName: z.string().trim().max(200).optional(),
  billNumber: z.string().trim().max(30).optional(),
  billDate: IsoDate.optional(),
  lines: z
    .array(
      z.strictObject({
        itemName: z.string().trim().min(1).max(200),
        itemCode: z.string().trim().max(60).optional(),
        barcode: z.string().trim().max(64).optional(),
      }),
    )
    .min(1)
    .max(300),
});

export const PurchaseListQuery = PageQuery.extend({
  supplierId: z.uuid().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  status: z.enum(["posted", "cancelled", "all"]).default("all"),
});

/** Goods coming back against an invoice (credit note) or going back against a purchase bill (debit note). */
export const ReturnBody = z.strictObject({
  noteDate: IsoDate.optional(),
  /** Discounts and rate differences are value-only notes (PriceNoteBody), not returns. */
  reason: z.enum(["sales_return", "purchase_return", "damage", "other"]).optional(),
  /** Sales return: put the goods back into sellable stock. Purchase return: take them out of stock. */
  restock: z.boolean().default(true),
  lines: z
    .array(
      z.strictObject({
        /** The invoice / purchase line being returned. */
        lineId: Id,
        /** In the line's own unit (e.g. boxes if it was billed in boxes). */
        qty: Qty,
      }),
    )
    .min(1)
    .max(300),
  /** The supplier's own credit note number, when they issue one. */
  partyNoteNumber: z.string().trim().max(30).optional(),
  notes: z.string().trim().max(500).optional(),
  clientTotals: ClientTotals.optional(),
});

/**
 * A note that changes only the value of a bill, not its goods: a discount or
 * rate difference given after the sale (credit note), or a supplier's credit
 * note for the same on a purchase. Give one of amount (spread over the lines
 * by their value), percent, or amounts per line.
 */
export const PriceNoteBody = z.strictObject({
  noteDate: IsoDate.optional(),
  reason: z.enum(["discount", "rate_difference"]).default("discount"),
  /** Taxable amount (before GST). */
  amount: Money.optional(),
  percent: Percent.optional(),
  lines: z.array(z.strictObject({ lineId: Id, amount: Money })).min(1).max(300).optional(),
  /** The supplier's own credit note number (purchase side). */
  partyNoteNumber: z.string().trim().max(30).optional(),
  notes: z.string().trim().max(500).optional(),
  clientTotals: z.strictObject({ grandTotal: Money }).optional(),
});

/**
 * Goods a customer brings back without their bill: the lines as they are
 * taken back (product, quantity, the rate given), a credit note with GST that
 * settles the customer's open bills, oldest due first; anything over stays on
 * their account. A line without a rate is taken back at the customer's last
 * billed rate for it (the rate list's when they were never billed it).
 */
export const LooseReturnBody = z.strictObject({
  customerId: Id,
  noteDate: IsoDate.optional(),
  reason: z.enum(["sales_return", "damage", "other"]).default("sales_return"),
  /** Put the goods back into sellable stock. */
  restock: z.boolean().default(true),
  /** The godown they go back into (the default godown when not given). */
  warehouseId: Id.optional(),
  lines: z
    .array(
      z.strictObject({
        productId: Id,
        /** Defaults to the product's base unit. */
        unitId: Id.optional(),
        qty: Qty,
        /** Per unit, as the product's prices are given (with or without GST). */
        rate: Rate.optional(),
        discountPercent: Percent.optional(),
        batchId: Id.optional(),
      }),
    )
    .min(1)
    .max(300),
  notes: z.string().trim().max(500).optional(),
  clientTotals: z.strictObject({ grandTotal: Money }).optional(),
});

/**
 * A debit note on a bill: the customer owes more than it said (a rate
 * difference upward, a charge after the sale). The taxable amount is spread
 * over the bill's lines by their value (or given per line) and each line's
 * GST applies; the bill's balance grows by the note.
 */
export const DebitNoteBody = z.strictObject({
  noteDate: IsoDate.optional(),
  reason: z.enum(["rate_difference", "other"]).default("rate_difference"),
  /** Taxable amount (before GST). */
  amount: Money.optional(),
  percent: Percent.optional(),
  lines: z.array(z.strictObject({ lineId: Id, amount: Money })).min(1).max(300).optional(),
  notes: z.string().trim().max(500).optional(),
  clientTotals: z.strictObject({ grandTotal: Money }).optional(),
});

export const NoteListQuery = PageQuery.extend({
  party: z.enum(["customer", "supplier", "all"]).default("all"),
  /** Credit notes, debit notes, or both. */
  type: z.enum(["credit", "debit", "all"]).default("all"),
  /** Only notes not against a bill (goods returned without their bill). */
  withoutBill: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  customerId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
  invoiceId: z.uuid().optional(),
  purchaseId: z.uuid().optional(),
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

/** Stock moved from one godown to another (posted at once: out of one, into the other). */
export const TransferBody = z.strictObject({
  transferDate: IsoDate.optional(),
  fromWarehouseId: Id,
  toWarehouseId: Id,
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(z.strictObject({ productId: Id, qty: Qty, batchId: Id.optional() }))
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


/**
 * Saved report views: a report's tab and settings kept under a name. Each
 * report lists the groupings and filters it has; a view may hold only those.
 * A preset period ("this month") is kept as the preset, a custom one as dates.
 */
export const REPORT_VIEW_REPORTS = {
  insights: { permission: "report.view_bi", groups: [], filters: ["period", "compare"] },
  sales: { permission: "report.view_sales", groups: SalesReportQuery.shape.groupBy.unwrap().options, filters: ["period"] },
  collections: { permission: "report.view_collection", groups: CollectionReportQuery.shape.groupBy.unwrap().options, filters: ["period"] },
  purchases: { permission: "report.view_purchase", groups: PurchaseReportQuery.shape.groupBy.unwrap().options, filters: ["period"] },
  outstanding: { permission: "report.view_outstanding", groups: [], filters: ["party", "basis"] },
  profit: { permission: "report.view_profit", groups: ["product", "brand", "category", "customer", "salesperson", "month"], filters: ["period"] },
  pnl: { permission: "report.view_profit", groups: [], filters: ["period"] },
  products: { permission: "report.view_sales", groups: [], filters: ["period", "movement"] },
} as const satisfies Record<string, { permission: string; groups: readonly string[]; filters: readonly ("period" | "party" | "basis" | "movement" | "compare")[] }>;

export type ReportViewReportKey = keyof typeof REPORT_VIEW_REPORTS;
export const ReportViewReport = z.enum(Object.keys(REPORT_VIEW_REPORTS) as [ReportViewReportKey, ...ReportViewReportKey[]]);
export const ReportPeriodPreset = z.enum(["thisMonth", "lastMonth", "last7", "thisFy", "custom"]);

export const ReportViewSettings = z
  .strictObject({
    period: ReportPeriodPreset.optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    groupBy: z.string().regex(/^[a-z_]{2,20}$/).optional(),
    party: z.enum(["customer", "supplier"]).optional(),
    basis: z.enum(["due_date", "invoice_date"]).optional(),
    movement: z.enum(["fast", "slow", "not_moving"]).optional(),
    /** Insights: compared with the period before, or the same dates a year earlier. */
    compare: z.enum(["previous", "last_year"]).optional(),
  })
  .refine((s) => s.period !== "custom" || (s.from !== undefined && s.to !== undefined && s.from <= s.to), { message: "A custom period needs from and to", path: ["from"] });
export type ReportViewSettings = z.infer<typeof ReportViewSettings>;

const ReportViewName = z.string().trim().min(1).max(60);

export const ReportViewBody = z.strictObject({
  name: ReportViewName,
  report: ReportViewReport,
  settings: ReportViewSettings,
  shared: z.boolean().default(false),
});

export const ReportViewPatch = z
  .strictObject({ name: ReportViewName.optional(), settings: ReportViewSettings.optional(), shared: z.boolean().optional() })
  .refine((p) => p.name !== undefined || p.settings !== undefined || p.shared !== undefined, { message: "Nothing to change" });
