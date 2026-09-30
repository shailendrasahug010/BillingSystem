import { needsEInvoice, needsEwayBill, type ZeroRatedType } from "@vyapaar/core";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileJson, Truck } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { ErrorNote } from "../../components/ui/Page";
import { allowed, WORKSPACE } from "../../data/db";
import { ApiError } from "../../lib/api";
import { downloadPortalFile, EwayBillDialog, fileName, IrnDialog, type EwayTarget, type IrnTarget } from "../gst/einvoiceDialogs";
import type { ApiInvoice } from "./printable";

/**
 * An invoice's e-invoice (IRN) and e-way bill: download the portal's JSON,
 * upload it there, then record what the portal returns. Shown when the bill
 * needs either (a B2B / SEZ / export bill with e-invoicing on; a value above
 * the e-way bill limit) or already has one.
 */
export function EInvoiceCard({ invoice, cancelled }: { invoice: ApiInvoice; cancelled: boolean }) {
  const { t, dateTime } = useI18n();
  const qc = useQueryClient();
  const [irnFor, setIrnFor] = useState<IrnTarget | null>(null);
  const [ewayFor, setEwayFor] = useState<EwayTarget | null>(null);
  const [error, setError] = useState<unknown>(null);
  const einvoice = Boolean(invoice.irn) || (WORKSPACE.einvoice && needsEInvoice({ buyerGstin: invoice.partyGstin, zeroRatedType: (invoice.zeroRatedType ?? null) as ZeroRatedType | null }));
  const eway = Boolean(invoice.ewayBillNumber) || needsEwayBill(invoice.grandTotal, WORKSPACE.ewayThreshold);
  if (!einvoice && !eway) return null;
  const canEdit = allowed("invoice.update") && !cancelled;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["invoice-raw", invoice.id] });
  const download = async (path: string, name: string) => {
    setError(null);
    try {
      await downloadPortalFile(path, { ids: invoice.id }, name);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };
  const row = (icon: React.ReactNode, title: string, status: React.ReactNode, actions: React.ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-ink">{icon}</span>
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{title}</p>
          <div className="text-[12.5px] text-ink-2">{status}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-1 shadow-card" aria-label={t("einvoice.cardTitle")}>
      {error ? <ErrorNote error={error} className="mt-2" /> : null}
      <div className="divide-y divide-line">
        {einvoice &&
          row(
            <FileJson size={17} />,
            t("einvoice.title"),
            invoice.irn ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <CheckCircle2 size={14} className="text-good" />
                <span className="font-mono text-[11.5px] break-all">{invoice.irn.slice(0, 24)}…</span>
                {invoice.irnAckNumber && <span className="text-ink-3">· {invoice.irnAckNumber}</span>}
              </span>
            ) : cancelled ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="text-warn">{t("einvoice.noIrnYet")}</span>
            ),
            <>
              {!invoice.irn && !cancelled && (
                <Button size="sm" icon={<Download size={14} />} onClick={() => void download("/einvoice/file", fileName("EINV", invoice.invoiceNumber))}>
                  {t("einvoice.json")}
                </Button>
              )}
              {canEdit && (
                <Button size="sm" onClick={() => setIrnFor({ kind: "invoice", id: invoice.id, number: invoice.invoiceNumber, irn: invoice.irn ?? null, ackNumber: invoice.irnAckNumber ?? null, ackDate: invoice.irnAckDate ?? null, signedQrCode: invoice.signedQrCode ?? null })}>
                  {invoice.irn ? t("einvoice.changeIrn") : t("einvoice.enterIrn")}
                </Button>
              )}
            </>,
          )}
        {eway &&
          row(
            <Truck size={17} />,
            t("einvoice.ewayTitle"),
            invoice.ewayBillNumber ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <CheckCircle2 size={14} className="text-good" />
                <span className="font-mono">{invoice.ewayBillNumber}</span>
                {invoice.ewayBillValidUntil && <span className="text-ink-3">· {t("einvoice.validTill", { date: dateTime(invoice.ewayBillValidUntil) })}</span>}
              </span>
            ) : cancelled ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="text-warn">{t("einvoice.noEwayYet")}</span>
            ),
            <>
              {!invoice.ewayBillNumber && !cancelled && (
                <Button size="sm" icon={<Download size={14} />} onClick={() => void download("/ewaybills/file", fileName("EWB", invoice.invoiceNumber))}>
                  {t("einvoice.json")}
                </Button>
              )}
              {canEdit && (
                <Button size="sm" onClick={() => setEwayFor({ id: invoice.id, number: invoice.invoiceNumber, ewayBillNumber: invoice.ewayBillNumber ?? null, ewayBillDate: invoice.ewayBillDate ?? null, validUntil: invoice.ewayBillValidUntil ?? null })}>
                  {invoice.ewayBillNumber ? t("einvoice.changeEwayBill") : t("einvoice.enterEwayBill")}
                </Button>
              )}
            </>,
          )}
      </div>
      {cancelled && invoice.irn && <p className="pb-2.5 text-[12.5px] text-warn">{t("einvoice.cancelOnPortal")}</p>}
      <IrnDialog target={irnFor} onClose={() => setIrnFor(null)} onSaved={refresh} />
      <EwayBillDialog target={ewayFor} onClose={() => setEwayFor(null)} onSaved={refresh} />
    </section>
  );
}
