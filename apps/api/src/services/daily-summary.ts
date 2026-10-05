import { REMINDERS, type ReminderConfig } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { createTranslator, formatCurrency, formatDate, isLocaleCode, type LocaleCode } from "@digitalbahi/i18n";
import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "../lib/context.js";
import { businessContact, loadSettings, ready, recipient, resolveChannels, type Channel } from "./messaging/queue.js";
import type { NewNotification } from "./notifications.js";
import { getSettings } from "./settings.js";

export interface DayFigures {
  sales: string;
  bills: number;
  collected: string;
  paid: string;
  expenses: string;
  receivable: string;
  overdue: string;
}

/** The business day in figures: bills and money in and out today, what customers owe and how much of it is overdue. */
export async function dayFigures(tx: Tx, businessId: string, today: string): Promise<DayFigures> {
  const [row] = (
    await tx.execute<{ sales: string; bills: number; collected: string; paid: string; expenses: string; receivable: string; overdue: string }>(sql`
      select
        (select coalesce(sum(grand_total), 0)::numeric(14,2)::text from invoices where business_id = ${businessId} and status = 'posted' and invoice_date = ${today}) as sales,
        (select count(*)::int from invoices where business_id = ${businessId} and status = 'posted' and invoice_date = ${today}) as bills,
        (select coalesce(sum(amount), 0)::numeric(14,2)::text from payments where business_id = ${businessId} and status <> 'cancelled' and direction = 'in' and payment_date = ${today}) as collected,
        (select coalesce(sum(amount), 0)::numeric(14,2)::text from payments where business_id = ${businessId} and status <> 'cancelled' and direction = 'out' and payment_date = ${today}) as paid,
        (select coalesce(sum(total_amount), 0)::numeric(14,2)::text from expenses where business_id = ${businessId} and status = 'posted' and deleted_at is null and expense_date = ${today}) as expenses,
        (select coalesce(sum(balance), 0)::numeric(14,2)::text from customers where business_id = ${businessId} and deleted_at is null and balance > 0) as receivable,
        (select coalesce(sum(balance_due), 0)::numeric(14,2)::text from invoices where business_id = ${businessId} and status = 'posted' and balance_due > 0 and due_date < ${today}) as overdue`)
  ).rows;
  return row!;
}

/**
 * The daily summary: the day's figures sent in the evening to the owner's
 * phone (the numbers set on the rule, else the business's own) by WhatsApp,
 * SMS or email as the rule says. Once a day per number: a second run that
 * day (Send now, then the scheduled one) sends nothing more. Staff who see
 * sales reports are told it went.
 */
export async function queueDailySummary(deps: AppDeps, tx: Tx, businessId: string, today: string, config: ReminderConfig): Promise<{ queued: number; notification: NewNotification | null }> {
  const c = { ...REMINDERS.daily_summary.defaults, ...config };
  const [settings, business, defaults, figures, [phone]] = await Promise.all([
    loadSettings(tx, businessId),
    businessContact(tx, businessId),
    getSettings(tx, businessId, ["invoice.default_print_locale"] as const),
    dayFigures(tx, businessId, today),
    tx.select({ phone: schema.businesses.phone }).from(schema.businesses).where(eq(schema.businesses.id, businessId)),
  ]);
  const channels = resolveChannels(deps, settings, business);
  const stored = defaults["invoice.default_print_locale"] as string;
  const locale: LocaleCode = isLocaleCode(stored) ? stored : "en";
  const { t } = createTranslator(locale);
  const money = (v: string) => formatCurrency(v, locale, { decimals: 0 });
  const params = {
    business: business.name,
    date: formatDate(today),
    sales: money(figures.sales),
    count: figures.bills,
    collected: money(figures.collected),
    paid: money(figures.paid),
    expenses: money(figures.expenses),
    receivable: money(figures.receivable),
    overdue: money(figures.overdue),
  };
  const body = t("messages.dailySummary", params);
  const numbers = c.recipients?.length ? c.recipients : phone?.phone ? [phone.phone] : [];
  const pick = (to: string): Channel | null => {
    const can = (ch: Channel) => ready(deps, channels, ch) && recipient(ch, to) !== null;
    if (c.channel === "whatsapp_or_sms") return can("whatsapp") ? "whatsapp" : can("sms") ? "sms" : null;
    if (c.channel === "email") return can("email") ? "email" : null;
    return can(c.channel!) ? c.channel! : null;
  };
  const m = schema.messages;
  let queued = 0;
  let unreachable = 0;
  for (const number of numbers) {
    const channel = pick(number);
    const to = channel ? recipient(channel, number) : null;
    if (!channel || !to) {
      unreachable++;
      continue;
    }
    const [sent] = await tx.select({ id: m.id }).from(m).where(and(eq(m.businessId, businessId), eq(m.kind, "summary"), eq(m.recipient, to), eq(m.reminderOn, today))).limit(1);
    if (sent) continue;
    await tx.insert(m).values({ id: uuidv7(), businessId, channel, kind: "summary", recipient: to, partyName: business.name, subject: null, body, locale, automatic: true, reminderOn: today });
    queued++;
  }
  if (!queued && !unreachable) return { queued: 0, notification: null };
  return {
    queued,
    notification: {
      type: "daily_summary",
      permission: REMINDERS.daily_summary.permission,
      dedupeKey: `daily_summary:${today}`,
      severity: queued ? "info" : "warning",
      titleKey: queued ? "notifications.daily_summary.title" : "notifications.daily_summary.noneSent",
      bodyKey: null,
      params: { count: queued, sales: figures.sales, collected: figures.collected },
    },
  };
}
