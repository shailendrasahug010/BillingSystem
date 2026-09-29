import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LocaleCode } from "@vyapaar/i18n";
import { Check, CheckCheck, Mail, MessageCircle, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { allowed } from "../../data/db";
import { LIVE } from "../../data/source";
import { api, ApiError } from "../../lib/api";
import { pdfFileName } from "../../lib/share";
import { Badge } from "../ui/Badge";
import { Button, type ButtonSize } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input } from "../ui/Field";
import { Segmented } from "../ui/misc";
import { ErrorNote } from "../ui/Page";
import { useToast } from "../ui/Toast";

type Channel = "whatsapp" | "email";

export interface MessageRow {
  id: string;
  channel: Channel;
  kind: "invoice" | "note" | "receipt" | "reminder" | "test";
  documentId: string | null;
  documentNumber: string | null;
  partyName: string | null;
  recipient: string;
  subject: string | null;
  body: string;
  attachmentName: string | null;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  error: string | null;
  sentAt: string | null;
  /** WhatsApp ticks, when the provider reports them. */
  deliveredAt?: string | null;
  readAt?: string | null;
  createdAt: string;
  sentBy: string | null;
}

interface Channels {
  driver: "live" | "log";
  whatsapp: { ready: boolean; number: string | null };
  email: { ready: boolean };
}

export function useChannels(enabled = true) {
  return useQuery({ queryKey: ["messaging-channels"], queryFn: () => api.get<Channels>("/messaging/channels"), enabled: LIVE && enabled && allowed("message.send"), staleTime: 60_000 });
}

export const STATUS_TONE: Record<MessageRow["status"], "good" | "warn" | "danger" | "neutral"> = { queued: "neutral", sent: "good", delivered: "good", read: "good", failed: "danger" };

/**
 * A message's status the way WhatsApp shows it: one tick sent, two ticks
 * delivered, two blue ticks read (with the times on hover); email says sent.
 */
export function MessageStatus({ m }: { m: Pick<MessageRow, "channel" | "status" | "sentAt" | "deliveredAt" | "readAt"> }) {
  const { t, dateTime } = useI18n();
  const ticks =
    m.channel !== "whatsapp" ? undefined : m.status === "sent" ? (
      <Check size={13} aria-hidden />
    ) : m.status === "delivered" ? (
      <CheckCheck size={13} aria-hidden />
    ) : m.status === "read" ? (
      <CheckCheck size={13} className="text-accent" aria-hidden />
    ) : undefined;
  const title = [m.sentAt && `${t("messages.status.sent")}: ${dateTime(m.sentAt)}`, m.deliveredAt && `${t("messages.status.delivered")}: ${dateTime(m.deliveredAt)}`, m.readAt && `${t("messages.status.read")}: ${dateTime(m.readAt)}`]
    .filter(Boolean)
    .join("\n");
  return (
    <span title={title || undefined}>
      <Badge tone={STATUS_TONE[m.status]} {...(ticks ? { icon: ticks } : { dot: true })}>
        {t(`messages.status.${m.status}`)}
      </Badge>
    </span>
  );
}

/** "919826011111" -> "+91 98260 11111"; email as it is. */
export const showRecipient = (r: string) => (/^91\d{10}$/.test(r) ? `+91 ${r.slice(2, 7)} ${r.slice(7)}` : r);

/**
 * Sends an invoice, note or receipt from the business's own WhatsApp Business
 * number or by email, with the PDF made on the server. Shows what was sent
 * before for the same document.
 */
