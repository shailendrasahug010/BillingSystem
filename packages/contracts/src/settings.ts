import { z } from "zod";
import { Gstin, Id, Pan, Pincode, StateCode } from "./common.js";

const policy = z.enum(["allow", "warn", "block"]);

const PtSlab = z.strictObject({
  /** Tax for pay above this many rupees. */
  above: z.number().int().min(0).max(10_000_000),
  amount: z.number().int().min(0).max(2500),
  /** A different amount in one month (₹300 in February in Maharashtra). */
  special: z.strictObject({ month: z.number().int().min(1).max(12), amount: z.number().int().min(0).max(2500) }).optional(),
});
/** A state's professional tax slabs, on the month's pay or on the pay × 12. */
export const PtRuleSchema = z.strictObject({
  basis: z.enum(["monthly", "annual"]),
  slabs: z.array(PtSlab).max(12),
  femaleSlabs: z.array(PtSlab).max(12).optional(),
});

/** The letter a unit is picked with on a bill's line ("B" for BOX): one letter, any script, kept in capitals. */
const UnitLetter = z
  .string()
  .trim()
  .regex(/^\p{L}$/u)
  .transform((s) => s.toUpperCase());

/**
 * Every configurable business rule, with its value schema. The API rejects
 * unknown keys and invalid values; clients use the same schemas for forms.
 */
