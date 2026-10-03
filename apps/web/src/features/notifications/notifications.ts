import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createTranslator, fieldLabels, notificationParams, notificationText, type LocaleCode } from "@digitalbahi/i18n";
import { useCallback, useEffect } from "react";
import { useI18n } from "../../app/i18n";
import type { Route } from "../../app/router";
import { requestPull } from "../../data/live";
import { api, ApiError, readEventStream } from "../../lib/api";
import { workingOffline } from "../../offline/sync";

/**
 * Notifications (Phase 5.2): the person's inbox, its unread count, and the
 * live stream that tells the app when a new one arrives. The server sends
 * translation keys and parameters, so each notification reads in the
 * language the app is in.
 */

export type Severity = "info" | "success" | "warning" | "critical";

export interface NotificationRow {
  id: string;
  type: string;
  severity: Severity;
  titleKey: string;
  bodyKey: string | null;
  params: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  readAt: string | null;
}

/** How the automatic payment reminders go: WhatsApp (SMS for those without it), or one channel. */
export type ReminderChannel = "whatsapp_or_sms" | "whatsapp" | "sms" | "email";

export interface ReminderConfig {
  hour: number;
  daysBefore?: number;
  dayOfMonth?: number;
  afterHours?: number;
  /** Payment reminders to customers: the schedule, the least overdue amount, the channel. */
  firstAfterDays?: number;
  repeatDays?: number;
  maxCount?: number;
  minAmount?: number;
  channel?: ReminderChannel;
}

export interface ReminderRule {
  type: string;
  permission: string;
  events: boolean;
  /** Looked at every hour from its hour (orders waiting), not once a day. */
  hourly: boolean;
  isActive: boolean;
  config: ReminderConfig;
  defaults: ReminderConfig;
  lastRunOn: string | null;
  lastRunAt: string | null;
}

/** A customer the automatic payment reminders write to today (or would, but cannot reach). */
export interface DueCustomer {
  customerId: string;
  name: string;
  balance: string;
  overdue: string;
  oldestDue: string;
  daysOverdue: number;
  sentSinceDue: number;
  lastSentOn: string | null;
  channel: "whatsapp" | "sms" | "email" | null;
  skip: "no_contact" | null;
  locale: LocaleCode;
}

/** Every notification query starts with this key, so one invalidation refreshes them all. */
export const NOTIFICATIONS = "notifications";

export function useUnreadCount(enabled = true) {
  return useQuery({
    queryKey: [NOTIFICATIONS, "unread"],
    queryFn: ({ signal }) => api.get<{ unread: number }>("/notifications/unread-count", undefined, signal),
    enabled,
    select: (d) => d.unread,
    // The live stream refreshes it; this covers a stream that cannot connect.
    refetchInterval: 5 * 60_000,
  });
}

export function useRecentNotifications(enabled: boolean, limit = 8) {
  return useQuery({
    queryKey: [NOTIFICATIONS, "recent", limit],
    queryFn: ({ signal }) => api.get<{ data: NotificationRow[]; unread: number }>("/notifications", { limit }, signal),
    enabled,
  });
}

export const markRead = (id: string) => api.post<null>(`/notifications/${id}/read`);
export const dismiss = (id: string) => api.post<null>(`/notifications/${id}/dismiss`);
export const markAllRead = () => api.post<{ marked: number }>("/notifications/read-all");

/** Refreshes every notification query (after reading, dismissing or a new arrival). */
export function useRefreshNotifications(): () => void {
  const client = useQueryClient();
  return useCallback(() => void client.invalidateQueries({ queryKey: [NOTIFICATIONS] }), [client]);
}

/** The parameters as the texts use them: months spelled out, field names as labels, a dash for a missing value. */
export function displayParams(params: Record<string, unknown>, locale: LocaleCode): Record<string, string | number> {
  return notificationParams(params, createTranslator(locale));
}

/** "mobile,city" as "Mobile, City" in the app's language. */
export function useFieldLabels(): (fields: string[] | string) => string {
  const { t } = useI18n();
  return useCallback((fields) => fieldLabels(fields, { t }), [t]);
}

