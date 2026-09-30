import { findState, PAYMENT_METHODS, type PaymentMethod } from "@vyapaar/core";
import { MessageCircle, Printer, Save } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Kbd } from "../../components/ui/misc";
import { allowed, BUSINESS, WORKSPACE } from "../../data/db";
import { cn } from "../../lib/cn";
import { lutValidOn, type DraftView } from "./useInvoiceDraft";
import { stateName } from "../../lib/states";

function Row({ label, value, strong, muted, negative }: { label: ReactNode; value: string; strong?: boolean; muted?: boolean; negative?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", strong ? "text-[15px]" : "text-[13.5px]")}>
      <dt className={cn(muted ? "text-ink-3" : "text-ink-2")}>{label}</dt>
      <dd className={cn("num", strong ? "font-semibold text-ink" : negative ? "text-good" : "text-ink")}>{value}</dd>
    </div>
  );
}

export function PaymentModes({ value, onChange, size = "md" }: { value: PaymentMethod; onChange(m: PaymentMethod): void; size?: "md" | "lg" }) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t("invoice.paymentMode")} className="flex flex-wrap gap-1.5">
      {PAYMENT_METHODS.filter((m) => m !== "other").map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={cn(
            "rounded-lg border font-medium transition-colors",
            size === "lg" ? "h-11 px-4 text-[14px]" : "h-8 px-3 text-[12.5px]",
            value === m ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:border-line-strong",
          )}
        >
          {t(`paymentMethod.${m}`)}
        </button>
      ))}
    </div>
  );
}

/**
 * An export or a supply to an SEZ unit: IGST paid now (refunded later) or not
 * charged under the LUT / bond, and for an export the shipping bill, which can
 * also be added on the invoice later.
 */
