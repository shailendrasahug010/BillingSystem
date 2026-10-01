import { translateError } from "@digitalbahi/i18n";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { api, ApiError } from "../../lib/api";
import { downloadBlob } from "../../lib/download";

/** A stored moment as "YYYY-MM-DDTHH:MM" in India time, for a datetime-local field. */
export function toIstLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Downloads a portal file (e-invoice or e-way bill JSON) from the API. */
export async function downloadPortalFile(path: string, query: Record<string, string>, name: string) {
  downloadBlob(name, await api.blob(path, query));
}

export const fileName = (prefix: string, number: string) => `${prefix}_${number.replace(/[^A-Za-z0-9-]/g, "-")}.json`;

export interface IrnTarget {
  kind: "invoice" | "credit_note";
  id: string;
  number: string;
  irn?: string | null;
  ackNumber?: string | null;
  ackDate?: string | null;
  signedQrCode?: string | null;
}

/** The IRN, acknowledgement and signed QR code the e-invoice portal returned for a bill (or removing them). */
export function IrnDialog({ target, onClose, onSaved }: { target: IrnTarget | null; onClose(): void; onSaved(): void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const [form, setForm] = useState({ irn: "", ackNumber: "", ackDate: "", signedQrCode: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!target) return;
    setError(null);
    setForm({ irn: target.irn ?? "", ackNumber: target.ackNumber ?? "", ackDate: toIstLocal(target.ackDate), signedQrCode: target.signedQrCode ?? "" });
  }, [target]);
  const path = target ? `/${target.kind === "invoice" ? "invoices" : "notes"}/${target.id}/irn` : "";
  const send = async (body: unknown, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(path, body);
      toast({ tone: "success", title: done, body: target!.number });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const valid = /^[0-9a-fA-F]{64}$/.test(form.irn.trim()) && /^\d{10,20}$/.test(form.ackNumber.trim()) && Boolean(form.ackDate);
  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(v) => !v && onClose()}
      title={target?.irn ? t("einvoice.changeIrn") : t("einvoice.enterIrn")}
      description={target?.number}
      closeLabel={t("common.close")}
      footer={
        <>
          {target?.irn && (
            <Button variant="ghost" disabled={busy} onClick={() => void send({ irn: null }, t("einvoice.irnRemoved"))}>
              {t("common.remove")}
            </Button>
          )}
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            disabled={busy || !valid}
            onClick={() => void send({ irn: form.irn.trim(), ackNumber: form.ackNumber.trim(), ackDate: form.ackDate, signedQrCode: form.signedQrCode.trim() || null }, t("einvoice.irnSaved"))}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {translateError(i18n, error)}
          </p>
        )}
        <p className="text-[12.5px] text-ink-3">{t("einvoice.irnHint")}</p>
        <Field label="IRN" htmlFor="irn-irn" hint={t("einvoice.irnFormat")}>
          <Input id="irn-irn" maxLength={64} className="[&_input]:font-mono [&_input]:text-[12px]" value={form.irn} onChange={(e) => setForm((f) => ({ ...f, irn: e.target.value.replace(/\s/g, "") }))} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("einvoice.ackNumber")} htmlFor="irn-ack">
            <Input id="irn-ack" inputMode="numeric" maxLength={20} value={form.ackNumber} onChange={(e) => setForm((f) => ({ ...f, ackNumber: e.target.value.replace(/\D/g, "") }))} />
          </Field>
          <Field label={t("einvoice.ackDate")} htmlFor="irn-date">
            <Input id="irn-date" type="datetime-local" value={form.ackDate} onChange={(e) => setForm((f) => ({ ...f, ackDate: e.target.value }))} />
          </Field>
        </div>
        <Field label={t("einvoice.signedQr")} htmlFor="irn-qr" hint={t("einvoice.signedQrHint")}>
          <textarea
            id="irn-qr"
            rows={3}
            maxLength={4000}
            value={form.signedQrCode}
            onChange={(e) => setForm((f) => ({ ...f, signedQrCode: e.target.value }))}
            className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 font-mono text-[11.5px] text-ink focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none"
          />
        </Field>
      </div>
    </Dialog>
  );
}

export interface EwayTarget {
  id: string;
  number: string;
  ewayBillNumber?: string | null;
  ewayBillDate?: string | null;
  validUntil?: string | null;
}

/** The e-way bill number, date and validity from the e-way bill portal (or removing them). */
export function EwayBillDialog({ target, onClose, onSaved }: { target: EwayTarget | null; onClose(): void; onSaved(): void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const [form, setForm] = useState({ number: "", date: "", validUntil: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!target) return;
    setError(null);
    setForm({ number: target.ewayBillNumber ?? "", date: toIstLocal(target.ewayBillDate), validUntil: toIstLocal(target.validUntil) });
  }, [target]);
  const send = async (body: unknown, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/invoices/${target!.id}/eway-bill`, body);
      toast({ tone: "success", title: done, body: target!.number });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(v) => !v && onClose()}
      title={target?.ewayBillNumber ? t("einvoice.changeEwayBill") : t("einvoice.enterEwayBill")}
      description={target?.number}
      size="sm"
      closeLabel={t("common.close")}
      footer={
        <>
          {target?.ewayBillNumber && (
            <Button variant="ghost" disabled={busy} onClick={() => void send({ number: null }, t("einvoice.ewayBillRemoved"))}>
              {t("common.remove")}
            </Button>
          )}
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !/^\d{12}$/.test(form.number) || !form.date} onClick={() => void send({ number: form.number, date: form.date, validUntil: form.validUntil || null }, t("einvoice.ewayBillSaved"))}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
            {translateError(i18n, error)}
          </p>
        )}
        <Field label={t("einvoice.ewayBillNumber")} htmlFor="ewb-number" hint={t("einvoice.ewayBillFormat")}>
          <Input id="ewb-number" inputMode="numeric" maxLength={12} className="[&_input]:font-mono" value={form.number} onChange={(e) => setForm((f) => ({ ...f, number: e.target.value.replace(/\D/g, "") }))} />
        </Field>
        <Field label={t("einvoice.ewayBillDate")} htmlFor="ewb-date">
          <Input id="ewb-date" type="datetime-local" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        </Field>
        <Field label={t("einvoice.validUntil")} htmlFor="ewb-valid" hint={t("common.optional")}>
          <Input id="ewb-valid" type="datetime-local" value={form.validUntil} onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))} />
        </Field>
      </div>
    </Dialog>
  );
}
