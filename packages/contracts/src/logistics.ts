import { z } from "zod";
import { Gstin, Id, IsoDate, Mobile, PageQuery, Qty } from "./common.js";

const text = (max: number) => z.string().trim().max(max);

/** Goods packed for a sales order; quantities in base units (pieces), batches picked first-expiry-first. */
export const PackingBody = z.strictObject({
  salesOrderId: Id,
  lines: z
    .array(
      z.strictObject({
        orderItemId: Id,
        qty: Qty,
        batchId: Id.optional(),
        boxNo: z.number().int().min(1).max(999).optional(),
        scannedBarcode: text(64).optional(),
      }),
    )
    .min(1)
    .max(300),
  boxCount: z.number().int().min(0).max(999).default(0),
  totalWeightKg: Qty.optional(),
  packedBy: Id.optional(),
  notes: text(300).optional(),
});

export const PackingListQuery = PageQuery.extend({ salesOrderId: z.uuid().optional() });

/** A vehicle trip carrying invoiced goods, in delivery order. */
export const DispatchBody = z.strictObject({
  dispatchDate: IsoDate.optional(),
  vehicleNumber: z.string().trim().toUpperCase().max(15).optional(),
  driverName: text(80).optional(),
  driverMobile: Mobile.optional(),
  driverEmployeeId: Id.optional(),
  transporterName: text(120).optional(),
  transporterGstin: Gstin.optional(),
  lrNumber: text(30).optional(),
  lrDate: IsoDate.optional(),
  expectedDeliveryDate: IsoDate.optional(),
  remarks: text(300).optional(),
  invoiceIds: z.array(Id).min(1).max(200),
  /** Leave now (dispatched) or plan the trip first. */
  start: z.boolean().default(false),
});

export const DispatchListQuery = PageQuery.extend({
  status: z.enum(["open", "planned", "dispatched", "delivered", "cancelled", "all"]).default("open"),
});

export const DeliveryBody = z.strictObject({
  status: z.enum(["delivered", "partially_delivered", "returned"]),
  receivedBy: text(80).optional(),
  remarks: text(300).optional(),
});
