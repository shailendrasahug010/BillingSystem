import { customerReminderDue, REMINDERS, type ReminderConfig } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { createTranslator, formatCurrency, formatDate, isLocaleCode, type LocaleCode } from "@digitalbahi/i18n";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AppDeps } from "../lib/context.js";
import { businessContact, loadSettings, ready, recipient, resolveChannels, type Channel } from "./messaging/queue.js";
import type { NewNotification } from "./notifications.js";
import { getSettings } from "./settings.js";

/**
 * Automatic payment reminders (Phase 5.2): once a day, at the rule's hour,
 * customers with overdue bills get a reminder by WhatsApp, SMS or email, on
 * the rule's schedule (the first some days after the oldest bill fell due,
 * then every few days, at most so many times while those bills stay unpaid),
 * in their own language. Customers who asked not to get them (or replied
 * STOP on WhatsApp) never do; nor do those owing less than the rule's
 * minimum. Each goes into the messages log as automatic, with the business
 * day it went for (the schedule counts those), and the staff who send
 * messages are told how many went.
 */

export interface DueCustomer {
  customerId: string;
  name: string;
  /** What they owe in all, and how much of it is overdue. */
  balance: string;
  overdue: string;
  /** Due date of the oldest unpaid overdue bill. */
  oldestDue: string;
  daysOverdue: number;
  /** Automatic reminders sent since that bill fell due, and the day the last went. */
  sentSinceDue: number;
  lastSentOn: string | null;
  /** The channel it goes by and the number or address, or why it cannot go. */
  channel: Channel | null;
  to: string | null;
  skip: "no_contact" | null;
  locale: LocaleCode;
}

type Candidate = {
  id: string;
  name: string;
  mobile: string | null;
  email: string | null;
  message_locale: string | null;
  balance: string;
  overdue: string;
  oldest_due: string;
  sent_since_due: number;
  last_sent_on: string | null;
};

/** Who gets a reminder today under the rule's settings (and who would but cannot be reached). */
export async function dueCustomers(deps: AppDeps, tx: Tx, businessId: string, today: string, config: ReminderConfig): Promise<DueCustomer[]> {
  const c = { ...REMINDERS.customer_reminders.defaults, ...config };
  const [settings, business, defaults] = await Promise.all([loadSettings(tx, businessId), businessContact(tx, businessId), getSettings(tx, businessId, ["invoice.default_print_locale"] as const)]);
  const channels = resolveChannels(deps, settings, business);
  const fallback = defaults["invoice.default_print_locale"] as string;
  const rows = (
    await tx.execute<Candidate>(sql`
      select c.id, coalesce(c.business_name, c.name) as name, c.mobile, c.email, c.message_locale, c.balance::text,
             od.amount::text as overdue, od.oldest::text as oldest_due,
             (select count(*)::int from messages m where m.business_id = c.business_id and m.party_id = c.id and m.automatic and m.reminder_on >= od.oldest) as sent_since_due,
             (select max(m.reminder_on)::text from messages m where m.business_id = c.business_id and m.party_id = c.id and m.automatic and m.reminder_on >= od.oldest) as last_sent_on
      from customers c
      join lateral (
        select sum(i.balance_due) as amount, min(i.due_date) as oldest from invoices i
        where i.customer_id = c.id and i.status = 'posted' and i.balance_due > 0 and i.due_date < ${today}
      ) od on od.amount is not null
      where c.business_id = ${businessId} and c.deleted_at is null and c.is_active and not c.reminders_opt_out
        and od.amount >= ${c.minAmount!} and c.balance > 0
      order by od.amount desc
      limit 1000`)
  ).rows;
  const pick = (r: Candidate): Channel | null => {
    const can = (ch: Channel) => ready(deps, channels, ch) && recipient(ch, (ch === "email" ? r.email : r.mobile) ?? "") !== null;
    if (c.channel === "whatsapp_or_sms") return can("whatsapp") ? "whatsapp" : can("sms") ? "sms" : null;
    return can(c.channel!) ? c.channel! : null;
  };
  const out: DueCustomer[] = [];
  for (const r of rows) {
    const decision = customerReminderDue({ today, oldestDue: r.oldest_due, sentSinceDue: r.sent_since_due, lastSentOn: r.last_sent_on, config: c });
    if (!decision.due) continue;
    const channel = pick(r);
    const to = channel ? recipient(channel, (channel === "email" ? r.email : r.mobile) ?? "") : null;
    out.push({
      customerId: r.id,
      name: r.name,
      balance: r.balance,
      overdue: r.overdue,
      oldestDue: r.oldest_due,
      daysOverdue: decision.daysOverdue,
      sentSinceDue: r.sent_since_due,
      lastSentOn: r.last_sent_on,
      channel,
      to,
      skip: channel ? null : "no_contact",
      locale: isLocaleCode(r.message_locale) ? r.message_locale : isLocaleCode(fallback) ? fallback : "en",
    });
  }
  return out;
}

