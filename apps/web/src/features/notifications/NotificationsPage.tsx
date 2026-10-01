import { useQuery, useQueryClient } from "@tanstack/react-query";
import { translateError, type TranslationKey } from "@digitalbahi/i18n";
import { Check, CheckCheck, X } from "lucide-react";
import { Tabs } from "radix-ui";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button, IconButton } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Checkbox, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { ErrorNote, LoadMore, PageHeader, TAB_TRIGGER } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { usePaged } from "../../lib/usePaged";
import { NotificationItem } from "./NotificationItem";
import { dismiss, markAllRead, markRead, NOTIFICATIONS, targetRoute, useRefreshNotifications, useUnreadCount, type NotificationRow, type ReminderRule } from "./notifications";

/**
 * Notifications: the person's inbox (theirs and their role's) and the
 * business's reminder rules, which someone allowed to configure
 * notifications can switch on and off and time.
 */
export function NotificationsPage() {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const unread = useUnreadCount();
  const refresh = useRefreshNotifications();
  const count = unread.data ?? 0;
  const readAll = async () => {
    try {
      const { marked } = await markAllRead();
      toast({ tone: "success", title: t("notifications.markedAll", { count: marked }) });
    } catch (e) {
      toast({ tone: e instanceof ApiError && e.code === "network" ? "offline" : "danger", title: t("notifications.markAllRead"), body: e instanceof ApiError ? translateError(i18n, e) : "" });
    } finally {
      refresh();
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("notifications.title")}
        subtitle={count ? t("notifications.unreadCount", { count }) : t("notifications.subtitle")}
        actions={
          count > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => void readAll()}>
              <CheckCheck size={15} />
              {t("notifications.markAllRead")}
            </Button>
          ) : undefined
        }
      />
      <Tabs.Root defaultValue="inbox" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("notifications.title")}>
          <Tabs.Trigger value="inbox" className={TAB_TRIGGER}>
            {t("notifications.tabs.inbox")}
          </Tabs.Trigger>
          <Tabs.Trigger value="rules" className={TAB_TRIGGER}>
            {t("notifications.tabs.rules")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="inbox">
          <Inbox />
        </Tabs.Content>
        <Tabs.Content value="rules">
          <Rules />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function Inbox() {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const refresh = useRefreshNotifications();
  const [status, setStatus] = useState<"all" | "unread">("all");
  const list = usePaged<NotificationRow>(NOTIFICATIONS, "/notifications", { status }, { pageSize: 30 });
  const act = (fn: () => Promise<unknown>) => void fn().then(refresh, refresh);
  const open = (n: NotificationRow) => {
    if (!n.readAt) act(() => markRead(n.id));
    const to = targetRoute(n);
    if (to) navigate(to);
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Segmented
          label={t("common.filter")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: t("common.all") },
            { value: "unread", label: t("notifications.unread") },
          ]}
        />
      </div>
      {list.error ? <ErrorNote error={list.error} /> : null}
      <Card className="overflow-hidden">
        {list.loading ? (
          <div className="flex flex-col gap-3 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.rows.length === 0 ? (
          <p className="p-8 text-center text-[14px] text-ink-3">{t(status === "unread" ? "notifications.emptyUnread" : "notifications.empty")}</p>
        ) : (
          <ul className="divide-y divide-line" aria-label={t("notifications.tabs.inbox")}>
            {list.rows.map((n) => (
              <li key={n.id}>
                <NotificationItem
                  n={n}
                  onOpen={() => open(n)}
                  actions={
                    <span className="flex shrink-0 items-center">
                      {!n.readAt && (
                        <IconButton label={t("notifications.markRead")} className="size-8" onClick={() => act(() => markRead(n.id))}>
                          <Check size={15} />
                        </IconButton>
                      )}
                      <IconButton label={t("notifications.dismiss")} className="size-8" onClick={() => act(() => dismiss(n.id))}>
                        <X size={15} />
                      </IconButton>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
    </div>
  );
}

const RULES_KEY = ["reminder-rules"];

/** The choices, with the saved value among them (it may have been set to another one through the API). */
const withValue = (choices: number[], value: number | undefined) => (value === undefined || choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b));

function Rules() {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const toast = useToast();
  const client = useQueryClient();
  const canEdit = allowed("notification.configure");
  const rules = useQuery({ queryKey: RULES_KEY, queryFn: ({ signal }) => api.get<{ data: ReminderRule[] }>("/reminder-rules", undefined, signal) });
  const [saving, setSaving] = useState<string | null>(null);
  const refresh = useRefreshNotifications();

  const save = async (rule: ReminderRule, patch: { isActive?: boolean; config?: Partial<ReminderRule["config"]> }) => {
    setSaving(rule.type);
    try {
      const updated = await api.patch<ReminderRule>(`/reminder-rules/${rule.type}`, patch);
      client.setQueryData<{ data: ReminderRule[] }>(RULES_KEY, (d) => d && { data: d.data.map((r) => (r.type === updated.type ? updated : r)) });
      toast({ tone: "success", title: t("notifications.rules.saved") });
    } catch (e) {
      toast({ tone: "danger", title: t(`notifications.rules.types.${rule.type}.name` as TranslationKey), body: e instanceof ApiError ? translateError(i18n, e) : "" });
    } finally {
      setSaving(null);
    }
  };

  const check = async (rule: ReminderRule) => {
    setSaving(rule.type);
    try {
      const { result } = await api.post<{ result: "raised" | "already" | "nothing" }>(`/reminder-rules/${rule.type}/check`);
      toast({ tone: result === "nothing" ? "info" : "success", title: t(result === "raised" ? "notifications.rules.checkedRaised" : result === "already" ? "notifications.rules.checkedAlready" : "notifications.rules.checkedNothing") });
      refresh();
    } catch (e) {
      toast({ tone: "danger", title: t(`notifications.rules.types.${rule.type}.name` as TranslationKey), body: e instanceof ApiError ? translateError(i18n, e) : "" });
    } finally {
      setSaving(null);
    }
  };

  const hourLabel = (h: number) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, h)));
  const permissionLabel = (p: string) => {
    const [module, action] = p.split(".");
    return `${t(`perm.modules.${module}` as TranslationKey)}: ${t(`perm.actions.${action}` as TranslationKey)}`;
  };

  if (rules.error) return <ErrorNote error={rules.error} />;
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-[13.5px] text-ink-2">{t("notifications.rules.intro")}</p>
      {!canEdit && <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-3">{t("notifications.rules.readOnly")}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        {rules.isPending
          ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 w-full rounded-[var(--radius-card)]" />)
          : rules.data.data.map((r) => {
              const disabled = !canEdit || saving === r.type;
              const name = t(`notifications.rules.types.${r.type}.name` as TranslationKey);
              return (
                <Card key={r.type} className="flex flex-col gap-3 p-4" data-rule={r.type}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink">
                        {name}
                        {r.events && <Badge tone="accent">{t("notifications.rules.asItHappens")}</Badge>}
                      </p>
                      <p className="mt-0.5 text-[13px] text-ink-2">{t(`notifications.rules.types.${r.type}.help` as TranslationKey)}</p>
                    </div>
                    <Checkbox label={t("notifications.rules.on")} checked={r.isActive} disabled={disabled} onChange={(v) => void save(r, { isActive: v })} className="shrink-0 text-[13px]" />
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-[12px] text-ink-3">
                      {t("notifications.rules.hour")}
                      <Select aria-label={`${name}: ${t("notifications.rules.hour")}`} value={r.config.hour} disabled={disabled || !r.isActive} onChange={(e) => void save(r, { config: { hour: Number(e.target.value) } })} className="w-32">
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h}>
                            {hourLabel(h)}
                          </option>
                        ))}
                      </Select>
                    </label>
                    {r.defaults.daysBefore !== undefined && (
                      <label className="flex flex-col gap-1 text-[12px] text-ink-3" title={t("notifications.rules.daysBeforeHint")}>
                        {t("notifications.rules.daysBefore")}
                        <Select aria-label={`${name}: ${t("notifications.rules.daysBefore")}`} value={r.config.daysBefore ?? r.defaults.daysBefore} disabled={disabled || !r.isActive} onChange={(e) => void save(r, { config: { daysBefore: Number(e.target.value) } })} className="w-28">
                          {withValue([0, 1, 2, 3, 5, 7, 10, 15, 30], r.config.daysBefore).map((d) => (
                            <option key={d} value={d}>
                              {t("common.days", { count: d })}
                            </option>
                          ))}
                        </Select>
                      </label>
                    )}
                    {r.defaults.afterHours !== undefined && (
                      <label className="flex flex-col gap-1 text-[12px] text-ink-3" title={t("notifications.rules.afterHoursHint")}>
                        {t("notifications.rules.afterHours")}
                        <Select aria-label={`${name}: ${t("notifications.rules.afterHours")}`} value={r.config.afterHours ?? r.defaults.afterHours} disabled={disabled || !r.isActive} onChange={(e) => void save(r, { config: { afterHours: Number(e.target.value) } })} className="w-32">
                          {withValue([2, 4, 8, 12, 24, 48, 72], r.config.afterHours).map((h) => (
                            <option key={h} value={h}>
                              {t("notifications.rules.hours", { count: h })}
                            </option>
                          ))}
                        </Select>
                      </label>
                    )}
                    {r.defaults.dayOfMonth !== undefined && (
                      <label className="flex flex-col gap-1 text-[12px] text-ink-3" title={t("notifications.rules.dayOfMonthHint")}>
                        {t("notifications.rules.dayOfMonth")}
                        <Select aria-label={`${name}: ${t("notifications.rules.dayOfMonth")}`} value={r.config.dayOfMonth ?? r.defaults.dayOfMonth} disabled={disabled || !r.isActive} onChange={(e) => void save(r, { config: { dayOfMonth: Number(e.target.value) } })} className="w-24">
                          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                            <option key={d} value={d}>
                              {d}
                            </option>
                          ))}
                        </Select>
                      </label>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[12px] text-ink-3">
                      {t("notifications.rules.forRole", { permission: permissionLabel(r.permission) })}
                      {" · "}
                      {r.lastRunOn ? t("notifications.rules.lastRun", { date: r.lastRunOn }) : t("notifications.rules.notRun")}
                    </p>
                    {canEdit && r.isActive && (
                      <Button size="sm" variant="ghost" className="ml-auto" disabled={saving === r.type} onClick={() => void check(r)}>
                        {t("notifications.rules.checkNow")}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
      </div>
    </div>
  );
}
