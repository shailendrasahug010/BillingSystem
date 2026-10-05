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
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Input, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { ErrorNote, LoadMore, PageHeader, TAB_TRIGGER } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { usePaged } from "../../lib/usePaged";
import { NotificationItem } from "./NotificationItem";
import { dismiss, markAllRead, markRead, NOTIFICATIONS, targetRoute, useRefreshNotifications, useUnreadCount, type DueCustomer, type NotificationRow, type ReminderChannel, type ReminderConfig, type ReminderRule } from "./notifications";

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
      {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
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

type NumberSetting = "daysBefore" | "afterHours" | "dayOfMonth" | "firstAfterDays" | "repeatDays" | "maxCount" | "minAmount";
type RulePatch = { isActive?: boolean; config?: Partial<ReminderConfig> };

function Rules() {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const client = useQueryClient();
  const canEdit = allowed("notification.configure");
  const rules = useQuery({ queryKey: RULES_KEY, queryFn: ({ signal }) => api.get<{ data: ReminderRule[] }>("/reminder-rules", undefined, signal) });
  const [saving, setSaving] = useState<string | null>(null);
  const refresh = useRefreshNotifications();

  const save = async (rule: ReminderRule, patch: RulePatch) => {
    setSaving(rule.type);
    // The change shows at once (a switch that went back until the server answered looked as if it had not worked).
    const before = client.getQueryData<{ data: ReminderRule[] }>(RULES_KEY);
    client.setQueryData<{ data: ReminderRule[] }>(
      RULES_KEY,
      (d) => d && { data: d.data.map((r) => (r.type === rule.type ? { ...r, ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}), config: { ...r.config, ...patch.config } } : r)) },
    );
    try {
      const updated = await api.patch<ReminderRule>(`/reminder-rules/${rule.type}`, patch);
      client.setQueryData<{ data: ReminderRule[] }>(RULES_KEY, (d) => d && { data: d.data.map((r) => (r.type === updated.type ? updated : r)) });
      // Who is due a payment reminder depends on the settings.
      if (rule.type === "customer_reminders") void client.invalidateQueries({ queryKey: DUE_KEY });
      toast({ tone: "success", title: t("notifications.rules.saved") });
    } catch (e) {
      client.setQueryData(RULES_KEY, before);
      toast({ tone: "danger", title: t(`notifications.rules.types.${rule.type}.name` as TranslationKey), body: e instanceof ApiError ? translateError(i18n, e) : "" });
    } finally {
      setSaving(null);
    }
  };

  const check = async (rule: ReminderRule) => {
    setSaving(rule.type);
    try {
      const { result, sent } = await api.post<{ result: "raised" | "already" | "nothing"; sent?: { count: number; amount: string; unreachable: number } }>(`/reminder-rules/${rule.type}/check`);
      if (sent) {
        // How many went now, and those due who cannot be reached.
        const unreachable = sent.unreachable ? t("notifications.customer_reminders.unreachable", { unreachable: sent.unreachable }) : null;
        if (sent.count) toast({ tone: "success", title: t("notifications.customer_reminders.title", { count: sent.count, amount: sent.amount }), body: [t("notifications.rules.sentNow"), unreachable].filter(Boolean).join(" ") });
        else if (unreachable) toast({ tone: "danger", title: t("notifications.customer_reminders.noneSent"), body: unreachable });
        else toast({ tone: "info", title: t("notifications.rules.dueTodayEmpty") });
        void client.invalidateQueries({ queryKey: DUE_KEY });
        void client.invalidateQueries({ queryKey: ["messages"] });
      } else {
        toast({ tone: result === "nothing" ? "info" : "success", title: t(result === "raised" ? "notifications.rules.checkedRaised" : result === "already" ? "notifications.rules.checkedAlready" : "notifications.rules.checkedNothing") });
      }
      void client.invalidateQueries({ queryKey: RULES_KEY });
      refresh();
    } catch (e) {
      toast({ tone: "danger", title: t(`notifications.rules.types.${rule.type}.name` as TranslationKey), body: e instanceof ApiError ? translateError(i18n, e) : "" });
    } finally {
      setSaving(null);
    }
  };

  if (rules.error) return <ErrorNote error={rules.error} onRetry={() => void rules.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-[13.5px] text-ink-2">{t("notifications.rules.intro")}</p>
      {!canEdit && <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-3">{t("notifications.rules.readOnly")}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        {rules.isPending
          ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 w-full rounded-[var(--radius-card)]" />)
          : rules.data.data.map((r) => <RuleCard key={r.type} rule={r} canEdit={canEdit} busy={saving === r.type} onSave={(patch) => void save(r, patch)} onCheck={() => void check(r)} />)}
      </div>
    </div>
  );
}