/**
 * Queues today's reminders (sent after the transaction by the message queue)
 * and returns the staff notification saying how many went, or null when
 * nobody was due.
 */
export async function queueCustomerReminders(deps: AppDeps, tx: Tx, businessId: string, today: string, config: ReminderConfig): Promise<{ queued: number; notification: NewNotification | null }> {
  const due = await dueCustomers(deps, tx, businessId, today, config);
  if (!due.length) return { queued: 0, notification: null };
  const settings = await loadSettings(tx, businessId);
  const business = await businessContact(tx, businessId);
  let queued = 0;
  let total = 0;
  for (const d of due) {
    if (!d.channel || !d.to) continue;
    const { t } = createTranslator(d.locale);
    const money = (v: string) => formatCurrency(v, d.locale);
    const params = { party: d.name, business: business.name, balance: money(d.balance), overdue: money(d.overdue), since: formatDate(d.oldestDue) };
    // STOP is acted on only on WhatsApp (the business's number receives the replies).
    const text = `${t("messages.reminder", params)}${d.channel === "whatsapp" ? ` ${t("messages.reminderStop")}` : ""}`;
    const template =
      d.channel === "whatsapp" && settings?.whatsappReminderTemplate
        ? {
            name: settings.whatsappReminderTemplate,
            language: d.locale === "hi" && settings.whatsappTemplateLanguageHi ? settings.whatsappTemplateLanguageHi : settings.whatsappTemplateLanguage,
            params: [d.name, params.balance, params.overdue, business.name],
          }
        : d.channel === "sms" && (settings?.smsReminderTemplate || settings?.smsReminderTemplateHi)
          ? { name: (d.locale === "hi" ? settings.smsReminderTemplateHi : null) ?? settings.smsReminderTemplate ?? settings.smsReminderTemplateHi!, language: d.locale, params: [] }
          : null;
    const inserted = await tx
      .insert(schema.messages)
      .values({
        id: uuidv7(),
        businessId,
        channel: d.channel,
        kind: "reminder",
        partyType: "customer",
        partyId: d.customerId,
        partyName: d.name,
        recipient: d.to,
        subject: d.channel === "email" ? t("messages.subject.reminder", { business: business.name }) : null,
        body: text,
        template,
        locale: d.locale,
        automatic: true,
        reminderOn: today,
      })
      // One a day per customer, even if two runs meet.
      .onConflictDoNothing()
      .returning({ id: schema.messages.id });
    if (!inserted.length) continue;
    queued++;
    total += Number(d.overdue);
  }
  const unreachable = due.filter((d) => !d.channel).length;
  if (!queued && !unreachable) return { queued: 0, notification: null };
  return {
    queued,
    notification: {
      type: "customer_reminders",
      permission: REMINDERS.customer_reminders.permission,
      dedupeKey: `customer_reminders:${today}`,
      severity: unreachable && !queued ? "warning" : "info",
      titleKey: queued ? "notifications.customer_reminders.title" : "notifications.customer_reminders.noneSent",
      bodyKey: unreachable ? "notifications.customer_reminders.unreachable" : null,
      params: { count: queued, amount: total.toFixed(2), unreachable },
    },
  };
}
