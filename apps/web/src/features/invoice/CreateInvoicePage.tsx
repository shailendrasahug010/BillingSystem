import { translateError } from "@digitalbahi/i18n";
import { ArrowLeft, ArrowRight, Camera, Check, Copy, ScanBarcode, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { INVOICE_SHORTCUTS, useShortcuts } from "../../app/shortcuts";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Field";
import { Kbd } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS, CUSTOMERS, PRODUCTS } from "../../data/db";
import { LIVE } from "../../data/source";
import { customerInsight, getSyncState, peekNextInvoiceNumber, saveInvoice, useStoreVersion } from "../../data/store";
import { ApiError, newIdempotencyKey } from "../../lib/api";
import { peekOfflineNumber } from "../../offline/device";
import { getOfflineState, isWaitingCustomer, useOffline } from "../../offline/sync";
import { postInvoice, type SavedInvoice } from "./postInvoice";
import { OfflineNotReady, saveOffline } from "./saveOffline";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { CustomerCard } from "./CustomerCard";
import { CustomerPicker } from "./CustomerPicker";
import { LineItems } from "./LineItems";
import { ProductSearch } from "./ProductSearch";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { SummaryPanel } from "./SummaryPanel";
import { AddCustomerDialog } from "../customers/AddCustomerDialog";
import { unitSymbolOf, useInvoiceDraft, type DraftView } from "./useInvoiceDraft";
import { BarcodeCamera } from "../../components/scan/BarcodeCamera";
import { nativeScanner, scanWithPhone } from "../../components/scan/barcode";

/**
 * Adds products by barcode: the camera reads packs one after another (on
 * phones and tablets it starts by itself; in the Android app the phone's own
 * scanner), and a USB or Bluetooth scanner types the code and presses Enter.
 */
function ScanDialog({ open, onOpenChange, onFound }: { open: boolean; onOpenChange(v: boolean): void; onFound(productId: string): void }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [miss, setMiss] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [camera, setCamera] = useState(false);
  const phoneScanner = nativeScanner() !== null;
  const sample = PRODUCTS.slice(0, 3);
  useEffect(() => {
    if (!open) return;
    setCode("");
    setMiss(null);
    setAdded([]);
    // A phone or tablet scans with its camera; a desk has a scanner (or turns the camera on).
    setCamera(!phoneScanner && window.matchMedia?.("(pointer: coarse)").matches);
  }, [open, phoneScanner]);
  const take = (raw: string, keepOpen: boolean) => {
    const wanted = raw.trim();
    const p = PRODUCTS.find((x) => x.barcode === wanted || x.barcodes?.includes(wanted));
    if (!p) {
      setMiss(wanted);
      return false;
    }
    onFound(p.id);
    setMiss(null);
    setAdded((a) => [p.name, ...a].slice(0, 4));
    if (!keepOpen) onOpenChange(false);
    return true;
  };
  const withPhone = async () => {
    try {
      const scanned = await scanWithPhone();
      if (scanned) take(scanned, true);
    } catch {
      // The phone's scanner is not ready (Google's module downloads once): the camera in the page meanwhile.
      void nativeScanner()
        ?.installGoogleBarcodeScannerModule?.()
        .catch(() => undefined);
      setCamera(true);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("invoice.scan")} description={t("scan.dialogHint")} size="sm" closeLabel={t("common.close")}>
      <div className="flex flex-col gap-3">
        {camera ? (
          <BarcodeCamera onCode={(c) => take(c, true)} />
        ) : (
          <Button icon={<Camera size={16} />} onClick={() => (phoneScanner ? void withPhone() : setCamera(true))}>
            {t("scan.useCamera")}
          </Button>
        )}
        {added.length > 0 && (
          <ul className="flex flex-col gap-1" role="status" aria-label={t("scan.addedList")}>
            {added.map((name, i) => (
              <li key={`${name}-${i}`} className={cn("flex items-center gap-2 text-[13px]", i === 0 ? "font-medium text-good" : "text-ink-3")}>
                <Check size={14} />
                {t("scan.added", { name })}
              </li>
            ))}
          </ul>
        )}
        {miss && <p className="text-[12.5px] text-danger">{t("scan.unknown", { code: miss })}</p>}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (take(code, false)) setCode("");
          }}
        >
          <Input id="scan-code" autoFocus={!camera} inputMode="numeric" placeholder="890…" aria-label={t("scan.typeCode")} value={code} onChange={(e) => setCode(e.target.value)} leading={<ScanBarcode size={16} />} invalid={Boolean(miss)} />
          <div className={cn("flex flex-wrap gap-1.5 text-[12px] text-ink-3", LIVE && "hidden")}>
            {t("common.sampleData")}:
            {sample.map((p) => (
              <button key={p.id} type="button" className="font-mono text-accent hover:underline" onClick={() => setCode(p.barcode)}>
                {p.barcode}
              </button>
            ))}
          </div>
          <Button type="submit" variant="primary" disabled={!code.trim()}>
            {t("common.add")}
          </Button>
        </form>
      </div>
    </Dialog>
  );
}

