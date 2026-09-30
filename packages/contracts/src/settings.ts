import { z } from "zod";
import { Gstin, Pan, Pincode, StateCode } from "./common.js";

const policy = z.enum(["allow", "warn", "block"]);

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
  /** Days a device may go without connecting before its saved copy is deleted (0 = never). */
  "offline.wipe_after_days": z.number().int().min(0).max(365),
  "backup.schedule": z.strictObject({
    frequency: z.enum(["daily", "weekly", "off"]),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    retainDays: z.number().int().min(1).max(365),
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