export const SETTING_SCHEMAS = {
  "stock.negative_policy": policy,
  "stock.valuation": z.enum(["moving_average"]),
  "stock.expiry_warning_days": z.number().int().min(0).max(365),
  "invoice.round_off": z.strictObject({
    mode: z.enum(["none", "nearest", "up", "down"]),
    step: z.number().min(0.01).max(100),
  }),
  "invoice.edit_window_hours": z.number().int().min(0).max(720),
  "invoice.default_print_locale": z.enum(["en", "hi"]),
  "invoice.offline_mode": z.enum(["device_series", "server_only"]),
  /** Printed at the foot of every invoice (return policy, interest, jurisdiction). */
  "invoice.terms": z.string().trim().max(1000),
  /**
   * Where customers pay the business, printed on invoices: the bank account and the UPI ID (also as a
   * QR code for what a bill still owes, on the PDF and on thermal receipts). Empty strings when not set.
   */
  "invoice.payment_details": z.strictObject({
    bankName: z.string().trim().max(100),
    accountNumber: z.string().trim().regex(/^\d{0,20}$/),
    ifsc: z.string().trim().toUpperCase().regex(/^([A-Z]{4}0[A-Z0-9]{6})?$/),
    upiId: z.string().trim().regex(/^([a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{2,63})?$/),
  }),
  /**
   * The letters units are picked with on a bill's line, by unit id: typed after the quantity ("2" then "B":
   * 2 boxes) or on the line's unit list. A unit not listed has its symbol's first letter (BOX: B, STRIP: S);
   * a letter two of a product's units share picks the first, and pressed again the next. Null until the
   * business sets one.
   */
  "invoice.unit_letters": z
    .record(Id, UnitLetter)
    .refine((letters) => Object.keys(letters).length <= 500, { message: "At most 500 units" })
    .nullable(),
  /**
   * The unit a new line of a bill starts in when the product is sold in it (a strip of 10): a unit id, or
   * "own" for each product's own unit. Null until the business sets it: STRIP.
   */
  "invoice.default_unit": z.union([Id, z.literal("own")]).nullable(),
  "credit.policy": z.strictObject({
    onLimitExceeded: policy,
    onOverdue: policy,
    overdueGraceDays: z.number().int().min(0).max(365),
  }),
  "orders.workflow": z.strictObject({
    requireConfirmation: z.boolean(),
    usePacking: z.boolean(),
    useDispatch: z.boolean(),
  }),
  "payments.allocation": z.enum(["oldest_first", "manual"]),
  "reports.aging_buckets": z
    .array(z.number().int().min(1).max(3650))
    .min(1)
    .max(6)
    .refine((b) => b.every((v, i) => i === 0 || v > b[i - 1]!), { message: "Buckets must increase" }),
  "suggestions.weights": z.strictObject({
    reorder: z.number().min(0).max(5),
    frequent: z.number().min(0).max(5),
    together: z.number().min(0).max(5),
    last_order: z.number().min(0).max(5),
  }),
  "suggestions.window_days": z.number().int().min(30).max(1095),
  /** The nightly job sets suggestions.weights from what the billing screen offered and what was taken (saving the weights by hand turns it off). */
  "suggestions.auto_tune": z.boolean(),
  /**
   * Letter of undertaking for exports and supplies to SEZ without payment of IGST (form GST RFD-11):
   * its ARN and the last day it is valid (the end of the financial year); null when the business has none.
   */
  "gst.lut": z
    .strictObject({ arn: z.string().trim().min(5).max(20).regex(/^[A-Za-z0-9/-]+$/), validUntil: z.iso.date() })
    .nullable(),
  /**
   * PF, ESI and professional tax worked out on each salary slip instead of entered by hand.
   * PF: the establishment code, contributions stopping at ₹15,000 (or on full wages) and how PF
   * wages are read. PT: the state (null = the business's) and its slabs (null = the built-in ones).
   */
  "payroll.statutory": z.strictObject({
    pf: z.strictObject({
      enabled: z.boolean(),
      establishmentCode: z.string().trim().toUpperCase().max(30).regex(/^[A-Z0-9/]*$/).nullable(),
      restrictToCeiling: z.boolean(),
      wagesRule: z.enum(["codes", "basic_da"]),
    }),
    esi: z.strictObject({ enabled: z.boolean(), employerCode: z.string().trim().max(20).regex(/^\d*$/).nullable() }),
    pt: z.strictObject({ enabled: z.boolean(), stateCode: StateCode.nullable(), rule: PtRuleSchema.nullable() }),
  }),
  /** E-invoicing applies (aggregate turnover above ₹5 crore): B2B, SEZ and export bills need an IRN. */
  "einvoice.enabled": z.boolean(),
  /** An e-way bill is due above this value of goods (₹50,000 in most states). */
  "ewaybill.threshold": z.number().int().min(0).max(10_000_000),
  /** Days a device may go without connecting before its saved copy is deleted (0 = never). */
  "offline.wipe_after_days": z.number().int().min(0).max(365),
  /**
   * Roles (by key) whose members must sign in with a code from an authenticator app as well; until they turn
   * it on, the business's screens stay closed to them. Only the owner changes it.
   */
  "security.two_step_roles": z
    .array(z.string().trim().min(1).max(50))
    .max(50)
    .refine((keys) => new Set(keys).size === keys.length, { message: "Each role once" }),
  "backup.schedule": z.strictObject({
    frequency: z.enum(["daily", "weekly", "off"]),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    retainDays: z.number().int().min(1).max(365),
  }),
  /**
   * TDS on buying goods (393(1) of the Income-tax Act, 2025; old 194Q), for a business whose turnover passed
   * ₹10 crore the year before: on each purchase bill, rate percent on the part of the year's purchases from
   * the supplier past the threshold (noPanRate when the supplier has no PAN). Off until the business turns it on.
   */
  "tds.purchases": z.strictObject({
    enabled: z.boolean(),
    threshold: z.number().int().min(0).max(1_000_000_000),
    rate: z.number().min(0).max(100),
    noPanRate: z.number().min(0).max(100),
  }),
  /**
   * TCS on sales of specified goods (394(1) of the Income-tax Act, 2025; old 206C(1) and 206C(1F)): collected
   * on each bill of the goods marked on the product (scrap, liquor, forest produce, minerals; a motor vehicle
   * or luxury goods worth more than the threshold apiece), rates percent by goods (twice, at least 5%,
   * without the buyer's PAN). Off until the business turns it on.
   */
  "tcs.sales": z.strictObject({
    enabled: z.boolean(),
    rates: z.partialRecord(z.enum(["liquor", "tendu", "timber_lease", "timber", "forest", "scrap", "minerals", "motor_vehicle", "luxury"]), z.number().min(0).max(100)),
    threshold: z.number().int().min(0).max(1_000_000_000),
  }),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTING_SCHEMAS)[K]>;

export const BusinessProfilePatch = z.strictObject({
  legalName: z.string().trim().min(2).max(200).optional(),
  tradeName: z.string().trim().max(200).nullable().optional(),
  gstin: Gstin.nullable().optional(),
  pan: Pan.nullable().optional(),
  gstRegistration: z.enum(["regular", "composition", "unregistered"]).optional(),
  stateCode: StateCode.optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  pincode: Pincode.nullable().optional(),
  phone: z.string().trim().max(15).nullable().optional(),
  email: z.email().nullable().optional(),
  financialYearStartMonth: z.number().int().min(1).max(12).optional(),
});

/** The firm's logo as a data URL (PNG, JPEG or WebP; the app shrinks it before upload). */
export const BusinessLogoBody = z.strictObject({
  image: z
    .string()
    .max(450_000)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
});

export const SeriesPatch = z.strictObject({
  name: z.string().trim().min(1).max(60).optional(),
  pattern: z.string().trim().min(3).max(40).optional(),
  isActive: z.boolean().optional(),
});
