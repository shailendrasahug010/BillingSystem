import { Bell, CheckCheck } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { useSession } from "../../app/session";
import { NotificationItem } from "../../features/notifications/NotificationItem";
import { markAllRead, markRead, targetRoute, useNotificationStream, useRecentNotifications, useRefreshNotifications, useUnreadCount, type NotificationRow } from "../../features/notifications/notifications";
import { Skeleton } from "../ui/misc";

/**
 * The bell in the top bar (live app): the unread count, kept current by the
 * live stream it keeps open, and the latest notifications in a panel. Opening one marks it
 * read and goes to the screen where it is acted on.
 */
export function NotificationBell() {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  useNotificationStream(useSession().me?.business?.id);
  const unread = useUnreadCount();
  const recent = useRecentNotifications(open);
  const refresh = useRefreshNotifications();
  const count = unread.data ?? 0;
  const label = count ? `${t("nav.notifications")}, ${t("notifications.unreadCount", { count })}` : t("nav.notifications");

  const openItem = (n: NotificationRow) => {
    setOpen(false);
    if (!n.readAt) void markRead(n.id).then(refresh, () => undefined);
    navigate(targetRoute(n) ?? { name: "planned", module: "notifications" });
  };
  const readAll = () => void markAllRead().then(refresh, () => undefined);
  const rows = recent.data?.data ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="press touch-40 relative inline-flex size-9 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2" aria-label={label} title={label}>
          <Bell size={18} />
          {count > 0 && (
            <span className="absolute top-0.5 right-0.5 min-w-[17px] rounded-full bg-danger px-1 text-center text-[10px] leading-[17px] font-semibold text-ink-inverse tabular-nums ring-2 ring-surface" aria-hidden data-testid="unread-badge">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t("notifications.title")}
          className="z-50 flex max-h-[min(34rem,calc(var(--app-vh)*0.8))] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <p className="font-display text-[15px] font-semibold text-ink">{t("notifications.title")}</p>
            {count > 0 && <span className="text-[12px] text-ink-3">{t("notifications.unreadCount", { count })}</span>}
            {count > 0 && (
              <button type="button" onClick={readAll} className="press ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-accent-ink hover:bg-accent-soft">
                <CheckCheck size={14} />
                {t("notifications.markAllRead")}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {recent.isPending ? (
              <div className="flex flex-col gap-3 p-4">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-ink-3">{t("notifications.empty")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((n) => (
                  <li key={n.id}>
                    <NotificationItem n={n} compact onOpen={() => openItem(n)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate({ name: "planned", module: "notifications" });
            }}
            className="press border-t border-line px-4 py-2.5 text-center text-[13px] font-medium text-accent-ink hover:bg-surface-2"
          >
            {t("notifications.seeAll")}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
