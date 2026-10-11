import { translateError } from "@digitalbahi/i18n";
import { ArrowLeft, ArrowRight, Camera, Check, Loader2, Printer, Save, ScanBarcode, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useBackStep, useRouter } from "../../app/router";
import { ariaShortcut, INVOICE_SHORTCUTS, useShortcuts } from "../../app/shortcuts";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Field";
import { CountUp, Kbd } from "../../components/ui/misc";
import { useToast } from "../../components/ui/Toast";
import { allowed, BUSINESS, CUSTOMERS, PRODUCTS, productById } from "../../data/db";
import { requestPull } from "../../data/live";
import { LIVE } from "../../data/source";
import { customerInsight, getSyncState, peekNextInvoiceNumber, saveInvoice, useStoreVersion } from "../../data/store";
import { ApiError, newIdempotencyKey } from "../../lib/api";
import { peekOfflineNumber } from "../../offline/device";
import { getOfflineState, isWaitingCustomer, useOffline } from "../../offline/sync";
import { postInvoice, type SavedInvoice } from "./postInvoice";
import { OfflineNotReady, saveOffline } from "./saveOffline";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { CustomerCard, CustomerStrip } from "./CustomerCard";
import { CustomerPicker } from "./CustomerPicker";
import { CashSaleButton } from "./CashSaleButton";
import { LineItems } from "./LineItems";
import { ProductSearch } from "./ProductSearch";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { SummaryPanel } from "./SummaryPanel";
import { InvoiceSavedDialog, type SavedNotice } from "./InvoiceSavedDialog";
import { saleUnits } from "./units";
import { AddCustomerDialog } from "../customers/AddCustomerDialog";
import { unitSymbolOf, useInvoiceDraft, type DraftView } from "./useInvoiceDraft";
import { dropKeptDraft } from "./keptDraft";
import { recordBilled } from "./topItems";
import { HeldBillsBar, HoldButton, useHeldBills } from "./HeldBills";
import { KeptDraftOffer, useKeptDraft, type KeptDraftState } from "./KeptDraftNotice";
import { BarcodeCamera } from "../../components/scan/BarcodeCamera";
import { nativeScanner, scanWithPhone } from "../../components/scan/barcode";
import { buzz, SAVED, SCANNED } from "../../lib/haptics";

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
      if (scanned) {
        buzz(SCANNED);
        take(scanned, true);
      }
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
  const [saved, setSaved] = useState<SavedNotice | null>(null);
  const saving = useRef(false);
  // A bill on its way to the server: its Save button says so (a slow line can take a few seconds).
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(newIdempotencyKey());

  const afterSave = useCallback(
    (invoice: SavedInvoice, mode: "save" | "print" | "share", offline: boolean) => {
      buzz(SAVED);
      const { customer, dueDate } = view;
      const warning = invoice.warnings[0];
      const warningText = warning ? t((WARNING_KEYS[warning.code] ?? "errors.generic") as "errors.generic", warning.params) : null;
      // Feedback on the suggestions goes with a bill saved online (the server knows that bill).
      if (offline) view.feedback.reset();
      else view.feedback.send(invoice.id, view.draft.lines.map((l) => l.productId));
      // Offered first in the product search for the next bills.
      recordBilled(view.draft.lines.map((l) => l.productId), invoice.date);
      // Saved: not kept as unfinished any more (before Save & print leaves the screen).
      void dropKeptDraft();
      view.dispatch({ type: "reset" });
      // Save & print: the bill opens with the print dialog.
      if (mode === "print") {
        toast({
          tone: offline ? "offline" : warning ? "info" : "success",
          title: t("invoice.saved", { number: invoice.number }),
          ...(offline ? { body: t("invoice.savedOffline") } : warningText ? { body: warningText } : { body: `${customer!.businessName} · ${money(invoice.total)}` }),
        });
        navigate({ name: "invoice-view", invoiceId: invoice.id, print: true });
        return;
      }
      const balance = invoice.total - invoice.paid;
      setSaved({
        id: invoice.id,
        number: invoice.number,
        customerId: customer!.id,
        customerName: customer!.businessName,
        mobile: customer!.mobile ?? null,
        total: invoice.total,
        paid: invoice.paid,
        offline,
        warning: warningText,
        share: mode === "share",
        shareText: [
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
      });
    },
    [view, toast, t, money, navigate],
  );

  /** Saves the bill; true once it is saved (on the server or on the device), false when it was not. */
  const save = useCallback(
    (mode: "save" | "print" | "share"): Promise<boolean> => {
      const { totals, customer, draft, dueDate } = view;
      if (!totals || !customer) return Promise.resolve(false);
      if (isBlocked(view)) return Promise.resolve(false);
      if (LIVE) {
        if (saving.current) return Promise.resolve(false);
        saving.current = true;
        setBusy(true);
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
        return attempt
          .then(({ invoice, offline: savedOffline }) => {
            idempotencyKey.current = newIdempotencyKey();
            afterSave(invoice, mode, savedOffline);
            return true;
          })
          .catch((e: unknown) => {
            if (e instanceof OfflineNotReady) {
              toast({ tone: "offline", title: t("invoice.saveFailed"), body: t("offline.notReady") });
              return false;
            }
            const err = e instanceof ApiError ? e : new ApiError(0, "generic");
            // A definite rejection will not change on retry: start a fresh key for the corrected bill.
            if (err.status >= 400 && err.status < 500) idempotencyKey.current = newIdempotencyKey();
            // A scheme changed on the server (ended, or its slabs): bring the device's schemes up to date.
            if (err.code === "SCHEME_NOT_EARNED" || err.code === "SCHEME_NOT_RUNNING") requestPull();
            toast({ tone: err.code === "network" ? "offline" : "danger", title: t("invoice.saveFailed"), body: translateError(i18n, err) });
            return false;
          })
          .finally(() => {
            saving.current = false;
            setBusy(false);
          });
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
      return Promise.resolve(true);
    },
    [view, toast, t, i18n, afterSave],
  );
  return { save, busy, saved, closeSaved: () => setSaved(null) };
}

/**
 * Takes a line off the bill, and says so with Undo (a bin is easily tapped by mistake on a phone):
 * the line comes back where it was, on this bill only.
 */
function useRemoveLine(view: DraftView) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { dispatch, bill } = view;
  const latest = useRef(view.draft);
  latest.current = view.draft;
  return useCallback(
    (key: string) => {
      const { lines, customerId } = latest.current;
      const index = lines.findIndex((l) => l.key === key);
      const line = lines[index];
      if (!line) return;
      dispatch({ type: "remove", key });
      const p = productById.get(line.productId);
      const from = bill.current;
      toast({
        tone: "info",
        group: "invoice-line-removed",
        title: t("invoice.removedLine", { name: p ? (locale === "hi" ? p.nameHi : p.name) : "" }),
        action: { label: t("common.undo"), onClick: () => bill.current === from && dispatch({ type: "unremove", line, index, customerId }) },
      });
    },
    [dispatch, bill, toast, t, locale],
  );
}