function ShareDialog({ text, onClose }: { text: string | null; onClose(): void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog open={text !== null} onOpenChange={(v) => !v && onClose()} title={t("invoice.saveAndShare")} size="md" closeLabel={t("common.close")}>
      <textarea ref={ref} readOnly value={text ?? ""} rows={9} className="w-full rounded-lg border border-line bg-surface-2 p-3 font-mono text-[12.5px] text-ink" />
      <div className="mt-3 flex justify-end">
        <Button
          icon={copied ? <Check size={16} /> : <Copy size={16} />}
          onClick={() => {
            // No clipboard on a page that is not secure (plain http at a network address): select it to copy by hand.
            if (!navigator.clipboard) return ref.current?.select();
            navigator.clipboard
              .writeText(text ?? "")
              .then(() => setCopied(true))
              .catch(() => ref.current?.select());
          }}
        >
          {copied ? "Copied" : "Copy message"}
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * The number shown before saving: demo mode knows it; live numbers are
 * assigned by the server, except offline, where the device gives its own.
 */
export function useNextNumberLabel(date: string): string {
  const { t } = useI18n();
  const offline = useOffline();
  if (!LIVE) return peekNextInvoiceNumber();
  if ((offline.offlineMode || !offline.online) && offline.device) return peekOfflineNumber(offline.device, date);
  return t("invoice.numberOnSave");
}

/** No server to talk to: the bill is kept on the device. */
const workingOffline = () => getOfflineState().offlineMode || !navigator.onLine;

/** Credit blocks stop the save unless the user may override the limit (the server applies the same rule). */
export function isBlocked(view: DraftView): boolean {
  return view.credit?.level === "block" && !allowed("invoice.override_credit_limit");
}

const WARNING_KEYS: Record<string, string> = {
  insufficient_stock: "errors.INSUFFICIENT_STOCK",
  credit_limit_exceeded: "credit.credit_limit_exceeded",
  overdue_invoices: "credit.overdue_invoices",
};

function useSave(view: DraftView) {
  const i18n = useI18n();
  const { t, money } = i18n;
  const toast = useToast();
  const { navigate } = useRouter();
  const [shareText, setShareText] = useState<string | null>(null);
  const saving = useRef(false);
  const idempotencyKey = useRef(newIdempotencyKey());

  const afterSave = useCallback(
    (invoice: SavedInvoice, mode: "save" | "print" | "share", offline: boolean) => {
      const { customer, dueDate } = view;
      const warning = invoice.warnings[0];
      toast({
        tone: offline ? "offline" : warning ? "info" : "success",
        title: t("invoice.saved", { number: invoice.number }),
        ...(offline
          ? { body: t("invoice.savedOffline") }
          : warning
            ? { body: t((WARNING_KEYS[warning.code] ?? "errors.generic") as "errors.generic", warning.params) }
            : { body: `${customer!.businessName} · ${money(invoice.total)}` }),
        action: { label: t("common.details"), onClick: () => navigate({ name: "invoice-view", invoiceId: invoice.id }) },
      });
      // Feedback on the suggestions goes with a bill saved online (the server knows that bill).
      if (offline) view.feedback.reset();
      else view.feedback.send(invoice.id, view.draft.lines.map((l) => l.productId));
      view.dispatch({ type: "reset" });
      if (mode === "print") navigate({ name: "invoice-view", invoiceId: invoice.id });
      if (mode === "share") {
        const balance = invoice.total - invoice.paid;
        setShareText(
          [
            `${BUSINESS.name}`,
            `Invoice ${invoice.number} · ${invoice.date.split("-").reverse().join("/")}`,
            `${customer!.businessName}`,
            `Items: ${invoice.lineCount}`,
            `Total: ${money(invoice.total)}`,
            invoice.paid > 0 ? `Received: ${money(invoice.paid)}` : "",
            balance > 0 ? `Balance due: ${money(balance)} by ${dueDate.split("-").reverse().join("/")}` : "Paid in full. Thank you!",
            BUSINESS.bank.upi ? `UPI: ${BUSINESS.bank.upi}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    },
    [view, toast, t, money, navigate],
  );

  const save = useCallback(
    (mode: "save" | "print" | "share") => {
      const { totals, customer, draft, dueDate } = view;
      if (!totals || !customer) return;
      if (isBlocked(view)) return;
      if (LIVE) {
        if (saving.current) return;
        saving.current = true;
        const key = idempotencyKey.current;
        const offline = (invoice: SavedInvoice) => ({ invoice, offline: true });
        // Offline, or the connection dropped on the way: keep the bill on the device (same key, so never twice).
        // A customer added offline and not sent yet: the bill waits behind them.
        const attempt = workingOffline() || isWaitingCustomer(customer.id)
          ? saveOffline(view, key).then(offline)
          : postInvoice(view, key).then(
              (invoice) => ({ invoice, offline: false }),
              (e: unknown) => {
                if (e instanceof ApiError && e.code === "network" && getOfflineState().device) return saveOffline(view, key).then(offline);
                throw e;
              },
            );
        attempt
          .then(({ invoice, offline: savedOffline }) => {
            idempotencyKey.current = newIdempotencyKey();
            afterSave(invoice, mode, savedOffline);
          })
          .catch((e: unknown) => {
            if (e instanceof OfflineNotReady) {
              toast({ tone: "offline", title: t("invoice.saveFailed"), body: t("offline.notReady") });
              return;
            }
            const err = e instanceof ApiError ? e : new ApiError(0, "generic");
            // A definite rejection will not change on retry: start a fresh key for the corrected bill.
            if (err.status >= 400 && err.status < 500) idempotencyKey.current = newIdempotencyKey();
            toast({ tone: err.code === "network" ? "offline" : "danger", title: t("invoice.saveFailed"), body: translateError(i18n, err) });
          })
          .finally(() => {
            saving.current = false;
          });
        return;
      }
      const paid = Math.min(totals.amountPaid.toNumber(), totals.grandTotal.toNumber());
      const invoice = saveInvoice(
        {
          date: draft.date,
          dueDate,
          customerId: customer.id,
          lines: draft.lines.map((l) => ({ productId: l.productId, qty: l.qty, rate: l.rate, discountPercent: l.discountPercent })),
          taxable: totals.taxableTotal.toNumber(),
          tax: totals.taxTotal.toNumber(),
          total: totals.grandTotal.toNumber(),
          cost: 0,
          paid,
          settledOn: paid >= totals.grandTotal.toNumber() ? draft.date : null,
        },
        paid > 0 ? { date: draft.date, customerId: customer.id, amount: paid, method: draft.method, reference: "" } : undefined,
      );
      afterSave({ id: invoice.id, number: invoice.number, date: invoice.date, total: invoice.total, paid: invoice.paid, lineCount: invoice.lines.length, warnings: [] }, mode, !getSyncState().online);
    },
    [view, toast, t, i18n, afterSave],
  );
  return { save, shareText, closeShare: () => setShareText(null) };
}

function DesktopInvoice({ view }: { view: DraftView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { navigate } = useRouter();
  const productRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const { save, shareText, closeShare } = useSave(view);
  const { draft, dispatch, customer, insight, totals, error, credit } = view;
  const numberLabel = useNextNumberLabel(draft.date);
  const blocked = isBlocked(view);
  useStoreVersion();

  useShortcuts([
    { id: "focus-product", keys: INVOICE_SHORTCUTS.focusProduct, allowInInputs: true, handler: () => productRef.current?.focus() },
    { id: "focus-customer", keys: INVOICE_SHORTCUTS.focusCustomer, allowInInputs: true, handler: () => (customer ? dispatch({ type: "customer", customerId: null }) : customerRef.current?.focus()) },
    { id: "save", keys: INVOICE_SHORTCUTS.save, allowInInputs: true, handler: () => save("save") },
  ]);

  const onFocused = useCallback(() => dispatch({ type: "focused" }), [dispatch]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate({ name: "dashboard" })} className="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 hover:text-ink" aria-label={t("common.back")}>
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-[24px] font-semibold text-ink">{t("invoice.new")}</h1>
        </div>
        <div className="hidden items-center gap-4 text-[12.5px] text-ink-3 xl:flex">
          <span className="inline-flex items-center gap-1.5">
            <Kbd keys="f3" /> {t("shortcuts.focusCustomer")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd keys="f2" /> {t("shortcuts.focusProduct")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd keys="alt+1" /> {t("shortcuts.addSuggestion")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd keys="mod+enter" /> {t("shortcuts.saveInvoice")}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          {customer && insight ? (
            <CustomerCard customer={customer} insight={insight} credit={credit} onClear={() => dispatch({ type: "customer", customerId: null })} />
          ) : (
            <div className="flex flex-col gap-2">
              <label className="text-[13px] font-medium text-ink-2" htmlFor="customer-search">
                {t("invoice.customer")}
              </label>
              <CustomerPicker
                ref={customerRef}
                autoFocus
                onSelect={(id) => {
                  dispatch({ type: "customer", customerId: id });
                  setTimeout(() => productRef.current?.focus(), 0);
                }}
                onAdd={canAddCustomer() ? setAdding : undefined}
              />
            </div>
          )}

          <ProductSearch ref={productRef} customer={customer} insight={insight} cartIds={draft.lines.map((l) => l.productId)} onAdd={(id) => dispatch({ type: "add", productId: id })} onScan={() => setScanOpen(true)} />

          <SuggestionsPanel
            hasCustomer={Boolean(customer)}
            customerName={customer?.businessName ?? null}
            suggestions={view.suggestions}
            reorder={view.reorder}
            onAdd={(productId, qty) => {
              view.feedback.taken(productId, view.suggestions);
              dispatch({ type: "add", productId, qty });
            }}
            onShown={(visible) => view.feedback.offered(visible, view.suggestions)}
          />

          <section className="rounded-[var(--radius-card)] border border-line bg-surface shadow-card" aria-labelledby="items-h">
            <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
              <h2 id="items-h" className="text-[15px] font-semibold text-ink">
                {t("invoice.items")} <span className="num ml-1 text-[13px] font-normal text-ink-3">{draft.lines.length}</span>
              </h2>
              {draft.lines.length > 0 && <p className="hidden text-[12px] text-ink-3 md:block">{t("invoice.keysHint")}</p>}
            </div>
            {error && (
              <p className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
                <TriangleAlert size={15} />
                {translateError(i18n, error)}
              </p>
            )}
            <LineItems
              lines={draft.lines}
              totals={totals}
              focusKey={draft.focusKey}
              onFocused={onFocused}
              onUpdate={(key, patch) => dispatch({ type: "update", key, patch })}
              onUnit={(key, unitId) => dispatch({ type: "unit", key, unitId })}
              onRemove={(key) => dispatch({ type: "remove", key })}
              onBackToSearch={() => productRef.current?.focus()}
            />
          </section>
        </div>

        <div className="lg:sticky lg:top-24">
          <SummaryPanel view={view} invoiceNumber={numberLabel} onSave={save} blocked={blocked} />
        </div>
      </div>

      <ScanDialog open={scanOpen} onOpenChange={setScanOpen} onFound={(id) => dispatch({ type: "add", productId: id })} />
      <AddCustomerDialog
        open={adding !== null}
        onOpenChange={(v) => !v && setAdding(null)}
        initial={adding ?? ""}
        onCreated={(id) => {
          dispatch({ type: "customer", customerId: id });
          setTimeout(() => productRef.current?.focus(), 0);
        }}
      />
      <ShareDialog text={shareText} onClose={closeShare} />
    </div>
  );
}

/** Phone flow: Customer → Products → Review & pay, big targets, sticky total. */
function MobileInvoice({ view }: { view: DraftView }) {
  const { t, money, locale } = useI18n();
  const { save, shareText, closeShare } = useSave(view);
  const [step, setStep] = useState(view.customer ? 1 : 0);
  const [scanOpen, setScanOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const productRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const { draft, dispatch, customer, insight, totals, credit } = view;
  const numberLabel = useNextNumberLabel(draft.date);
  const onFocused = useCallback(() => dispatch({ type: "focused" }), [dispatch]);
  const toProducts = () => {
    setStep(1);
    setTimeout(() => productRef.current?.focus(), 0);
  };

  // The same keys as the full screen, for tablets and small laptops with a keyboard.
  useShortcuts([
    { id: "focus-product", keys: INVOICE_SHORTCUTS.focusProduct, allowInInputs: true, handler: () => customer && toProducts() },
    {
      id: "focus-customer",
      keys: INVOICE_SHORTCUTS.focusCustomer,
      allowInInputs: true,
      handler: () => {
        setStep(0);
        setTimeout(() => customerRef.current?.focus(), 0);
      },
    },
    { id: "save", keys: INVOICE_SHORTCUTS.save, allowInInputs: true, handler: () => totals && (step === 2 ? save("save") : setStep(2)) },
  ]);

  const recent = useMemo(
    () =>
      CUSTOMERS.map((c) => ({ c, last: customerInsight(c.id).lastPurchase ?? "" }))
        .sort((a, b) => b.last.localeCompare(a.last))
        .slice(0, 6),
    [],
  );

  const steps = [t("invoice.steps.customer"), t("invoice.steps.products"), t("invoice.steps.review")];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[21px] font-semibold text-ink">{t("invoice.quick")}</h1>
        <span className="font-mono text-[12.5px] text-ink-3">{numberLabel}</span>
      </div>
      <ol className="grid grid-cols-3 gap-2" aria-label={t("invoice.quick")}>
        {steps.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              disabled={i > 0 && !customer}
              onClick={() => setStep(i)}
              aria-current={step === i ? "step" : undefined}
              className={cn("flex w-full flex-col gap-1.5 text-left text-[12px] font-medium disabled:opacity-40", step === i ? "text-accent" : step > i ? "text-ink-2" : "text-ink-3")}
            >
              <span className={cn("h-1 rounded-full", step >= i ? "bg-accent" : "bg-surface-3")} />
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <CustomerPicker
            ref={customerRef}
            large
            onSelect={(id) => {
              dispatch({ type: "customer", customerId: id });
              toProducts();
            }}
            onAdd={canAddCustomer() ? setAdding : undefined}
          />
          <div>
            <p className="eyebrow mb-2">{t("invoice.customerCard.lastPurchase")}</p>
            <ul className="flex flex-col gap-2">
              {recent.map(({ c }) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      dispatch({ type: "customer", customerId: c.id });
                      setStep(1);
                    }}
                    className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-ink">{c.businessName}</span>
                      <span className="block truncate text-[12.5px] text-ink-3">
                        {c.city} · {c.route}
                      </span>
                    </span>
                    <ArrowRight size={18} className="text-ink-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {step === 1 && customer && insight && (
        <div className="flex flex-col gap-4">
          <button type="button" onClick={() => setStep(0)} className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-left">
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-ink">{customer.businessName}</span>
              <span className={cn("num text-[12.5px]", insight.overdue > 0 ? "text-danger" : "text-ink-3")}>
                {t("invoice.customerCard.outstanding")} {money(insight.outstanding, 0)}
              </span>
            </span>
            <span className="text-[13px] font-medium text-accent">{t("invoice.changeCustomer")}</span>
          </button>
          <ProductSearch ref={productRef} large customer={customer} insight={insight} cartIds={draft.lines.map((l) => l.productId)} onAdd={(id) => dispatch({ type: "add", productId: id })} onScan={() => setScanOpen(true)} />
          <SuggestionsPanel
            variant="mobile"
            hasCustomer
            customerName={customer.businessName}
            suggestions={view.suggestions}
            reorder={view.reorder}
            onAdd={(productId, qty) => {
              view.feedback.taken(productId, view.suggestions);
              dispatch({ type: "add", productId, qty });
            }}
            onShown={(visible) => view.feedback.offered(visible, view.suggestions)}
          />
          <section className="rounded-[var(--radius-card)] border border-line bg-surface px-4 shadow-card">
            <h2 className="pt-3 text-[15px] font-semibold text-ink">
              {t("invoice.items")} <span className="num text-ink-3">{draft.lines.length}</span>
            </h2>
            <LineItems
              variant="mobile"
              lines={draft.lines}
              totals={totals}
              focusKey={draft.focusKey}
              onFocused={onFocused}
              onUpdate={(key, patch) => dispatch({ type: "update", key, patch })}
              onUnit={(key, unitId) => dispatch({ type: "unit", key, unitId })}
              onRemove={(key) => dispatch({ type: "remove", key })}
              onBackToSearch={() => productRef.current?.focus()}
            />
          </section>
          <div className="glass fixed inset-x-3 bottom-[calc(84px+env(safe-area-inset-bottom,0px))] z-20 rounded-2xl border border-line/70 px-4 py-3 shadow-pop">
            <div className="mx-auto flex max-w-xl items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-ink-3">{t("invoice.lineCount", { count: draft.lines.length, qty: totals ? totals.totalQty.toString() : "0" })}</p>
                <p className="num font-display text-[22px] leading-tight font-semibold text-ink">{money(totals?.grandTotal.toNumber() ?? 0)}</p>
              </div>
              <Button variant="primary" size="lg" disabled={!totals} onClick={() => setStep(2)} trailing={<ArrowRight size={18} />}>
                {t("common.next")}
              </Button>
            </div>
          </div>
          <div className="h-24" aria-hidden />
        </div>
      )}

      {step === 2 && customer && insight && (
        <div className="flex flex-col gap-4">
          <CustomerCard customer={customer} insight={insight} credit={credit} compact />
          <section className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-2 shadow-card">
            <p className="eyebrow pt-2">{t("invoice.reviewItems")}</p>
            <ul className="divide-y divide-line">
              {draft.lines.map((l) => {
                const r = totals?.lines.find((x) => x.key === l.key);
                const p = PRODUCTS.find((x) => x.id === l.productId)!;
                return (
                  <li key={l.key} className="flex items-center justify-between gap-3 py-2.5 text-[14px]">
                    <span className="min-w-0 truncate text-ink">
                      {locale === "hi" ? p.nameHi : p.name} <span className="num text-ink-3">× {l.qty} {unitSymbolOf(p, l.unitId)}</span>
                    </span>
                    <span className="num font-medium text-ink">{r ? money(r.total.toNumber()) : ""}</span>
                  </li>
                );
              })}
            </ul>
          </section>
          <SummaryPanel view={view} invoiceNumber={numberLabel} onSave={(m) => {
            save(m);
            setStep(0);
          }} blocked={isBlocked(view)} />
        </div>
      )}

      <ScanDialog open={scanOpen} onOpenChange={setScanOpen} onFound={(id) => dispatch({ type: "add", productId: id })} />
      <AddCustomerDialog
        open={adding !== null}
        onOpenChange={(v) => !v && setAdding(null)}
        initial={adding ?? ""}
        onCreated={(id) => {
          dispatch({ type: "customer", customerId: id });
          toProducts();
        }}
      />
      <ShareDialog text={shareText} onClose={closeShare} />
    </div>
  );
}

/** Customers can be added while billing by anyone allowed to add them (offline too: sent before the bill). */
const canAddCustomer = () => LIVE && allowed("customer.create");

export function CreateInvoicePage({ customerId }: { customerId?: string }) {
  const view = useInvoiceDraft(customerId ?? null);
  // The full screen (with its keyboard shortcuts) from tablet width up; the step-by-step one on phones.
  const desktop = useMediaQuery("(min-width: 768px)");
  return desktop ? <DesktopInvoice view={view} /> : <MobileInvoice view={view} />;
}
