import { z } from "zod";
import { Gstin, Id, IsoDate, Money, PageQuery, PaymentMethod, Percent } from "./common.js";

export const ItcEligibility = z.enum(["eligible", "ineligible", "capital_goods", "input_services"]);

export const ExpenseCategoryBody = z.strictObject({
  name: z.string().trim().min(1).max(60),
  nameHi: z.string().trim().max(60).optional(),
});

export const ExpenseCategoryPatch = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  nameHi: z.string().trim().max(60).nullable().optional(),
  isActive: z.boolean().optional(),
});

/**
 * A business expense paid now (rent, electricity, fuel...). GST on the bill is
 * optional; with the vendor's GSTIN it goes to the GST register as inward
 * supply so the input tax credit shows up in the GST summary.
 */
export const ExpenseBody = z.strictObject({
  expenseDate: IsoDate.optional(),
  categoryId: Id,
  paidTo: z.string().trim().max(120).optional(),
  supplierId: Id.optional(),
  /** Before GST, or the bill total when `amountIncludesTax`. */
  amount: Money,
  amountIncludesTax: z.boolean().default(false),
  gstRate: Percent.default("0"),
  vendorGstin: Gstin.optional(),
  itcEligibility: ItcEligibility.default("input_services"),
  paymentMethod: PaymentMethod,
  paymentAccountId: Id.optional(),
  referenceNumber: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(500).optional(),
});

export const ExpenseListQuery = PageQuery.extend({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  categoryId: z.uuid().optional(),
  method: PaymentMethod.optional(),
  status: z.enum(["posted", "cancelled", "all"]).default("posted"),
});

export const ExpenseReportQuery = z.object({
  from: IsoDate,
  to: IsoDate,
  groupBy: z.enum(["category", "month", "year", "method"]).default("category"),
  format: z.enum(["json", "csv"]).default("json"),
});
