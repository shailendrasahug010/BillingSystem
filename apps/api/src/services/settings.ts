import { SETTING_SCHEMAS, type SettingKey, type SettingValue } from "@digitalbahi/contracts";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, inArray } from "drizzle-orm";

/** Used when a business has no row for a key (e.g. a key added after it signed up). */
export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  "stock.negative_policy": "warn",
  "stock.valuation": "moving_average",
  "stock.expiry_warning_days": 30,
  "invoice.round_off": { mode: "nearest", step: 1 },
  "invoice.edit_window_hours": 24,
  "invoice.default_print_locale": "en",
  "invoice.offline_mode": "device_series",
  "invoice.terms": "",
  "invoice.payment_details": { bankName: "", accountNumber: "", ifsc: "", upiId: "" },
  // Not set: each unit's symbol's first letter (B for BOX, S for STRIP).
  "invoice.unit_letters": null,
  // Not set: new lines start in strips for products sold by the strip.
  "invoice.default_unit": null,
  "credit.policy": { onLimitExceeded: "warn", onOverdue: "warn", overdueGraceDays: 0 },
  "orders.workflow": { requireConfirmation: true, usePacking: true, useDispatch: true },
  "payments.allocation": "oldest_first",
  "reports.aging_buckets": [30, 60, 90],
  "suggestions.weights": { reorder: 1, frequent: 0.6, together: 0.5, last_order: 0.3 },
  "suggestions.window_days": 365,
  "suggestions.auto_tune": true,
  "backup.schedule": { frequency: "daily", time: "02:00", retainDays: 30 },
  "offline.wipe_after_days": 30,
  "gst.lut": null,
  "einvoice.enabled": false,
  "ewaybill.threshold": 50000,
  "payroll.statutory": {
    pf: { enabled: false, establishmentCode: null, restrictToCeiling: true, wagesRule: "codes" },
    esi: { enabled: false, employerCode: null },
    pt: { enabled: false, stateCode: null, rule: null },
  },
};

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTING_SCHEMAS, key);

/** Reads typed settings; a stored value that no longer validates falls back to the default. */
export async function getSettings<K extends SettingKey>(tx: Tx, businessId: string, keys: readonly K[]): Promise<{ [P in K]: SettingValue<P> }> {
  const rows = await tx
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.businessId, businessId), inArray(schema.settings.key, keys as unknown as string[])));
  const out = {} as { [P in K]: SettingValue<P> };
  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    const parsed = row ? SETTING_SCHEMAS[key].safeParse(row.value) : null;
    out[key] = (parsed?.success ? parsed.data : SETTING_DEFAULTS[key]) as SettingValue<typeof key>;
  }
  return out;
}

export async function getSetting<K extends SettingKey>(tx: Tx, businessId: string, key: K): Promise<SettingValue<K>> {
  return (await getSettings(tx, businessId, [key]))[key];
}
