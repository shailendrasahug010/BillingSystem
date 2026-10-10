import { useQuery } from "@tanstack/react-query";
import type { PaymentGatewayView } from "@digitalbahi/contracts";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { serverOrigin } from "../../platform/server";

interface Account {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
}

interface Form {
  provider: PaymentGatewayView["provider"];
  environment: "test" | "live";
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  paymentAccountId: string;
  upiOnly: boolean;
  linkExpiryDays: string;
  linksInReminders: boolean;
}

const formOf = (v: PaymentGatewayView): Form => ({
  provider: v.provider,
  environment: v.environment,
  keyId: v.keyId ?? "",
  keySecret: "",
  webhookSecret: "",
  paymentAccountId: v.paymentAccountId ?? "",
  upiOnly: v.upiOnly,
  linkExpiryDays: String(v.linkExpiryDays),
  linksInReminders: v.linksInReminders,
});

/**
 * Online payments: the business's own Razorpay or Cashfree account, whose
 * payment links customers pay by UPI, card or net banking (each payment is
 * recorded as a receipt by itself), or none (bills show the UPI QR code).
 * Secrets are write-only: the server keeps them encrypted.
 */
export function PaymentGatewayCard() {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["payment-gateway"], queryFn: () => api.get<PaymentGatewayView>("/payment-gateway") });
  // The bank account the gateway pays into (shown only to those who may see accounts).
  const accounts = useQuery({ queryKey: ["payment-accounts"], queryFn: () => api.get<{ data: Account[] }>("/payment-accounts"), enabled: allowed("payment.view") });
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setForm(formOf(q.data));
  }, [q.data]);
  if (!q.data || !form) return null;
  const v = q.data;
  const set = <K extends keyof Form>(k: K, value: Form[K]) => setForm((f) => ({ ...f!, [k]: value }));
  const razorpay = form.provider === "razorpay";
  const days = Number(form.linkExpiryDays);
  const daysOk = Number.isInteger(days) && days >= 1 && days <= 180;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put("/payment-gateway", {
        provider: form.provider,
        environment: form.environment,
        keyId: form.keyId.trim() || null,
        // Secrets only when typed: an empty box keeps the saved one.
        ...(form.keySecret.trim() ? { keySecret: form.keySecret.trim() } : {}),
        ...(form.webhookSecret.trim() ? { webhookSecret: form.webhookSecret.trim() } : {}),
        ...(accounts.data ? { paymentAccountId: form.paymentAccountId || null } : {}),
        upiOnly: form.upiOnly,
        linkExpiryDays: days,
        linksInReminders: form.linksInReminders,
      });
      await q.refetch();
      toast({ tone: "success", title: t("gateway.saved") });
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
      const r = await api.post<{ provider: "razorpay" | "cashfree" }>("/payment-gateway/test");
      toast({ tone: "success", title: t("gateway.testOk", { provider: t(`gateway.providers.${r.provider}`) }) });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const secretHint = (has: boolean) => (has ? { placeholder: "••••••••" } : {});
  const webhookUrl = v.webhookKey ? `${serverOrigin() || window.location.origin}/api/v1/webhooks/payments/${v.webhookKey}` : null;
  const usable = (accounts.data?.data ?? []).filter((a) => a.isActive || a.id === form.paymentAccountId);

  return (
    <Card>
      <CardHeader title={t("gateway.title")} subtitle={t("gateway.hint")} />
      <div className="flex flex-col gap-4 p-4 sm:p-5" data-gateway-card>
        {v.driver === "fake" && <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t("gateway.testMode")}</p>}
        {error ? <ErrorNote error={error} /> : null}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Field label={t("gateway.provider")} htmlFor="gw-provider">
              <Select id="gw-provider" disabled={!canEdit} value={form.provider} onChange={(e) => set("provider", e.target.value as Form["provider"])}>
                <option value="none">{t("gateway.providers.none")}</option>
                <option value="razorpay">{t("gateway.providers.razorpay")}</option>
                <option value="cashfree">{t("gateway.providers.cashfree")}</option>
              </Select>
            </Field>
          </div>
          <Badge tone={v.ready ? "good" : "neutral"} dot>
            {v.ready ? t("messages.settings.ready") : t("messages.settings.off")}
          </Badge>
        </div>
        {form.provider === "none" ? (
          <p className="text-[12.5px] text-ink-3">{t("gateway.noneHint")}</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("gateway.environment")} htmlFor="gw-env">
                <Select id="gw-env" disabled={!canEdit} value={form.environment} onChange={(e) => set("environment", e.target.value as Form["environment"])}>
                  <option value="test">{t("gateway.environments.test")}</option>
                  <option value="live">{t("gateway.environments.live")}</option>
                </Select>
              </Field>
              <Field label={razorpay ? t("gateway.keyId") : t("gateway.appId")} htmlFor="gw-key-id">
                <Input id="gw-key-id" disabled={!canEdit} autoComplete="off" spellCheck={false} className="[&_input]:font-mono" placeholder={razorpay ? "rzp_test_…" : ""} value={form.keyId} onChange={(e) => set("keyId", e.target.value)} />
              </Field>
              <Field label={razorpay ? t("gateway.keySecret") : t("gateway.secretKey")} htmlFor="gw-key-secret" {...(v.hasKeySecret ? { hint: t("gateway.secretSet") } : {})}>
                <Input id="gw-key-secret" type="password" autoComplete="new-password" disabled={!canEdit} {...secretHint(v.hasKeySecret)} value={form.keySecret} onChange={(e) => set("keySecret", e.target.value)} />
              </Field>
              {razorpay && (
                <Field label={t("gateway.webhookSecret")} htmlFor="gw-webhook-secret" {...(v.hasWebhookSecret ? { hint: t("gateway.secretSet") } : {})}>
                  <Input id="gw-webhook-secret" type="password" autoComplete="new-password" disabled={!canEdit} {...secretHint(v.hasWebhookSecret)} value={form.webhookSecret} onChange={(e) => set("webhookSecret", e.target.value)} />
                </Field>
              )}
              {accounts.data && (
                <Field label={t("gateway.account")} htmlFor="gw-account" hint={t("gateway.accountHint")}>
                  <Select id="gw-account" disabled={!canEdit} value={form.paymentAccountId} onChange={(e) => set("paymentAccountId", e.target.value)}>
                    <option value="">{t("gateway.accountNone")}</option>
                    {usable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label={t("gateway.expiryDays")} htmlFor="gw-days">
                <Input id="gw-days" inputMode="numeric" disabled={!canEdit} value={form.linkExpiryDays} onChange={(e) => set("linkExpiryDays", e.target.value.replace(/\D/g, "").slice(0, 3))} />
              </Field>
            </div>
            <Checkbox label={t("gateway.upiOnly")} checked={form.upiOnly} disabled={!canEdit} onChange={(value) => set("upiOnly", value)} />
            <div>
              <Checkbox label={t("gateway.inReminders")} checked={form.linksInReminders} disabled={!canEdit} onChange={(value) => set("linksInReminders", value)} />
              <p className="mt-1 pl-7 text-[12.5px] text-ink-3">{t("gateway.inRemindersHint")}</p>
            </div>
            {/* Where the gateway reports payments: shown once the gateway is saved. */}
            {webhookUrl && v.provider === form.provider && (
              <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
                <div>
                  <p className="text-[13px] font-semibold text-ink">{t("gateway.webhookTitle")}</p>
                  <p className="text-[12.5px] text-ink-3">{razorpay ? t("gateway.webhookRazorpay") : t("gateway.webhookCashfree")}</p>
                </div>
                <Field label={t("gateway.webhookUrl")} htmlFor="gw-webhook-url">
                  <Input id="gw-webhook-url" readOnly className="[&_input]:font-mono" value={webhookUrl} onFocus={(e) => e.currentTarget.select()} data-gateway-webhook />
                </Field>
                <p className="text-[12.5px] text-ink-3">{v.lastWebhookAt ? t("gateway.lastWebhook", { date: dateTime(v.lastWebhookAt) }) : t("gateway.noWebhook")}</p>
              </div>
            )}
          </>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            {v.ready && v.provider === form.provider && (
              <Button disabled={busy} onClick={() => void test()}>
                {t("gateway.test")}
              </Button>
            )}
            <Button variant="primary" disabled={busy || (form.provider !== "none" && !daysOk)} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
