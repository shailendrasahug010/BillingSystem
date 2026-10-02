import { localeInfo, type LocaleCode } from "./registry.js";
import type { TranslationKey, Translator } from "./translate.js";

/**
 * A notification's title and text in one language (Phase 5.2). The server
 * stores translation keys and parameters; the app's inbox and the push
 * messages sent to phones both write them out with these, so they read the
 * same.
 */

/** Customer fields by the labels the forms use (a customer change made offline names them). */
export const CUSTOMER_FIELD_LABELS: Readonly<Record<string, TranslationKey>> = {
  name: "customer.name",
  businessName: "customer.businessName",
  mobile: "customer.mobile",
  altMobile: "customer.altMobile",
  email: "customer.email",
  addressLine1: "customer.address",
  addressLine2: "customer.address",
  city: "common.city",
  pincode: "customer.pincode",
  stateCode: "common.state",
  gstin: "customer.gstin",
  pan: "customer.pan",
  creditLimit: "customer.creditLimit",
  creditDays: "customer.creditDays",
  routeId: "customer.route",
  priceLevelId: "customer.priceLevel",
  categoryId: "customer.category",
  salesRepId: "customer.salesRep",
  messageLocale: "customer.messageLocale",
  remindersOptOut: "customer.remindersOptOut",
};

/** "mobile,city" as "Mobile, City" in the translator's language (each label once). */
export function fieldLabels(fields: string[] | string, translator: Pick<Translator, "t">): string {
  const list = typeof fields === "string" ? fields.split(",") : fields;
  return [...new Set(list.map((f) => (CUSTOMER_FIELD_LABELS[f] ? translator.t(CUSTOMER_FIELD_LABELS[f]) : f)))].join(", ");
}

/** A "YYYY-MM" month as the language writes it ("September 2026"). */
export function monthName(month: string, locale: LocaleCode): string {
  return new Intl.DateTimeFormat(localeInfo(locale).intl, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

/** The parameters as the texts use them: months spelled out, field names as their labels, a dash for a missing value. */
export function notificationParams(params: Record<string, unknown>, translator: Pick<Translator, "t" | "locale">): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = k === "month" && /^\d{4}-\d{2}$/.test(v) ? monthName(v, translator.locale) : k === "fields" ? fieldLabels(v, translator) : v;
    else if (v === null || v === undefined) out[k] = "—";
  }
  return out;
}

/** The title and text of a notification; one from a newer server whose text this version lacks gets the generic title. */
export function notificationText(n: { titleKey: string; bodyKey: string | null; params: Record<string, unknown> }, translator: Translator): { title: string; body: string | null } {
  const params = notificationParams(n.params, translator);
  const title = translator.has(n.titleKey) ? translator.t(n.titleKey as TranslationKey, params) : translator.t("notifications.generic");
  const body = n.bodyKey && translator.has(n.bodyKey) ? translator.t(n.bodyKey as TranslationKey, params) : null;
  return { title, body };
}
