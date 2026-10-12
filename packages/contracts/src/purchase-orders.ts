import { z } from "zod";
import { Id, IsoDate, PageQuery, Percent, Qty, Rate } from "./common.js";
import { ClientTotals } from "./documents.js";

/** A line of an order to a supplier: what is wanted and at what rate (the bill's rate may differ). */
export const PurchaseOrderLineInput = z.strictObject({
  productId: Id,
  unitId: Id.optional(),
  qty: Qty,
  /** Goods the supplier gives free (a scheme). */
  freeQty: Qty.default("0"),
  rate: Rate,
  discountPercent: Percent.default("0"),
  /** The supplier's GST rate when it differs from the product's (percent). */
  gstRate: Percent.optional(),
});

export const PurchaseOrderBody = z.strictObject({
  supplierId: Id,
  orderDate: IsoDate.optional(),
  /** When the goods are wanted. */
  expectedDate: IsoDate.optional(),
  /** Godown to deliver to (the main one when left out). */
  warehouseId: Id.optional(),
  lines: z.array(PurchaseOrderLineInput).min(1).max(300),
  notes: z.string().trim().max(1000).optional(),
  clientTotals: ClientTotals.optional(),
});
export type PurchaseOrderBody = z.infer<typeof PurchaseOrderBody>;

/** pending: open or partly received (goods still to come). */
export const PurchaseOrderListQuery = PageQuery.extend({
  supplierId: Id.optional(),
  status: z.enum(["pending", "open", "partly_received", "received", "closed", "cancelled", "all"]).default("all"),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

/** Closing an order that will not be delivered in full (no more goods expected), or cancelling one before anything came. */
export const PurchaseOrderStopBody = z.strictObject({ reason: z.string().trim().max(300).optional() });

/** What to order: products running short, from one supplier or all, with sales counted over `days`. */
export const ReorderQuery = z.object({
  supplierId: Id.optional(),
  warehouseId: Id.optional(),
  /** Days of sales the pace is taken from. */
  days: z.coerce.number().int().min(7).max(180).default(30),
  /** Days the order should last once it arrives. */
  cover: z.coerce.number().int().min(1).max(120).default(15),
  /** Days the supplier takes to deliver. */
  lead: z.coerce.number().int().min(0).max(60).default(7),
});

/** A line of goods received: from an order line, or by itself. */
export const GoodsReceiptLineInput = z.strictObject({
  productId: Id,
  unitId: Id.optional(),
  qty: Qty,
  freeQty: Qty.default("0"),
  /** Expected rate per unit, before GST; left out, the order line's, else the last purchase rate. */
  rate: Rate.optional(),
  discountPercent: Percent.optional(),
  /** The order line the goods came against. */
  purchaseOrderItemId: Id.optional(),
  batchNumber: z.string().trim().max(40).optional(),
  mfgDate: IsoDate.optional(),
  expiryDate: IsoDate.optional(),
  mrp: Rate.optional(),
});

export const GoodsReceiptBody = z.strictObject({
  supplierId: Id,
  /** The order the goods came against. */
  purchaseOrderId: Id.optional(),
  receivedDate: IsoDate.optional(),
  /** Godown the goods were put in (the order's, else the main one, when left out). */
  warehouseId: Id.optional(),
  /** The supplier's delivery challan or lorry receipt number. */
  challanNumber: z.string().trim().max(30).optional(),
  lines: z.array(GoodsReceiptLineInput).min(1).max(300),
  notes: z.string().trim().max(1000).optional(),
});
export type GoodsReceiptBody = z.infer<typeof GoodsReceiptBody>;

export const GoodsReceiptListQuery = PageQuery.extend({
  supplierId: Id.optional(),
  status: z.enum(["received", "billed", "cancelled", "all"]).default("all"),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

export type PurchaseOrderStatus = "open" | "partly_received" | "received" | "closed" | "cancelled";
export type GoodsReceiptStatus = "received" | "billed" | "cancelled";

/** An order in a list. */
export interface PurchaseOrderRow {
  id: string;
  orderNumber: string;
  orderDate: string;
  expectedDate: string | null;
  supplierId: string;
  partyName: string;
  status: PurchaseOrderStatus;
  grandTotal: string;
  lines: number;
  /** Lines with goods still to come. */
  pendingLines: number;
}

export interface PurchaseOrderItemView {
  id: string;
  lineNo: number;
  productId: string;
  productName: string;
  unitId: string;
  conversionFactor: string;
  qty: string;
  freeQty: string;
  rate: string;
  discountPercent: string;
  gstRate: string;
  taxableValue: string;
  lineTotal: string;
  /** Base units: ordered (bought and free), received, still to come. */
  orderedBase: string;
  receivedBase: string;
  remainingBase: string;
}

export interface PurchaseOrderView {
  id: string;
  orderNumber: string;
  orderDate: string;
  expectedDate: string | null;
  supplierId: string;
  partyName: string;
  partyGstin: string | null;
  warehouseId: string;
  status: PurchaseOrderStatus;
  supplyType: "intra_state" | "inter_state";
  taxableTotal: string;
  cgstTotal: string;
  sgstTotal: string;
  igstTotal: string;
  cessTotal: string;
  roundOff: string;
  grandTotal: string;
  notes: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  items: PurchaseOrderItemView[];
  /** Goods received against it, and bills that brought goods for it. */
  receipts: Array<{ id: string; receiptNumber: string; receivedDate: string; status: GoodsReceiptStatus }>;
  bills: Array<{ id: string; purchaseNumber: string | null; supplierInvoiceNumber: string; supplierInvoiceDate: string; status: string }>;
}

/** A receipt in a list. */
export interface GoodsReceiptRow {
  id: string;
  receiptNumber: string;
  receivedDate: string;
  supplierId: string;
  partyName: string;
  challanNumber: string | null;
  status: GoodsReceiptStatus;
  totalValue: string;
  orderNumber: string | null;
  lines: number;
}

export interface GoodsReceiptItemView {
  id: string;
  lineNo: number;
  productId: string;
  productName: string;
  unitId: string;
  conversionFactor: string;
  qty: string;
  freeQty: string;
  rate: string;
  discountPercent: string;
  unitCost: string;
  purchaseOrderItemId: string | null;
  batchId: string | null;
  batchNumber: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  mrp: string | null;
}

export interface GoodsReceiptView {
  id: string;
  receiptNumber: string;
  receivedDate: string;
  supplierId: string;
  partyName: string;
  purchaseOrderId: string | null;
  orderNumber: string | null;
  warehouseId: string;
  challanNumber: string | null;
  status: GoodsReceiptStatus;
  totalValue: string;
  notes: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  /** The bill the goods were billed in. */
  purchase: { id: string; purchaseNumber: string | null; supplierInvoiceNumber: string } | null;
  items: GoodsReceiptItemView[];
}

/** A product to order: its stock, pace, what is on order and what to order. */
export interface ReorderRow {
  productId: string;
  code: string;
  name: string;
  /** Base unit symbol. */
  unit: string;
  supplierId: string | null;
  supplierName: string | null;
  onHand: string;
  onOrder: string;
  perDay: string;
  daysLeft: string | null;
  minStock: string | null;
  reason: "out" | "below_min" | "runs_out";
  /** What to order in base units, and the same in the unit it is bought in. */
  suggestBase: string;
  unitId: string;
  unitSymbol: string;
  factor: string;
  qty: string;
  /** Last purchase rate per base unit. */
  purchasePrice: string;
}
