import { z } from "zod";

/**
 * Money, rates and quantities travel as decimal STRINGS ("12500.00") so no
 * client ever parses money into a floating-point number.
 */
const decimal = (maxDecimals: number, allowNegative = false) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^${allowNegative ? "-?" : ""}\\d{1,13}(\\.\\d{1,${maxDecimals}})?$`), {
      message: `Expected a decimal number with at most ${maxDecimals} decimals`,
    });

export const Money = decimal(2);
export const SignedMoney = decimal(2, true);
export const Rate = decimal(4);
export const Qty = decimal(3);
export const Percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,3})?$/)
  .refine((v) => Number(v) <= 100, { message: "Must be between 0 and 100" });

export const Id = z.uuid();
export const IsoDate = z.iso.date();
export const StateCode = z.string().regex(/^\d{2}$/, { message: "Two-digit GST state code" });
export const Gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-Z]{15}$/, { message: "15 characters" });
export const Pan = z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/);
export const Mobile = z.string().trim().min(10).max(16);
export const Pincode = z.string().regex(/^[1-9][0-9]{5}$/);
export const Hsn = z.string().regex(/^(?:\d{4}|\d{6}|\d{8})$/);
export const Code = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9/_-]+$/);

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
  q: z.string().trim().max(100).optional(),
});

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export const PaymentMethod = z.enum(["cash", "upi", "bank_transfer", "cheque", "card", "other"]);
export const GstRegistration = z.enum(["regular", "composition", "unregistered", "consumer", "sez", "overseas", "deemed_export"]);

/** Error body returned by every failing request. */
export interface ApiErrorBody {
  error: {
    code: string;
    params?: Record<string, string | number>;
    field?: string;
    details?: Array<{ field: string; code: string; params?: Record<string, string | number> }>;
    requestId?: string;
  };
}

type StripDefault<T> = T extends z.ZodDefault<infer Inner> ? StripDefault<Inner> : T;
type PatchShape<S extends z.ZodRawShape> = { [K in keyof S]: z.ZodOptional<StripDefault<S[K]>> };

/**
 * Update (PATCH) schema from a create schema: every field optional and NO
 * defaults. (Zod 4 applies .default() values even inside .partial(), which
 * would silently reset fields the client did not send.)
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<PatchShape<S>, z.core.$strict> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let inner = field as z.ZodType;
    while (inner instanceof z.ZodDefault) inner = inner.unwrap() as z.ZodType;
    shape[key] = inner.optional();
  }
  return z.strictObject(shape) as unknown as z.ZodObject<PatchShape<S>, z.core.$strict>;
}