/** The title and body of a notification in the app's language (as the push messages to phones read). */
export function useNotificationText(): (n: NotificationRow) => { title: string; body: string | null } {
  const { t, has, locale } = useI18n();
  return useCallback((n) => notificationText(n, { t, has, locale }), [t, has, locale]);
}

/** "now", "5 minutes ago", "yesterday"; older ones as a date. */
export function useTimeAgo(): (iso: string) => string {
  const { locale, dateTime } = useI18n();
  return useCallback(
    (iso) => {
      const rtf = new Intl.RelativeTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { numeric: "auto" });
      const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 60) return rtf.format(0, "second");
      if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
      if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
      if (abs < 7 * 86_400) return rtf.format(Math.round(seconds / 86_400), "day");
      return dateTime(iso);
    },
    [locale, dateTime],
  );
}

/** The screen where the person acts on a notification. */
export function targetRoute(n: Pick<NotificationRow, "type" | "entityType" | "entityId">): Route | null {
  if (n.entityType === "sales_order" && n.entityId) return { name: "order-view", orderId: n.entityId };
  if (n.entityType === "invoice" && n.entityId) return { name: "invoice-view", invoiceId: n.entityId };
  if (n.entityType === "customer" && n.entityId) return { name: "customer", customerId: n.entityId };
  switch (n.type) {
    case "customer_payment_due":
      return { name: "outstanding" };
    case "supplier_payment_due":
      return { name: "planned", module: "payments" };
    case "low_stock":
    case "expiring_stock":
      return { name: "planned", module: "inventory" };
    case "pending_orders":
      return { name: "planned", module: "orders" };
    case "to_pack":
      return { name: "planned", module: "packing" };
    case "to_dispatch":
      return { name: "planned", module: "dispatch" };
    case "salary_due":
      return { name: "planned", module: "payroll" };
    case "devices_unsynced":
      return { name: "settings" };
    case "orders_waiting":
      return { name: "planned", module: "orders" };
    case "customer_reminders":
      return { name: "planned", module: "messages" };
    case "leave_request":
    case "leave_requested":
    case "leave_approved":
    case "leave_rejected":
      return { name: "planned", module: "leave" };
    default:
      return null;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Keeps the live stream open while the person is signed in to a business:
 * each new notification refreshes the bell and the inbox. The server ends the
 * stream when the access token would expire; it is opened again at once (with
 * a fresh token), and after a failure with a growing wait. While working
 * offline nothing is opened.
 */
export function useNotificationStream(businessId: string | null | undefined): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!businessId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pull = false;
    // Several notifications at once (the morning checks) refresh once.
    const refresh = (changed = false) => {
      pull ||= changed;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void client.invalidateQueries({ queryKey: [NOTIFICATIONS] });
        // A new one is often about a change (an order, a customer who stopped reminders): the device's copy catches up now.
        if (pull) requestPull();
        pull = false;
      }, 300);
    };
    void (async () => {
      let wait = 0;
      while (!abort.signal.aborted) {
        if (workingOffline()) {
          await sleep(15_000, abort.signal);
          continue;
        }
        const opened = Date.now();
        let failed = false;
        try {
          await readEventStream(
            "/notifications/stream",
            (event) => {
              // "ready" also covers anything that arrived while the stream was closed.
              if (event === "ready" || event === "notification") refresh(event === "notification");
              else if (event === "unavailable") failed = true;
            },
            abort.signal,
          );
        } catch (e) {
          if (abort.signal.aborted) return;
          // Signed out, or the role no longer sees notifications.
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return;
          failed = true;
        }
        // A stream that ends right away is treated as a failure, so it is never reopened in a tight loop.
        wait = failed || Date.now() - opened < 10_000 ? Math.min(Math.max(wait * 2, 5_000), 60_000) : 0;
        await sleep(wait, abort.signal);
      }
    })();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [businessId, client]);
}
