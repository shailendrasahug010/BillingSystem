import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LocaleCode } from "@digitalbahi/i18n";
import { Tabs } from "radix-ui";
import { Mail, MessageSquareText, RotateCcw, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { MessageStatus, showRecipient, useChannels, type MessageRow } from "../../components/messaging/SendDialog";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Checkbox, Input, Select } from "../../components/ui/Field";
import { Segmented, Skeleton } from "../../components/ui/misc";
import { ErrorNote, FilterBar, LoadMore, PageHeader, TAB_TRIGGER } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, WORKSPACE } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { usePaged } from "../../lib/usePaged";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";

type Channel = "whatsapp" | "sms" | "email";

interface Candidate {
  id: string;
  name: string;
  mobile: string | null;
  email: string | null;
  balance: string;
  overdue: string;
  oldestDue: string | null;
  /** Asked not to get payment reminders (on their page, or by replying STOP). */
  optedOut: boolean;
}

/**
 * WhatsApp, SMS and email to customers: what was sent (with its status and
 * any error; those the automatic reminders sent marked so), and payment
 * reminders to customers with a balance.
 */
export function MessagesPage() {
  const { t } = useI18n();
  const canView = allowed("message.view");
  const canRemind = allowed("customer.view");
  const tabs = [...(canView ? ["sent"] : []), ...(canRemind ? ["reminders"] : [])];
  const channels = useChannels();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("messages.title")} subtitle={t("messages.subtitle")} />
      {channels.data?.driver === "log" && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("messages.testMode")}</p>}
      <Tabs.Root defaultValue={tabs[0]} className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("messages.title")}>
          {tabs.map((k) => (
            <Tabs.Trigger key={k} value={k} className={TAB_TRIGGER}>
              {t(k === "sent" ? "messages.tabs.sent" : "messages.tabs.reminders")}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {canView && (
          <Tabs.Content value="sent">
            <SentList />
          </Tabs.Content>
        )}
        {canRemind && (
          <Tabs.Content value="reminders">
            <Reminders />
          </Tabs.Content>
        )}
      </Tabs.Root>
    </div>
  );
}

function SentList() {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = usePaged<MessageRow & { partyName: string | null }>("messages", "/messages", { channel, status, kind, q });
  const retry = async (id: string) => {
    try {
      await api.post(`/messages/${id}/retry`);
      toast({ tone: "info", title: t("messages.retrying") });
      setTimeout(list.refetch, 800);
    } catch (e) {
      toast({ tone: "danger", title: t("messages.status.failed"), body: e instanceof ApiError ? e.code : "" });
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Input aria-label={t("common.search")} placeholder={t("messages.searchHint")} value={q} onChange={(e) => setQ(e.target.value)} className="md:w-64" />
        <Select aria-label={t("messages.channel")} value={channel} onChange={(e) => setChannel(e.target.value)} className="md:w-44">
          <option value="">
            {t("messages.channel")}: {t("common.all")}
          </option>
          <option value="whatsapp">{t("messages.whatsapp")}</option>
          <option value="sms">{t("messages.sms")}</option>
          <option value="email">{t("messages.email")}</option>
        </Select>
        <Select aria-label={t("messages.kind")} value={kind} onChange={(e) => setKind(e.target.value)} className="md:w-44">
          <option value="">
            {t("messages.kind")}: {t("common.all")}
          </option>
          {(["invoice", "note", "receipt", "reminder", "summary", "test"] as const).map((k) => (
            <option key={k} value={k}>
              {t(`messages.kinds.${k}`)}
            </option>
          ))}
        </Select>
        <Select aria-label={t("common.status")} value={status} onChange={(e) => setStatus(e.target.value)} className="md:w-40">
          <option value="">
            {t("common.status")}: {t("common.all")}
          </option>
          {(["queued", "sent", "failed"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`messages.status.${s}`)}
            </option>
          ))}
        </Select>
      </FilterBar>
      {list.error ? <ErrorNote error={list.error} /> : null}
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        {list.loading ? (
          <div className="flex flex-col gap-3 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : list.rows.length === 0 ? (
          <p className="p-6 text-center text-[14px] text-ink-3">{t("messages.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.rows.map((m) => {
              const Icon = m.channel === "email" ? Mail : m.channel === "sms" ? MessageSquareText : WhatsAppIcon;
              const expanded = open === m.id;
              return (
                <li key={m.id}>
                  <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : m.id)} className={cn("flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-surface-2", expanded && "bg-surface-2")}>
                    <Icon size={16} className="mt-0.5 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] text-ink">
                        <span className="font-medium">{m.partyName ?? showRecipient(m.recipient)}</span>
                        {" · "}
                        {t(`messages.kinds.${m.kind}`)}
                        {m.documentNumber && <span className="font-mono text-[12.5px]"> {m.documentNumber}</span>}
                        {m.automatic && (
                          <Badge tone="accent" className="ml-2 align-middle">
                            {t("messages.automatic")}
                          </Badge>
                        )}
                      </span>
                      <span className="block truncate text-[12.5px] text-ink-3">
                        {showRecipient(m.recipient)} · {dateTime(m.createdAt)}
                        {m.sentBy && ` · ${m.sentBy}`}
                      </span>
                    </span>
                    <MessageStatus m={m} />
                  </button>
                  {expanded && (
                    <div className="flex flex-col gap-2 bg-surface-2 px-4 pt-1 pb-3 pl-11 text-[13px]">
                      {m.subject && <p className="font-medium text-ink">{m.subject}</p>}
                      <p className="whitespace-pre-line text-ink-2">{m.body}</p>
                      {m.attachmentName && <p className="text-ink-3">📎 {m.attachmentName}</p>}
                      {m.error && <p className="text-danger">{m.error}</p>}
                      {m.status === "failed" && (m.kind === "reminder" || m.kind === "test") && allowed("message.send") && (
                        <div>
                          <Button size="sm" icon={<RotateCcw size={14} />} onClick={() => void retry(m.id)}>
                            {t("messages.retry")}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
    </div>
  );
}

function Reminders() {
  const { t, money, date, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const channels = useChannels();
  const q = useQuery({ queryKey: ["messages", "reminders"], queryFn: () => api.get<{ data: Candidate[] }>("/messages/reminders").then((r) => r.data) });
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [lang, setLang] = useState<LocaleCode>((WORKSPACE.printLocale as LocaleCode) || locale);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [onlyOverdue, setOnlyOverdue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rows = useMemo(() => (q.data ?? []).filter((c) => !onlyOverdue || Number(c.overdue) > 0), [q.data, onlyOverdue]);
  const contact = (c: Candidate) => (channel === "email" ? c.email : c.mobile);
  const sendable = rows.filter((c) => contact(c) && !c.optedOut);
  const chosen = sendable.filter((c) => picked.has(c.id));
  const ready = channels.data?.[channel].ready ?? false;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ queued: number; skipped: Array<{ reason: string }> }>("/messages/reminders", { channel, customerIds: chosen.map((c) => c.id), locale: lang });
      const optedOut = res.skipped.filter((s) => s.reason === "opted_out").length;
      const skipped = [optedOut ? t("messages.skippedOptedOut", { count: optedOut }) : "", res.skipped.length > optedOut ? t("messages.skipped", { count: res.skipped.length - optedOut }) : ""].filter(Boolean).join(" · ");
      toast({ tone: "success", title: t("messages.remindersQueued", { count: res.queued }), ...(skipped ? { body: skipped } : {}) });
      setPicked(new Set());
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["messages"] }), 1000);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13.5px] text-ink-2">{t("messages.remindersHint")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label={t("messages.channel")}
          value={channel}
          onChange={setChannel}
          options={[
            { value: "whatsapp", label: t("messages.whatsapp") },
            { value: "sms", label: t("messages.sms") },
            { value: "email", label: t("messages.email") },
          ]}
        />
        <Segmented
          size="sm"
          label={t("settings.printLanguage")}
          value={lang}
          onChange={setLang}
          options={[
            { value: "en", label: "English" },
            { value: "hi", label: "हिन्दी" },
          ]}
        />
        <Checkbox label={t("messages.onlyOverdue")} checked={onlyOverdue} onChange={setOnlyOverdue} />
        <Button className="ml-auto" variant="primary" icon={<Send size={16} />} disabled={busy || !ready || chosen.length === 0} onClick={() => void send()}>
          {t("messages.sendReminders", { count: chosen.length })}
        </Button>
      </div>
      {channels.data && !ready && <p className="text-[13px] text-ink-3">{t("messages.notReady")}</p>}
      {error ? <ErrorNote error={error} /> : null}
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        {q.isPending ? (
          <div className="flex flex-col gap-3 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-[14px] text-ink-3">{t("messages.noCandidates")}</p>
        ) : (
          <div className="scroll-x">
            <table className="w-full min-w-[620px] text-[13.5px]">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  <th className="w-10 px-3 py-2">
                    <Checkbox label={<span className="sr-only">{t("messages.selectAll")}</span>} checked={chosen.length > 0 && chosen.length === sendable.length} onChange={(v) => setPicked(new Set(v ? sendable.map((c) => c.id) : []))} />
                  </th>
                  <th className="px-3 py-2 font-medium">{t("invoice.customer")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("messages.balance")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("messages.overdue")}</th>
                  <th className="px-3 py-2 font-medium">{t("messages.since")}</th>
                  <th className="px-3 py-2 font-medium">{t("messages.to")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((c) => {
                  const to = contact(c);
                  const can = Boolean(to) && !c.optedOut;
                  return (
                    <tr key={c.id} className={cn(!can && "text-ink-3")}>
                      <td className="px-3 py-2">
                        <Checkbox
                          label={<span className="sr-only">{c.name}</span>}
                          disabled={!can}
                          checked={picked.has(c.id) && can}
                          onChange={(v) =>
                            setPicked((s) => {
                              const next = new Set(s);
                              if (v) next.add(c.id);
                              else next.delete(c.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 font-medium text-ink">
                        {c.name}
                        {c.optedOut && (
                          <Badge tone="neutral" className="ml-2 align-middle">
                            {t("messages.optedOut")}
                          </Badge>
                        )}
                      </td>
                      <td className="num px-3 py-2 text-right">{money(c.balance)}</td>
                      <td className={cn("num px-3 py-2 text-right", Number(c.overdue) > 0 && "text-danger")}>{Number(c.overdue) > 0 ? money(c.overdue) : "—"}</td>
                      <td className="px-3 py-2">{c.oldestDue ? date(c.oldestDue) : "—"}</td>
                      <td className="px-3 py-2 font-mono text-[12.5px]">{to ?? t("messages.noContact")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