export function SendDialog({
  open,
  onOpenChange,
  documentType,
  documentId,
  number,
  party,
  locale,
}: {
  open: boolean;
  onOpenChange(v: boolean): void;
  documentType: "invoice" | "note" | "receipt";
  documentId: string;
  number: string;
  party: { name: string; mobile?: string | null; email?: string | null };
  locale: LocaleCode;
}) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const channels = useChannels(open);
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [to, setTo] = useState("");
  const [lang, setLang] = useState<LocaleCode>(locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const history = useQuery({
    queryKey: ["messages", "document", documentId],
    queryFn: () => api.get<{ data: MessageRow[] }>("/messages", { documentId, limit: 20 }).then((r) => r.data),
    enabled: open && allowed("message.view"),
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLang(locale);
  }, [open, locale]);
  useEffect(() => {
    if (!channels.data) return;
    setChannel((c) => (channels.data[c].ready ? c : channels.data.whatsapp.ready ? "whatsapp" : "email"));
  }, [channels.data]);
  useEffect(() => {
    setTo((channel === "email" ? party.email : party.mobile) ?? "");
  }, [channel, party.email, party.mobile]);

  const ready = channels.data?.[channel].ready ?? false;
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const sent = await api.post<MessageRow>("/messages/send", { channel, documentType, documentId, locale: lang, ...(to.trim() ? { to: to.trim() } : {}) });
      toast({ tone: "success", title: t("messages.sentTo", { to: showRecipient(sent.recipient) }), body: sent.attachmentName ?? number });
      void qc.invalidateQueries({ queryKey: ["messages"] });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      void qc.invalidateQueries({ queryKey: ["messages"] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("messages.sendTitle", { number })}
      description={party.name}
      size="md"
      closeLabel={t("common.close")}
      footer={
        <Button variant="primary" icon={<Send size={16} />} disabled={busy || !ready} onClick={() => void send()}>
          {t("messages.sendNow")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {channels.data?.driver === "log" && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{t("messages.testMode")}</p>}
        <Segmented
          label={t("messages.channel")}
          value={channel}
          onChange={(v) => setChannel(v)}
          options={[
            { value: "whatsapp", label: t("messages.whatsapp") },
            { value: "email", label: t("messages.email") },
          ]}
        />
        {channels.data && !ready && <p className="text-[13px] text-ink-3">{t("messages.notReady")}</p>}
        <Field label={t("messages.to")} htmlFor="send-to" hint={channel === "email" ? t("messages.toHintEmail") : t("messages.toHintWhatsapp")}>
          <Input
            id="send-to"
            value={to}
            inputMode={channel === "email" ? "email" : "tel"}
            placeholder={t("messages.toOnFile")}
            onChange={(e) => setTo(e.target.value)}
            leading={channel === "email" ? <Mail size={15} /> : <MessageCircle size={15} />}
          />
        </Field>
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
        <p className="text-[12.5px] text-ink-3">{t("messages.attachment", { name: pdfFileName(number) })}</p>
        {error ? <ErrorNote error={error} /> : null}
        {allowed("message.view") && (
          <section className="flex flex-col gap-1.5 border-t border-line pt-3">
            <h3 className="text-[13px] font-semibold text-ink-2">{t("messages.history")}</h3>
            {history.data && history.data.length === 0 && <p className="text-[12.5px] text-ink-3">{t("messages.noHistory")}</p>}
            <ul className="flex flex-col gap-1">
              {history.data?.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                  <MessageStatus m={m} />
                  <span>{m.channel === "email" ? t("messages.email") : t("messages.whatsapp")}</span>
                  <span className="font-mono">{showRecipient(m.recipient)}</span>
                  <span className="ml-auto text-ink-3">{dateTime(m.createdAt)}</span>
                  {m.error && <span className="w-full text-danger">{m.error}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}

/** The "Send" button next to Print and PDF: WhatsApp Business or email from the server. */
export function SendButton(props: Omit<Parameters<typeof SendDialog>[0], "open" | "onOpenChange"> & { size?: ButtonSize }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!LIVE || !allowed("message.send")) return null;
  const { size, ...rest } = props;
  return (
    <>
      <Button size={size ?? "md"} icon={<Send size={size === "sm" ? 14 : 16} />} onClick={() => setOpen(true)}>
        {t("messages.send")}
      </Button>
      <SendDialog open={open} onOpenChange={setOpen} {...rest} />
    </>
  );
}
