import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/misc";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { Badge } from "../../components/ui/Badge";
import { allowed, BUSINESS } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { serverOrigin } from "../../platform/server";

interface MessagingView {
  driver: "live" | "log";
  platformEmail: boolean;
  whatsapp: {
    provider: "none" | "meta" | "webhook";
    number: string | null;
    phoneNumberId: string | null;
    webhookUrl: string | null;
    hasSecret: boolean;
    /** Delivery ticks: the key in the callback address, and whether Meta's app secret is saved. */
    statusKey: string | null;
    hasAppSecret: boolean;
    documentTemplate: string | null;
    reminderTemplate: string | null;
    templateLanguage: string;
    /** The same templates' language code in Hindi, for customers who get messages in Hindi. */
    templateLanguageHi: string | null;
    ready: boolean;
  };
  sms: {
    provider: "none" | "webhook";
    webhookUrl: string | null;
    hasSecret: boolean;
    senderId: string | null;
    reminderTemplate: string | null;
    reminderTemplateHi: string | null;
    ready: boolean;
  };
  email: {
    mode: "none" | "platform" | "smtp";
    smtpHost: string | null;
    smtpPort: number | null;
    smtpSecure: boolean;
    smtpUser: string | null;
    hasPassword: boolean;
    fromName: string | null;
    fromAddress: string | null;
    replyTo: string | null;
    ready: boolean;
  };
}

type MessagingForm = Record<string, string | boolean>;

function formOf(v: MessagingView): MessagingForm {
  return {
    whatsappProvider: v.whatsapp.provider,
    whatsappNumber: v.whatsapp.number ?? "",
    whatsappPhoneNumberId: v.whatsapp.phoneNumberId ?? "",
    whatsappWebhookUrl: v.whatsapp.webhookUrl ?? "",
    whatsappSecret: "",
    whatsappAppSecret: "",
    whatsappDocumentTemplate: v.whatsapp.documentTemplate ?? "",
    whatsappReminderTemplate: v.whatsapp.reminderTemplate ?? "",
    whatsappTemplateLanguage: v.whatsapp.templateLanguage,
    whatsappTemplateLanguageHi: v.whatsapp.templateLanguageHi ?? "",
    smsProvider: v.sms.provider,
    smsWebhookUrl: v.sms.webhookUrl ?? "",
    smsSecret: "",
    smsSenderId: v.sms.senderId ?? "",
    smsReminderTemplate: v.sms.reminderTemplate ?? "",
    smsReminderTemplateHi: v.sms.reminderTemplateHi ?? "",
    emailMode: v.email.mode,
    smtpHost: v.email.smtpHost ?? "",
    smtpPort: v.email.smtpPort ? String(v.email.smtpPort) : "",
    smtpSecure: v.email.smtpSecure,
    smtpUser: v.email.smtpUser ?? "",
    smtpPassword: "",
    emailFromName: v.email.fromName ?? "",
    emailFromAddress: v.email.fromAddress ?? "",
    emailReplyTo: v.email.replyTo ?? "",
  };
}

/**
 * The business's own WhatsApp Business number (Meta Cloud API or a
 * provider's webhook), its SMS gateway (for payment reminders) and email
 * (the platform's mail server or its own SMTP). Tokens and passwords are
 * write-only: the server keeps them encrypted.
 */