/** The daily summary's numbers, typed with commas; saved when the field is left. */
function Recipients({ rule, name, disabled, onSave }: { rule: ReminderRule; name: string; disabled: boolean; onSave(recipients: string[]): void }) {
  const { t } = useI18n();
  const saved = (rule.config.recipients ?? []).join(", ");
  const [text, setText] = useState(saved);
  const [shown, setShown] = useState(saved);
  // A save from elsewhere (another tab, the server's cleaning) shows here.
  if (shown !== saved) {
    setShown(saved);
    setText(saved);
  }
  return (
    <label className="flex flex-col gap-1 text-[12px] text-ink-3">
      {t("notifications.rules.recipients")}
      <Input
        aria-label={`${name}: ${t("notifications.rules.recipients")}`}
        value={text}
        inputMode="tel"
        disabled={disabled}
        placeholder={t("notifications.rules.recipientsPlaceholder")}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const list = text
            .split(/[,;\n]+/)
            .map((m) => m.trim())
            .filter(Boolean);
          if (list.join(", ") !== saved) onSave(list);
        }}
        className="max-w-md"
      />
      <span>{t("notifications.rules.recipientsHint")}</span>
    </label>
  );
}

/** One rule: on or off, its hour and settings, when it last looked, and "Check now" (or, for payment reminders to customers, who is due one today and "Send now"). */
function RuleCard({ rule: r, canEdit, busy, onSave, onCheck }: { rule: ReminderRule; canEdit: boolean; busy: boolean; onSave(patch: RulePatch): void; onCheck(): void }) {
  const { t, locale, money, dateTime } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const disabled = !canEdit || busy;
  const name = t(`notifications.rules.types.${r.type}.name` as TranslationKey);
  const customers = r.type === "customer_reminders";
  // Rules that write messages (to customers, or the summary to the owner) send rather than check.
  const sends = customers || r.type === "daily_summary";
  const hourLabel = (h: number) => new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, h)));
  const permissionLabel = (p: string) => {
    const [module, action] = p.split(".");
    return `${t(`perm.modules.${module}` as TranslationKey)}: ${t(`perm.actions.${action}` as TranslationKey)}`;
  };
  /** A setting the rule has, as a list of choices. */
  const setting = (key: NumberSetting, label: string, choices: number[], show: (v: number) => string, width: string, hint?: string) =>
    r.defaults[key] !== undefined && (
      <label className="flex flex-col gap-1 text-[12px] text-ink-3" title={hint}>
        {label}
        <Select aria-label={`${name}: ${label}`} value={r.config[key] ?? r.defaults[key]} disabled={disabled || !r.isActive} onChange={(e) => onSave({ config: { [key]: Number(e.target.value) } })} className={width}>
          {withValue(choices, r.config[key]).map((v) => (
            <option key={v} value={v}>
              {show(v)}
            </option>
          ))}
        </Select>
      </label>
    );
  const days = (d: number) => (d === 0 ? t("notifications.rules.dayZero") : t("common.days", { count: d }));
  const hourText = sends ? t("notifications.rules.sendAfter") : t("notifications.rules.hour");
  return (
    <Card className="flex flex-col gap-3 p-4" data-rule={r.type}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink">
            {name}
            {r.events && <Badge tone="accent">{t("notifications.rules.asItHappens")}</Badge>}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-2">{t(`notifications.rules.types.${r.type}.help` as TranslationKey)}</p>
        </div>
        <Checkbox label={t("notifications.rules.on")} checked={r.isActive} disabled={disabled} onChange={(v) => onSave({ isActive: v })} className="shrink-0 text-[13px]" />
      </div>
      {customers && !r.isActive && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{t("notifications.rules.offNote")}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-ink-3">
          {hourText}
          <Select aria-label={`${name}: ${hourText}`} value={r.config.hour} disabled={disabled || !r.isActive} onChange={(e) => onSave({ config: { hour: Number(e.target.value) } })} className="w-32">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </Select>
        </label>
        {r.hourly && <span className="pb-2 text-[12px] text-ink-3">{t("notifications.rules.hourly")}</span>}
        {setting("daysBefore", t("notifications.rules.daysBefore"), [0, 1, 2, 3, 5, 7, 10, 15, 30], (d) => t("common.days", { count: d }), "w-28", t("notifications.rules.daysBeforeHint"))}
        {setting("afterHours", t("notifications.rules.afterHours"), [2, 4, 8, 12, 24, 48, 72], (h) => t("notifications.rules.hours", { count: h }), "w-32", t(r.type === "orders_waiting" ? "notifications.rules.afterHoursOrdersHint" : "notifications.rules.afterHoursHint"))}
        {setting("dayOfMonth", t("notifications.rules.dayOfMonth"), Array.from({ length: 28 }, (_, i) => i + 1), String, "w-24", t("notifications.rules.dayOfMonthHint"))}
        {setting("firstAfterDays", t("notifications.rules.firstAfterDays"), [1, 2, 3, 5, 7, 10, 15, 30], days, "w-32", t("notifications.rules.firstAfterDaysHint"))}
        {setting("repeatDays", t("notifications.rules.repeatDays"), [1, 2, 3, 5, 7, 10, 15, 30], days, "w-28")}
        {setting("maxCount", t("notifications.rules.maxCount"), [1, 2, 3, 4, 5, 6, 8, 10], (n) => t("notifications.rules.times", { count: n }), "w-36", t("notifications.rules.maxCountHint"))}
        {setting("minAmount", t("notifications.rules.minAmount"), [0, 100, 500, 1000, 2000, 5000, 10000], (a) => money(a, 0), "w-32")}
        {r.defaults.channel !== undefined && (
          <label className="flex flex-col gap-1 text-[12px] text-ink-3">
            {t("notifications.rules.channel")}
            <Select aria-label={`${name}: ${t("notifications.rules.channel")}`} value={r.config.channel ?? r.defaults.channel} disabled={disabled || !r.isActive} onChange={(e) => onSave({ config: { channel: e.target.value as ReminderChannel } })} className="w-44">
              {(["whatsapp_or_sms", "whatsapp", "sms", "email"] as const).map((c) => (
                <option key={c} value={c}>
                  {t(`notifications.rules.channels.${c}`)}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>
      {r.defaults.recipients !== undefined && <Recipients rule={r} name={name} disabled={disabled || !r.isActive} onSave={(recipients) => onSave({ config: { recipients } })} />}
      {customers && r.isActive && canEdit && <DueToday />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-ink-3">
          {t("notifications.rules.forRole", { permission: permissionLabel(r.permission) })}
          {" · "}
          {r.hourly && r.lastRunAt ? t("notifications.rules.lastRunAt", { time: dateTime(r.lastRunAt) }) : r.lastRunOn ? t("notifications.rules.lastRun", { date: r.lastRunOn }) : t("notifications.rules.notRun")}
        </p>
        {canEdit && r.isActive && (
          <Button size="sm" variant={sends ? "secondary" : "ghost"} className="ml-auto" disabled={busy} onClick={() => (customers ? setConfirming(true) : onCheck())}>
            {sends ? t("notifications.rules.sendNow") : t("notifications.rules.checkNow")}
          </Button>
        )}
      </div>
      {customers && (
        <Dialog
          open={confirming}
          onOpenChange={setConfirming}
          size="sm"
          title={t("notifications.rules.sendNow")}
          description={t("notifications.rules.sendConfirm")}
          closeLabel={t("common.close")}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onCheck();
                }}
              >
                {t("notifications.rules.sendNow")}
              </Button>
            </>
          }
        />
      )}
    </Card>
  );
}

const DUE_KEY = [...RULES_KEY, "customer_reminders", "due"];

/** The customers the payment reminders write to today, and those due one who cannot be reached. */
function DueToday() {
  const { t } = useI18n();
  const due = useQuery({ queryKey: DUE_KEY, queryFn: ({ signal }) => api.get<{ data: DueCustomer[] }>("/reminder-rules/customer_reminders/due", undefined, signal) });
  if (due.error) return <ErrorNote error={due.error} onRetry={() => void due.refetch()} />;
  const rows = due.data?.data ?? [];
  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 p-3" aria-label={t("notifications.rules.dueToday")}>
      <p className="text-[12.5px] font-semibold text-ink">
        {t("notifications.rules.dueToday")}
        {due.data && rows.length > 0 && <span className="num font-normal text-ink-3"> · {rows.length}</span>}
      </p>
      {due.isPending ? (
        <Skeleton className="h-5 w-2/3" />
      ) : rows.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">{t("notifications.rules.dueTodayEmpty")}</p>
      ) : (
        <ul className="flex max-h-56 flex-col divide-y divide-line overflow-y-auto">
          {rows.map((d) => (
            <li key={d.customerId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5 text-[12.5px]" data-due={d.customerId}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{d.name}</span>
                <span className="block text-ink-3">{t("notifications.rules.dueLine", { overdue: d.overdue, days: d.daysOverdue, sent: d.sentSinceDue })}</span>
              </span>
              {d.channel ? <Badge tone="neutral">{t(`notifications.rules.channels.${d.channel}`)}</Badge> : <Badge tone="warn">{t("notifications.rules.noChannel")}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
