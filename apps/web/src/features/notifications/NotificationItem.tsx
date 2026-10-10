import { BadgeIndianRupee, Bell, BellOff, Boxes, CalendarDays, ChartNoAxesColumn, ClipboardList, CloudOff, Hourglass, Package, Repeat, Send, Smartphone, Timer, Truck, UserPen, Wallet, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { cn } from "../../lib/cn";
import { useNotificationText, useTimeAgo, type NotificationRow, type Severity } from "./notifications";

const ICONS: Record<string, LucideIcon> = {
  customer_payment_due: Wallet,
  supplier_payment_due: Wallet,
  low_stock: Boxes,
  expiring_stock: Hourglass,
  pending_orders: ClipboardList,
  order_waiting: ClipboardList,
  to_pack: Package,
  order_to_pack: Package,
  to_dispatch: Truck,
  order_to_dispatch: Truck,
  leave_request: CalendarDays,
  leave_requested: CalendarDays,
  leave_approved: CalendarDays,
  leave_rejected: CalendarDays,
  salary_due: BadgeIndianRupee,
  offline_review: CloudOff,
  offline_reviewed: CloudOff,
  customer_edit_replaced: UserPen,
  devices_unsynced: Smartphone,
  orders_waiting: Timer,
  customer_reminders: Send,
  daily_summary: ChartNoAxesColumn,
  repeat_bills_made: Repeat,
  repeat_bill_failed: Repeat,
  reminders_stopped: BellOff,
  payment_received_online: BadgeIndianRupee,
};

const TINTS: Record<Severity, string> = {
  info: "bg-accent-soft text-accent-ink",
  success: "bg-good-soft text-good",
  warning: "bg-warn-soft text-warn",
  critical: "bg-danger-soft text-danger",
};

/**
 * One notification: what it is about (icon, tinted by severity), its text in
 * the app's language, and when it came. Unread ones are bold with a dot.
 */
export function NotificationItem({ n, onOpen, actions, compact }: { n: NotificationRow; onOpen(): void; actions?: ReactNode; compact?: boolean }) {
  const { t } = useI18n();
  const text = useNotificationText()(n);
  const ago = useTimeAgo();
  const Icon = ICONS[n.type] ?? Bell;
  const unread = !n.readAt;
  return (
    <div className={cn("group flex items-start gap-3 px-4", compact ? "py-2.5" : "py-3", unread && "bg-accent-soft/25")} data-notification={n.id}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <span className={cn("mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-xl", TINTS[n.severity] ?? TINTS.info)} aria-hidden>
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block text-[13.5px] leading-snug text-ink", unread ? "font-semibold" : "font-normal")}>{text.title}</span>
          {text.body && <span className={cn("mt-0.5 block text-[12.5px] leading-snug text-ink-2", compact && "line-clamp-2")}>{text.body}</span>}
          <span className="mt-1 block text-[11.5px] text-ink-3">
            <time dateTime={n.createdAt}>{ago(n.createdAt)}</time>
            {unread && <span className="sr-only">, {t("notifications.unread")}</span>}
          </span>
        </span>
      </button>
      {unread && <span className="mt-2 size-2 shrink-0 rounded-full bg-accent" aria-hidden />}
      {actions}
    </div>
  );
}