export function MessagingCard() {
  const { t } = useI18n();
  const toast = useToast();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["messaging-settings"], queryFn: () => api.get<MessagingView>("/messaging/settings") });
  const [form, setForm] = useState<MessagingForm | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testChannel, setTestChannel] = useState<"whatsapp" | "sms" | "email">("whatsapp");
  useEffect(() => {
    if (q.data) setForm(formOf(q.data));
  }, [q.data]);
  if (!q.data || !form) return null;
  const v = q.data;
  const set = (k: string, value: string | boolean) => setForm((f) => ({ ...f!, [k]: value }));
  const text = (k: string, label: string, opts: { type?: string; placeholder?: string; hint?: string; mono?: boolean } = {}) => (
    <Field label={label} htmlFor={`msg-${k}`} {...(opts.hint ? { hint: opts.hint } : {})}>
      <Input id={`msg-${k}`} type={opts.type ?? "text"} disabled={!canEdit} placeholder={opts.placeholder} className={opts.mono ? "[&_input]:font-mono" : undefined} value={String(form[k] ?? "")} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  const secret = (k: "whatsappSecret" | "whatsappAppSecret" | "smsSecret" | "smtpPassword", label: string, has: boolean) =>
    text(k, label, { type: "password", ...(has ? { placeholder: "••••••••", hint: t("messages.settings.secretSet") } : {}) });

  const save = async () => {
    setBusy(true);
    setError(null);
    const f = form;
    const orNull = (k: string) => (String(f[k]).trim() === "" ? null : String(f[k]).trim());
    const body: Record<string, unknown> = {
      whatsappProvider: f.whatsappProvider,
      whatsappNumber: orNull("whatsappNumber"),
      whatsappPhoneNumberId: orNull("whatsappPhoneNumberId"),
      whatsappWebhookUrl: orNull("whatsappWebhookUrl"),
      whatsappDocumentTemplate: orNull("whatsappDocumentTemplate"),
      whatsappReminderTemplate: orNull("whatsappReminderTemplate"),
      whatsappTemplateLanguage: String(f.whatsappTemplateLanguage).trim() || "en",
      whatsappTemplateLanguageHi: orNull("whatsappTemplateLanguageHi"),
      smsProvider: f.smsProvider,
      smsWebhookUrl: orNull("smsWebhookUrl"),
      smsSenderId: orNull("smsSenderId")?.toUpperCase() ?? null,
      smsReminderTemplate: orNull("smsReminderTemplate"),
      smsReminderTemplateHi: orNull("smsReminderTemplateHi"),
      emailMode: f.emailMode,
      smtpHost: orNull("smtpHost"),
      smtpPort: String(f.smtpPort).trim() ? Number(f.smtpPort) : null,
      smtpSecure: Boolean(f.smtpSecure),
      smtpUser: orNull("smtpUser"),
      emailFromName: orNull("emailFromName"),
      emailFromAddress: orNull("emailFromAddress"),
      emailReplyTo: orNull("emailReplyTo"),
      // Secrets only when typed: an empty box keeps the saved one.
      ...(String(f.whatsappSecret) ? { whatsappSecret: String(f.whatsappSecret) } : {}),
      ...(String(f.whatsappAppSecret) ? { whatsappAppSecret: String(f.whatsappAppSecret) } : {}),
      ...(String(f.smsSecret) ? { smsSecret: String(f.smsSecret) } : {}),
      ...(String(f.smtpPassword) ? { smtpPassword: String(f.smtpPassword) } : {}),
    };
    try {
      await api.put("/messaging/settings", body);
      await q.refetch();
      toast({ tone: "success", title: t("settings.saved"), body: t("messages.settings.title") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/messaging/test", { channel: testChannel, to: testTo.trim() });
      toast({ tone: "success", title: t("messages.settings.testSent") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("messages.settings.title")} subtitle={t("messages.settings.hint")} />
      <div className="flex flex-col gap-5 p-4 sm:p-5">
        {v.driver === "log" && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("messages.testMode")}</p>}
        {error ? <ErrorNote error={error} /> : null}
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{t("messages.whatsapp")}</h3>
            <Badge tone={v.whatsapp.ready ? "good" : "neutral"} dot>
              {v.whatsapp.ready ? t("messages.settings.ready") : t("messages.settings.off")}
            </Badge>
          </div>
          <Field label={t("messages.settings.provider")} htmlFor="msg-provider">
            <Select id="msg-provider" disabled={!canEdit} value={String(form.whatsappProvider)} onChange={(e) => set("whatsappProvider", e.target.value)}>
              <option value="none">{t("messages.settings.providers.none")}</option>
              <option value="meta">{t("messages.settings.providers.meta")}</option>
              <option value="webhook">{t("messages.settings.providers.webhook")}</option>
            </Select>
          </Field>
          {form.whatsappProvider !== "none" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {text("whatsappNumber", t("messages.settings.number"), { placeholder: "+91 98260 00000" })}
              {form.whatsappProvider === "meta" ? (
                <>
                  {text("whatsappPhoneNumberId", t("messages.settings.phoneNumberId"), { mono: true })}
                  {secret("whatsappSecret", t("messages.settings.accessToken"), v.whatsapp.hasSecret)}
                </>
              ) : (
                <>
                  {text("whatsappWebhookUrl", t("messages.settings.webhookUrl"), { placeholder: "https://", mono: true })}
                  {secret("whatsappSecret", t("messages.settings.webhookSecret"), v.whatsapp.hasSecret)}
                </>
              )}
              {text("whatsappDocumentTemplate", t("messages.settings.documentTemplate"), { mono: true, placeholder: "bill_with_pdf" })}
              {text("whatsappReminderTemplate", t("messages.settings.reminderTemplate"), { mono: true, placeholder: "payment_reminder" })}
              {text("whatsappTemplateLanguage", t("messages.settings.templateLanguage"), { mono: true, placeholder: "en" })}
              {text("whatsappTemplateLanguageHi", t("messages.settings.templateLanguageHi"), { mono: true, placeholder: "hi", hint: t("messages.settings.templateLanguageHiHint") })}
              <p className="text-[12.5px] text-ink-3 sm:col-span-2">{t("messages.settings.templateHelp")}</p>
            </div>
          )}
          {/* Delivered / read ticks: the address Meta (or the provider) reports message statuses to. */}
          {v.whatsapp.provider !== "none" && form.whatsappProvider === v.whatsapp.provider && v.whatsapp.statusKey && (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
              <div>
                <p className="text-[13px] font-semibold text-ink">{t("messages.settings.ticksTitle")}</p>
                <p className="text-[12.5px] text-ink-3">{v.whatsapp.provider === "meta" ? t("messages.settings.ticksMeta") : t("messages.settings.ticksProvider")}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("messages.settings.callbackUrl")} htmlFor="msg-callback">
                  <Input id="msg-callback" readOnly className="[&_input]:font-mono" value={`${serverOrigin() || window.location.origin}/api/v1/webhooks/whatsapp/${v.whatsapp.statusKey}`} onFocus={(e) => e.currentTarget.select()} />
                </Field>
                {v.whatsapp.provider === "meta" && (
                  <>
                    <Field label={t("messages.settings.verifyToken")} htmlFor="msg-verify">
                      <Input id="msg-verify" readOnly className="[&_input]:font-mono" value={v.whatsapp.statusKey} onFocus={(e) => e.currentTarget.select()} />
                    </Field>
                    {secret("whatsappAppSecret", t("messages.settings.appSecret"), v.whatsapp.hasAppSecret)}
                  </>
                )}
              </div>
            </div>
          )}
        </section>
        <section className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{t("messages.settings.smsTitle")}</h3>
            <Badge tone={v.sms.ready ? "good" : "neutral"} dot>
              {v.sms.ready ? t("messages.settings.ready") : t("messages.settings.off")}
            </Badge>
          </div>
          <p className="text-[12.5px] text-ink-3">{t("messages.settings.smsHint")}</p>
          <Field label={t("messages.settings.smsProvider")} htmlFor="msg-sms-provider">
            <Select id="msg-sms-provider" disabled={!canEdit} value={String(form.smsProvider)} onChange={(e) => set("smsProvider", e.target.value)}>
              <option value="none">{t("messages.settings.smsProviders.none")}</option>
              <option value="webhook">{t("messages.settings.smsProviders.webhook")}</option>
            </Select>
          </Field>
          {form.smsProvider === "webhook" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {text("smsWebhookUrl", t("messages.settings.smsUrl"), { placeholder: "https://", mono: true })}
              {secret("smsSecret", t("messages.settings.smsSecret"), v.sms.hasSecret)}
              {text("smsSenderId", t("messages.settings.smsSenderId"), { mono: true, placeholder: "DGBAHI" })}
              <span className="hidden sm:block" aria-hidden />
              {text("smsReminderTemplate", t("messages.settings.smsTemplate"), { mono: true, placeholder: "1207161234567890123" })}
              {text("smsReminderTemplateHi", t("messages.settings.smsTemplateHi"), { mono: true, placeholder: "1207161234567890124" })}
            </div>
          )}
        </section>
        <section className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{t("messages.email")}</h3>
            <Badge tone={v.email.ready ? "good" : "neutral"} dot>
              {v.email.ready ? t("messages.settings.ready") : t("messages.settings.off")}
            </Badge>
          </div>
          <Field label={t("messages.settings.emailMode")} htmlFor="msg-email-mode" {...(form.emailMode === "platform" && !v.platformEmail ? { hint: t("messages.settings.platformMissing") } : {})}>
            <Select id="msg-email-mode" disabled={!canEdit} value={String(form.emailMode)} onChange={(e) => set("emailMode", e.target.value)}>
              <option value="none">{t("messages.settings.emailModes.none")}</option>
              <option value="platform">{t("messages.settings.emailModes.platform")}</option>
              <option value="smtp">{t("messages.settings.emailModes.smtp")}</option>
            </Select>
          </Field>
          {form.emailMode !== "none" && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {form.emailMode === "smtp" && (
                <>
                  {text("smtpHost", t("messages.settings.smtpHost"), { mono: true, placeholder: "smtp.gmail.com" })}
                  {text("smtpPort", t("messages.settings.smtpPort"), { placeholder: "587" })}
                  {text("smtpUser", t("messages.settings.smtpUser"))}
                  {secret("smtpPassword", t("messages.settings.smtpPassword"), v.email.hasPassword)}
                  {text("emailFromAddress", t("messages.settings.fromAddress"), { type: "email" })}
                  <Checkbox label={t("messages.settings.smtpSecure")} checked={Boolean(form.smtpSecure)} disabled={!canEdit} onChange={(value) => set("smtpSecure", value)} className="self-end pb-2" />
                </>
              )}
              {text("emailFromName", t("messages.settings.fromName"), { placeholder: BUSINESS.name })}
              {text("emailReplyTo", t("messages.settings.replyTo"), { type: "email", placeholder: BUSINESS.email || "accounts@…" })}
            </div>
          )}
        </section>
        {canEdit && (
          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-end gap-2">
              <Segmented
                size="sm"
                label={t("messages.channel")}
                value={testChannel}
                onChange={setTestChannel}
                options={[
                  { value: "whatsapp", label: "WhatsApp" },
                  { value: "sms", label: t("messages.sms") },
                  { value: "email", label: t("messages.email") },
                ]}
              />
              <Input aria-label={t("messages.settings.testTo")} placeholder={t("messages.settings.testTo")} className="w-56" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              <Button disabled={busy || testTo.trim().length < 3} onClick={() => void test()}>
                {t("messages.settings.sendTest")}
              </Button>
            </div>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