/** A Save button's icon while the bill is on its way: a turning wheel (its name stays, for screen readers and tests). */
const saveIcon = (busy: boolean, size: number) => (busy ? <Loader2 size={size} className="animate-spin" /> : <Save size={size} />);

function DesktopInvoice({ view, kept }: { view: DraftView; kept: KeptDraftState }) {
  const i18n = useI18n();
  const { t, money } = i18n;
  const { navigate } = useRouter();
  const productRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  // null: the suggestions fold into one row once the bill has lines; true / false once the user chose.
  const [suggestionsOpen, setSuggestionsOpen] = useState<boolean | null>(null);
  const { save, busy, saved, closeSaved } = useSave(view);
  const removeLine = useRemoveLine(view);
  const held = useHeldBills(view);
  const { draft, dispatch, customer, insight, totals, error, credit } = view;
  const numberLabel = useNextNumberLabel(draft.date);
  const blocked = isBlocked(view);
  const canSave = Boolean(totals && customer) && !blocked;
  const strip = suggestionsOpen === null ? draft.lines.length > 0 : !suggestionsOpen;
  useStoreVersion();
  // While the total bar shows at the foot (below 1280 px), messages appear above it, not over Save (app.css).
  const barShown = draft.lines.length > 0;
  useEffect(() => {
    if (!barShown) return;
    const root = document.documentElement;
    root.setAttribute("data-total-bar", "");
    return () => root.removeAttribute("data-total-bar");
  }, [barShown]);
  // The letters of the units this bill's products come in ("B BOX, S STRIP"), typed after a quantity.
  const unitLetters = [
    ...new Set(
      draft.lines.flatMap((l) => {
        const units = saleUnits(productById.get(l.productId)!);
        return units.length > 1 ? units.map((u) => `${u.letter} ${u.symbol}`) : [];
      }),
    ),
  ]
    .slice(0, 4)
    .join(", ");

  useShortcuts([
    { id: "focus-product", keys: INVOICE_SHORTCUTS.focusProduct, allowInInputs: true, handler: () => productRef.current?.focus() },
    { id: "focus-customer", keys: INVOICE_SHORTCUTS.focusCustomer, allowInInputs: true, handler: () => (customer ? dispatch({ type: "customer", customerId: null }) : customerRef.current?.focus()) },
    { id: "save", keys: INVOICE_SHORTCUTS.save, allowInInputs: true, handler: () => save("save") },
    { id: "save-alt", keys: INVOICE_SHORTCUTS.saveAlt, allowInInputs: true, handler: () => save("save") },
    // Ctrl+P on the bill being made saves it and prints it (not a print of this screen).
    { id: "save-print", keys: INVOICE_SHORTCUTS.saveAndPrint, allowInInputs: true, handler: () => allowed("invoice.print") && save("print") },
  ]);

  const onFocused = useCallback(() => dispatch({ type: "focused" }), [dispatch]);
  const suggestions = (asStrip: boolean) => (
    <SuggestionsPanel
      hasCustomer={Boolean(customer)}
      customerName={customer?.businessName ?? null}
      suggestions={view.suggestions}
      reorder={view.reorder}
      strip={asStrip}
      onStrip={(folded) => setSuggestionsOpen(!folded)}
      onAdd={(productId, qty) => {
        view.feedback.taken(productId, view.suggestions);
        dispatch({ type: "add", productId, qty });
      }}
      onShown={(visible) => view.feedback.offered(visible, view.suggestions)}
    />
  );
  // The keys of the screen; the less used ones on the widest screens only.
  const hint = (keys: string, label: string, widest = false) => (
    <span className={cn("items-center gap-1.5", widest ? "hidden 2xl:inline-flex" : "inline-flex")}>
      <Kbd keys={keys} /> {label}
    </span>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate({ name: "dashboard" })} className="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 hover:text-ink" aria-label={t("common.back")}>
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-[22px] font-semibold text-ink">{t("invoice.new")}</h1>
          <HoldButton state={held} hasLines={draft.lines.length > 0} />
        </div>
        <div className="hidden items-center gap-4 text-[12px] text-ink-3 xl:flex">
          {hint(INVOICE_SHORTCUTS.focusCustomer, t("shortcuts.focusCustomer"), true)}
          {hint(INVOICE_SHORTCUTS.focusProduct, t("shortcuts.focusProduct"))}
          {hint("alt+1", t("shortcuts.addSuggestion"), true)}
          {hint(INVOICE_SHORTCUTS.save, t("shortcuts.saveInvoice"))}
          {hint(INVOICE_SHORTCUTS.saveAndPrint, t("shortcuts.saveAndPrint"))}
        </div>
      </div>

      <KeptDraftOffer state={kept} />
      <HeldBillsBar state={held} />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          {customer && insight ? (
            <CustomerStrip customer={customer} insight={insight} credit={credit} onClear={() => dispatch({ type: "customer", customerId: null })} />
          ) : (
            // Above the search bar below it, which its list of customers overlaps.
            <div className="relative z-[25] flex flex-col gap-1.5">
              <div className="flex items-end justify-between gap-2">
                <label className="text-[13px] font-medium text-ink-2" htmlFor="customer-search">
                  {t("invoice.customer")}
                </label>
                <CashSaleButton
                  onPicked={(id) => {
                    dispatch({ type: "customer", customerId: id });
                    setTimeout(() => productRef.current?.focus(), 0);
                  }}
                />
              </div>
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

          {/* Stays under the top bar while the lines scroll: the search, and the suggestions once folded into a row. */}
          <div data-overlay="top" className="sticky top-[calc(3.5rem+var(--inset-top))] z-20 -mx-2 flex flex-col gap-2 bg-bg/85 px-2 py-2 backdrop-blur-md lg:top-[calc(4rem+var(--inset-top))]">
            <ProductSearch ref={productRef} customer={customer} insight={insight} cartIds={draft.lines.map((l) => l.productId)} onAdd={(id, how) => dispatch({ type: "add", productId: id, ...how })} onScan={() => setScanOpen(true)} />
            {strip && suggestions(true)}
          </div>
          {!strip && suggestions(false)}

          <section className="rounded-[var(--radius-card)] border border-line bg-surface shadow-card" aria-labelledby="items-h">
            <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1.5">
              <h2 id="items-h" className="text-[15px] font-semibold text-ink">
                {t("invoice.items")} <span className="num ml-1 text-[13px] font-normal text-ink-3">{draft.lines.length}</span>
              </h2>
              {draft.lines.length > 0 && (
                <p className="hidden truncate text-[12px] text-ink-3 md:block" title={unitLetters ? t("invoice.unitKeys", { letters: unitLetters }) : undefined}>
                  {t("invoice.keysHint")}
                  {unitLetters && ` · ${t("invoice.unitKeys", { letters: unitLetters })}`}
                </p>
              )}
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
              onRemove={removeLine}
              onReplace={(key, productId) => dispatch({ type: "replace", key, productId })}
              onBackToSearch={() => productRef.current?.focus()}
              schemes={view.schemes}
              onScheme={(schemeId, on) => dispatch({ type: "scheme", schemeId, on })}
            />
          </section>
        </div>

        <div className="xl:sticky xl:top-20">
          <SummaryPanel view={view} invoiceNumber={numberLabel} onSave={save} blocked={blocked} busy={busy} sticky />
        </div>
      </div>

      {/* Below 1280 px the summary is under the lines: the total and Save stay at the foot of the screen. */}
      {barShown && (
        <>
          {/* --side-w: the menu's width while it takes room beside the page (0 while it is hidden away; AppShell). */}
          <div data-overlay="bottom" className="glass fixed inset-x-3 bottom-[calc(10px+var(--inset-bottom))] z-20 rounded-2xl border border-line/70 px-4 py-2.5 shadow-pop short:bottom-3 lg:right-8 lg:bottom-4 lg:left-[calc(var(--side-w,256px)+2rem)] lg:transition-[left] lg:duration-200 xl:hidden">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-ink-3">{t("invoice.lineCount", { count: draft.lines.length, qty: totals ? totals.totalQty.toString() : "0" })}</p>
                <p className="num font-display text-[20px] leading-tight font-semibold text-ink"><CountUp value={totals?.grandTotal.toNumber() ?? 0} format={(v) => money(v)} duration={300} /></p>
              </div>
              {allowed("invoice.print") && (
                <Button icon={<Printer size={16} />} disabled={!canSave} onClick={() => save("print")} aria-keyshortcuts={ariaShortcut(INVOICE_SHORTCUTS.saveAndPrint)}>
                  {t("common.print")}
                </Button>
              )}
              <Button variant="primary" icon={saveIcon(busy, 16)} disabled={!canSave} aria-busy={busy || undefined} onClick={() => save("save")} aria-keyshortcuts={ariaShortcut(INVOICE_SHORTCUTS.save)}>
                {t("common.save")}
              </Button>
            </div>
          </div>
          <div className="h-16 xl:hidden" aria-hidden />
        </>
      )}

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
      <InvoiceSavedDialog notice={saved} onClose={closeSaved} onNext={() => customerRef.current?.focus()} />
    </div>
  );
}

/** Phone flow: Customer → Products → Review & pay, big targets, sticky total. */
function MobileInvoice({ view, kept }: { view: DraftView; kept: KeptDraftState }) {
  const { t, money, locale } = useI18n();
  const { save, busy, saved, closeSaved } = useSave(view);
  const removeLine = useRemoveLine(view);
  const [step, setStep] = useState(view.customer ? 1 : 0);
  const [scanOpen, setScanOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const productRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const { draft, dispatch, customer, insight, totals, credit } = view;
  const held = useHeldBills(view, (hasCustomer) => setStep(hasCustomer ? 1 : 0));
  const numberLabel = useNextNumberLabel(draft.date);
  const onFocused = useCallback(() => dispatch({ type: "focused" }), [dispatch]);
  const toProducts = () => {
    setStep(1);
    setTimeout(() => productRef.current?.focus(), 0);
  };
  // null: the suggestions fold into one row once the bill has lines; true / false once the user chose.
  const [suggestionsOpen, setSuggestionsOpen] = useState<boolean | null>(null);
  const strip = suggestionsOpen === null ? draft.lines.length > 0 : !suggestionsOpen;
  // Saved from the review: back to the start for the next bill. Not saved: the bill stays open here to try again.
  const saveFromReview = (mode: "save" | "print" | "share") => {
    void save(mode).then((ok) => ok && setStep(0));
  };
  // The phone's Back goes a step back in the bill (Review → Products → Customer), then leaves it.
  useBackStep(() => {
    if (step === 0) return false;
    setStep(step - 1);
    return true;
  });
  const toSave = (mode: "save" | "print") => {
    if (!totals) return;
    if (step === 2) saveFromReview(mode);
    else setStep(2);
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
    { id: "save", keys: INVOICE_SHORTCUTS.save, allowInInputs: true, handler: () => toSave("save") },
    { id: "save-alt", keys: INVOICE_SHORTCUTS.saveAlt, allowInInputs: true, handler: () => toSave("save") },
    { id: "save-print", keys: INVOICE_SHORTCUTS.saveAndPrint, allowInInputs: true, handler: () => allowed("invoice.print") && toSave("print") },
  ]);

  const recent = useMemo(
    () =>
      CUSTOMERS.map((c) => ({ c, last: customerInsight(c.id).lastPurchase ?? "" }))
        .sort((a, b) => b.last.localeCompare(a.last))
        .slice(0, 6),
    [],
  );

  const steps = [t("invoice.steps.customer"), t("invoice.steps.products"), t("invoice.steps.review")];
  // A kept bill brought back: on to its products.
  useEffect(() => {
    if (kept.restoredAt) setStep(view.customer ? 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kept.restoredAt]);

  return (
    <div className="flex flex-col gap-4">
      {/* The bill's number under the title, so neither wraps on a narrow phone (360 px) beside Hold. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[21px] leading-tight font-semibold text-ink">{t("invoice.quick")}</h1>
          <p className={cn("truncate text-[12.5px] text-ink-3", /\d/.test(numberLabel) && "font-mono")}>{numberLabel}</p>
        </div>
        <HoldButton state={held} hasLines={draft.lines.length > 0} />
      </div>
      <KeptDraftOffer state={kept} />
      <HeldBillsBar state={held} />
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
          {/* Above the search, whose list of customers would cover it. */}
          <CashSaleButton
            large
            onPicked={(id) => {
              dispatch({ type: "customer", customerId: id });
              toProducts();
            }}
          />
          <CustomerPicker
            ref={customerRef}
            large
            onSelect={(id) => {
              dispatch({ type: "customer", customerId: id });
              toProducts();
            }}
            onAdd={canAddCustomer() ? setAdding : undefined}
          />
          <div hidden={recent.length === 0}>
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
                        {[c.city, c.route].filter(Boolean).join(" · ")}
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
        <div className="flex flex-col gap-3">
          <button type="button" onClick={() => setStep(0)} className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-2.5 text-left">
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-ink">{customer.businessName}</span>
              <span className={cn("num text-[12.5px]", insight.overdue > 0 ? "text-danger" : "text-ink-3")}>
                {t("invoice.customerCard.outstanding")} {money(insight.outstanding, 0)}
              </span>
            </span>
            <span className="text-[13px] font-medium text-accent">{t("invoice.changeCustomer")}</span>
          </button>
          <div data-overlay="top" className="sticky top-[calc(3.5rem+var(--inset-top))] z-20 -mx-4 bg-bg/85 px-4 py-2 backdrop-blur-md">
            <ProductSearch ref={productRef} large customer={customer} insight={insight} cartIds={draft.lines.map((l) => l.productId)} onAdd={(id, how) => dispatch({ type: "add", productId: id, ...how })} onScan={() => setScanOpen(true)} />
          </div>
          <SuggestionsPanel
            variant="mobile"
            hasCustomer
            customerName={customer.businessName}
            suggestions={view.suggestions}
            reorder={view.reorder}
            strip={strip}
            onStrip={(folded) => setSuggestionsOpen(!folded)}
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
              onRemove={removeLine}
              onReplace={(key, productId) => dispatch({ type: "replace", key, productId })}
              onBackToSearch={() => productRef.current?.focus()}
              schemes={view.schemes}
              onScheme={(schemeId, on) => dispatch({ type: "scheme", schemeId, on })}
            />
          </section>
          <div data-overlay="bottom" className="glass fixed inset-x-3 bottom-[calc(10px+var(--inset-bottom))] z-20 rounded-2xl border border-line/70 px-4 py-3 shadow-pop short:bottom-3">
            <div className="mx-auto flex max-w-xl items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-ink-3">{t("invoice.lineCount", { count: draft.lines.length, qty: totals ? totals.totalQty.toString() : "0" })}</p>
                <p className="num font-display text-[22px] leading-tight font-semibold text-ink"><CountUp value={totals?.grandTotal.toNumber() ?? 0} format={(v) => money(v)} duration={300} /></p>
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
              {view.billLines.map((l) => {
                const r = totals?.lines.find((x) => x.key === l.key);
                const p = PRODUCTS.find((x) => x.id === l.productId)!;
                return (
                  <li key={l.key} className="flex items-center justify-between gap-3 py-2.5 text-[14px]">
                    <span className="min-w-0 truncate text-ink">
                      {locale === "hi" ? p.nameHi : p.name} <span className="num text-ink-3">× {l.qty} {unitSymbolOf(p, l.unitId)}</span>
                    </span>
                    <span className={cn("num font-medium", l.free ? "text-good" : "text-ink")}>{l.free ? t("schemes.free") : r ? money(r.total.toNumber()) : ""}</span>
                  </li>
                );
              })}
            </ul>
          </section>
          <SummaryPanel view={view} invoiceNumber={numberLabel} onSave={saveFromReview} blocked={isBlocked(view)} busy={busy} />
          {/* Save without scrolling to the end: the total and Save stay at the bottom of the screen. */}
          <div data-overlay="bottom" className="glass fixed inset-x-3 bottom-[calc(10px+var(--inset-bottom))] z-20 rounded-2xl border border-line/70 px-4 py-3 shadow-pop short:bottom-3">
            <div className="mx-auto flex max-w-xl items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] text-ink-3">{t("invoice.grandTotal")}</p>
                <p className="num font-display text-[22px] leading-tight font-semibold text-ink">{money(totals?.grandTotal.toNumber() ?? 0)}</p>
              </div>
              <Button variant="primary" size="lg" icon={saveIcon(busy, 18)} disabled={!totals || isBlocked(view)} aria-busy={busy || undefined} onClick={() => saveFromReview("save")}>
                {t("invoice.save")}
              </Button>
            </div>
          </div>
          <div className="h-24" aria-hidden />
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
      <InvoiceSavedDialog notice={saved} onClose={closeSaved} onNext={() => customerRef.current?.focus()} />
    </div>
  );
}

/** Customers can be added while billing by anyone allowed to add them (offline too: sent before the bill). */
const canAddCustomer = () => LIVE && allowed("customer.create");

export function CreateInvoicePage({ customerId }: { customerId?: string }) {
  const view = useInvoiceDraft(customerId ?? null);
  const kept = useKeptDraft(view, customerId ?? null);
  // The full screen (with its keyboard shortcuts) from tablet width up; the step-by-step one on phones.
  const desktop = useMediaQuery("(min-width: 768px)");
  return desktop ? <DesktopInvoice view={view} kept={kept} /> : <MobileInvoice view={view} kept={kept} />;
}
