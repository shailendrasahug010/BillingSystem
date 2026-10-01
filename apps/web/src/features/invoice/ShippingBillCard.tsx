import { translateError } from "@digitalbahi/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ship, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import type { ApiInvoice } from "./printable";

/**
 * An export's shipping bill (number, date, port). It is usually issued after
 * the invoice, so it is added here later; GSTR-1 table 6A reports it.
 */
export function ShippingBillCard({ invoice, cancelled }: { invoice: ApiInvoice; cancelled: boolean }) {
  const i18n = useI18n();
  const { t, date } = i18n;
  const [open, setOpen] = useState(false);
  const has = Boolean(invoice.shippingBillNumber);
  const canEdit = allowed("invoice.update") && !cancelled;
  const bill = [invoice.shippingBillNumber, invoice.shippingBillDate ? date(invoice.shippingBillDate) : null, invoice.portCode].filter(Boolean).join(" · ");
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 shadow-card" aria-label={t("invoice.export.shippingBill")}>
      <div className="flex items-center gap-3">
        <span className={has ? "grid size-9 place-items-center rounded-full bg-accent-soft text-accent-ink" : "grid size-9 place-items-center rounded-full bg-warn-soft text-warn"}>
          {has ? <Ship size={17} /> : <TriangleAlert size={17} />}
        </span>
        <div>
          <p className="text-[13px] font-medium text-ink">{t("invoice.export.shippingBill")}</p>
          <p className={has ? "num text-[13px] text-ink-2" : "text-[13px] text-warn"}>{has ? bill : t("invoice.export.shippingBillMissing")}</p>
        </div>
      </div>
      {canEdit && (
        <Button size="sm" onClick={() => setOpen(true)}>
          {has ? t("invoice.export.editShippingBill") : t("invoice.export.addShippingBill")}
        </Button>
      )}
      {open && <ShippingBillDialog invoice={invoice} onClose={() => setOpen(false)} i18n={i18n} />}
    </section>
  );
}

function ShippingBillDialog({ invoice, onClose, i18n }: { invoice: ApiInvoice; onClose(): void; i18n: ReturnType<typeof useI18n> }) {
  const { t } = i18n;
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ number: invoice.shippingBillNumber ?? "", date: invoice.shippingBillDate ?? "", port: invoice.portCode ?? "" });
  const save = useMutation({
    mutationFn: () =>
      api.patch<ApiInvoice>(`/invoices/${invoice.id}/shipping-bill`, {
        shippingBillNumber: form.number.trim() || null,
        shippingBillDate: form.date || null,
        portCode: form.port.trim() || null,
      }),
    onSuccess: (saved) => {
      qc.setQueryData<ApiInvoice>(["invoice-raw", invoice.id], (old) => (old ? { ...old, ...saved } : saved));
      toast({ tone: "success", title: t("invoice.export.shippingBillSaved"), body: invoice.invoiceNumber });
      onClose();
    },
  });
  const error = save.error instanceof ApiError ? save.error : save.error ? new ApiError(0, "generic") : null;
  const fieldError = (k: string) => (error && error.field === k ? translateError(i18n, error) : null);
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={invoice.shippingBillNumber ? t("invoice.export.editShippingBill") : t("invoice.export.addShippingBill")}
      description={invoice.invoiceNumber}
      size="sm"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {error && !error.field && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {translateError(i18n, error)}
          </p>
        )}
        <Field label={t("invoice.export.shippingBillNumber")} htmlFor="sbd-number" error={fieldError("shippingBillNumber")}>
          <Input id="sbd-number" inputMode="numeric" maxLength={20} value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value.replace(/\D/g, "") }))} />
        </Field>
        <Field label={t("invoice.export.shippingBillDate")} htmlFor="sbd-date" error={fieldError("shippingBillDate")}>
          <Input id="sbd-date" type="date" min={invoice.invoiceDate} value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label={t("invoice.export.portCode")} htmlFor="sbd-port" error={fieldError("portCode")}>
          <Input id="sbd-port" maxLength={6} className="[&_input]:font-mono [&_input]:uppercase" placeholder="INNSA1" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} />
        </Field>
      </form>
    </Dialog>
  );
}