function ZeroRatedChoice({ view }: { view: DraftView }) {
  const { t, date, locale } = useI18n();
  const { draft, dispatch } = view;
  const z = view.zeroRated!;
  const c = draft.zeroRated;
  const lut = WORKSPACE.lut;
  const set = (patch: Partial<typeof c>) => dispatch({ type: "zeroRated", patch });
  const option = (withPayment: boolean, label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
      <input type="radio" name="zero-rated" className="size-4 accent-[var(--accent)]" checked={z.withPayment === withPayment} onChange={() => set({ withPayment })} />
      {label}
    </label>
  );
  return (
    <section className="flex flex-col gap-2.5 rounded-xl bg-accent-soft/60 px-3 py-2.5 text-[12.5px] text-ink-2" aria-labelledby="zero-rated-h">
      <div>
        <p id="zero-rated-h" className="font-medium text-ink">
          {t(z.kind === "export" ? "invoice.export.titleExport" : "invoice.export.titleSez")} · {t("invoice.supplyInter")}
        </p>
        <p>
          {t("invoice.placeOfSupply")}: {stateName(z.kind === "export" ? "96" : (view.customer?.stateCode ?? ""), locale)}
        </p>
        <p className="mt-1 text-ink-3">{t("invoice.export.hint")}</p>
      </div>
      <div role="radiogroup" aria-labelledby="zero-rated-h" className="flex flex-col gap-1.5">
        {option(false, t("invoice.export.underLut"))}
        {option(true, t("invoice.export.withPayment"))}
      </div>
      {!z.withPayment &&
        (lut && lutValidOn(draft.date) ? (
          <p className="text-ink-3">{t("invoice.export.lutSaved", { arn: lut.arn, until: date(lut.validUntil) })}</p>
        ) : (
          <p className="rounded-lg bg-warn-soft px-2.5 py-1.5 text-warn">{t("invoice.export.noLut")}</p>
        ))}
      {z.kind === "export" && (
        <div className="grid grid-cols-2 gap-2 border-t border-line/70 pt-2.5">
          <Field label={t("invoice.export.shippingBillNumber")} htmlFor="sb-number">
            <Input id="sb-number" inputSize="sm" inputMode="numeric" maxLength={20} value={c.shippingBillNumber} onChange={(e) => set({ shippingBillNumber: e.target.value.replace(/\D/g, "") })} />
          </Field>
          <Field label={t("invoice.export.portCode")} htmlFor="sb-port">
            <Input id="sb-port" inputSize="sm" maxLength={6} className="[&_input]:font-mono [&_input]:uppercase" placeholder="INNSA1" value={c.portCode} onChange={(e) => set({ portCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} />
          </Field>
          <div className="col-span-2">
            <Field label={t("invoice.export.shippingBillDate")} htmlFor="sb-date" hint={t("invoice.export.later")}>
              <Input id="sb-date" inputSize="sm" type="date" min={draft.date} value={c.shippingBillDate} onChange={(e) => set({ shippingBillDate: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </section>
  );
}

export function SummaryPanel({
  view,
  invoiceNumber,
  onSave,
  blocked,
}: {
  view: DraftView;
  invoiceNumber: string;
  onSave(mode: "save" | "print" | "share"): void;
  blocked: boolean;
}) {
  const { t, money, date, locale } = useI18n();
  const { totals, draft, dispatch, supplyType, stateComponent, customer, dueDate } = view;
  const pos = findState(customer?.stateCode ?? BUSINESS.stateCode);
  const intra = supplyType === "intra_state";
  const grand = totals?.grandTotal.toNumber() ?? 0;

  return (
    <aside className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line/80 bg-surface p-4 shadow-card sm:p-5" aria-label={t("invoice.summary")}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">{t("invoice.taxInvoice")}</p>
          <p className="mt-0.5 font-mono text-[15px] font-medium text-ink">{invoiceNumber}</p>
        </div>
        <div className="text-right text-[12.5px] text-ink-3">
          <p>
            {t("invoice.date")}: <span className="num text-ink-2">{date(draft.date)}</span>
          </p>
          <p>
            {t("invoice.dueDate")}: <span className="num text-ink-2">{date(dueDate)}</span>
          </p>
        </div>
      </div>

      {view.zeroRated ? (
        <ZeroRatedChoice view={view} />
      ) : (
        <div className="rounded-xl bg-accent-soft/60 px-3 py-2 text-[12.5px] text-ink-2">
          <p className="font-medium text-ink">{intra ? t("invoice.supplyIntra", { state: stateComponent }) : t("invoice.supplyInter")}</p>
          <p>
            {t("invoice.placeOfSupply")}: {pos ? stateName(pos.code, locale) : "—"}
          </p>
        </div>
      )}

      <dl className="flex flex-col gap-2">
        <Row label={t("invoice.lineCount", { count: totals?.lineCount ?? 0, qty: totals ? totals.totalQty.toString() : "0" })} value="" muted />
        <Row label={t("invoice.subtotal")} value={money(totals?.grossTotal.toNumber() ?? 0)} />
        {totals && totals.discountTotal.gt(0) && <Row label={t("invoice.discountTotal")} value={`− ${money(totals.discountTotal.toNumber())}`} negative />}
        <Row label={t("invoice.taxableValue")} value={money(totals?.taxableTotal.toNumber() ?? 0)} />
        {intra ? (
          <>
            <Row label={t("invoice.cgst")} value={money(totals?.cgstTotal.toNumber() ?? 0)} muted />
            <Row label={stateComponent === "UTGST" ? t("invoice.utgst") : t("invoice.sgst")} value={money(totals?.sgstTotal.toNumber() ?? 0)} muted />
          </>
        ) : (
          <Row label={t("invoice.igst")} value={money(totals?.igstTotal.toNumber() ?? 0)} muted />
        )}
        {totals && totals.cessTotal.gt(0) && <Row label={t("invoice.cess")} value={money(totals.cessTotal.toNumber())} muted />}
        <Row label={t("invoice.roundOff")} value={money(totals?.roundOff.toNumber() ?? 0)} muted />
      </dl>

      <div className="bg-hero on-dark relative overflow-hidden rounded-2xl px-4 py-3.5 shadow-glow">
        <div className="dots pointer-events-none absolute inset-0 opacity-40" aria-hidden />
        <div className="relative flex items-baseline justify-between gap-3">
          <span className="text-[14px] font-medium text-ink-2">{t("invoice.grandTotal")}</span>
          <span className="num font-display text-[30px] leading-none font-semibold tracking-tight text-ink">{money(grand)}</span>
        </div>
      </div>

      {totals && totals.rateBreakup.length > 1 && (
        <details className="-mt-1 text-[12.5px] text-ink-3">
          <summary className="cursor-pointer select-none hover:text-ink">{t("gst.rateWise")}</summary>
          <table className="num mt-2 w-full">
            <tbody>
              {totals.rateBreakup.map((r) => (
                <tr key={r.gstRate.toString()} className="border-t border-line">
                  <td className="py-1">GST {r.gstRate.toNumber()}%</td>
                  <td className="py-1 text-right">{money(r.taxable.toNumber())}</td>
                  <td className="py-1 text-right text-ink-2">{money(r.cgst.plus(r.sgst).plus(r.igst).toNumber())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="flex flex-col gap-2.5 border-t border-line pt-3">
        <label htmlFor="amount-received" className="text-[13px] font-medium text-ink-2">
          {t("invoice.amountReceived")}
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">₹</span>
            <input
              id="amount-received"
              inputMode="decimal"
              value={draft.received}
              placeholder="0.00"
              onChange={(e) => dispatch({ type: "received", value: e.target.value.replace(/[^0-9.]/g, "") })}
              className="num h-11 w-full rounded-lg border border-line bg-surface pr-3 pl-7 text-right text-[16px] font-semibold text-ink focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none"
            />
          </div>
          <Button variant="soft" className="h-11" onClick={() => dispatch({ type: "received", value: grand ? grand.toFixed(2) : "" })} disabled={!totals}>
            {t("invoice.fullyPaid")}
          </Button>
        </div>
        <PaymentModes value={draft.method} onChange={(m) => dispatch({ type: "method", value: m })} />
        <div className="flex items-baseline justify-between text-[14px]">
          <span className="text-ink-2">{totals && totals.excessPaid.gt(0) ? t("invoice.advance") : t("invoice.balance")}</span>
          <span className={cn("num font-semibold", totals && totals.balanceDue.gt(0) ? "text-danger" : "text-good")}>
            {money(totals ? (totals.excessPaid.gt(0) ? totals.excessPaid.toNumber() : totals.balanceDue.toNumber()) : 0)}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Button variant="primary" size="lg" block icon={<Save size={18} />} disabled={!totals || !customer || blocked} onClick={() => onSave("save")}>
          {t("invoice.save")}
          <Kbd keys="mod+enter" className="ml-1 [&_kbd]:border-white/30 [&_kbd]:bg-white/15 [&_kbd]:text-white" />
        </Button>
        {(allowed("invoice.print") || allowed("invoice.share")) && (
          <div className="grid grid-cols-2 gap-2">
            {allowed("invoice.print") && (
              <Button icon={<Printer size={16} />} disabled={!totals || !customer || blocked} onClick={() => onSave("print")}>
                {t("invoice.saveAndPrint")}
              </Button>
            )}
            {allowed("invoice.share") && (
              <Button icon={<MessageCircle size={16} />} disabled={!totals || !customer || blocked} onClick={() => onSave("share")}>
                {t("common.whatsapp")}
              </Button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
