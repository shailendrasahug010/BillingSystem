import { Bluetooth, Printer, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useI18n } from "../../app/i18n";
import { isNative } from "../../platform/native";
import { chooseBluetoothPrinter, onPrinterChange, pairedPrinters, PrinterError, printerSettings, printReceipt, savePrinterSettings, thermalSupported, type PrinterChoice } from "../../lib/thermal/printer";
import { testReceipt } from "../../lib/thermal/receipts";
import type { ReceiptItem } from "../../lib/thermal/draw";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Segmented } from "../ui/misc";
import { useToast } from "../ui/Toast";
import { cn } from "../../lib/cn";

const snapshot = () => JSON.stringify(printerSettings());
const usePrinter = () => JSON.parse(useSyncExternalStore(onPrinterChange, snapshot, snapshot)) as ReturnType<typeof printerSettings>;

/** Tells the person what went wrong with the printer, in their language. */
function usePrintError() {
  const { t } = useI18n();
  const toast = useToast();
  return (e: unknown) => toast({ tone: "danger", title: t("thermal.failed"), body: t(`thermal.errors.${e instanceof PrinterError ? e.code : "write_failed"}`) });
}

/**
 * Prints a receipt on this device's thermal printer; the first time (or when
 * the printer is out of reach) it asks which printer first. Not shown where
 * the device cannot reach one.
 */
export function ThermalPrintButton({ receipt, size = "md" }: { receipt(): ReceiptItem[]; size?: "sm" | "md" }) {
  const { t } = useI18n();
  const toast = useToast();
  const failed = usePrintError();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!thermalSupported()) return null;
  const print = async () => {
    if (!printerSettings().printer) return setChoosing(true);
    setBusy(true);
    try {
      await printReceipt(receipt());
      toast({ tone: "success", title: t("thermal.printed"), body: printerSettings().printer?.name });
    } catch (e) {
      if (e instanceof PrinterError && e.code === "not_found") setChoosing(true);
      else failed(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size={size} icon={<Printer size={size === "sm" ? 15 : 16} />} disabled={busy} onClick={() => void print()}>
        {busy ? t("thermal.printing") : t("thermal.print")}
      </Button>
      <Dialog open={choosing} onOpenChange={setChoosing} title={t("thermal.chooseTitle")} description={t("thermal.hint")} closeLabel={t("common.close")}>
        <PrinterPanel
          onChosen={() => {
            setChoosing(false);
            void print();
          }}
        />
      </Dialog>
    </>
  );
}

/** The printer settings: paper width, which printer (paired in the app, or found over Bluetooth), a test page. */
export function PrinterPanel({ onChosen }: { onChosen?(p: PrinterChoice): void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const failed = usePrintError();
  const settings = usePrinter();
  const native = isNative();
  const [paired, setPaired] = useState<PrinterChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!native) return;
    void pairedPrinters()
      .then(setPaired)
      .catch(() => setPaired([]));
  }, [native]);

  if (!thermalSupported()) return <p className="text-[13px] text-ink-3">{t("thermal.unsupported")}</p>;
  const choose = (p: PrinterChoice) => {
    savePrinterSettings({ printer: p });
    onChosen?.(p);
  };
  const find = async () => {
    setBusy(true);
    try {
      const p = await chooseBluetoothPrinter();
      onChosen?.(p);
    } catch (e) {
      if (!(e instanceof PrinterError && e.code === "cancelled")) failed(e);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      await printReceipt(testReceipt(locale, settings.paper));
      toast({ tone: "success", title: t("thermal.printed"), body: settings.printer?.name });
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13.5px] font-medium text-ink-2">{t("thermal.paper")}</span>
        <Segmented
          size="sm"
          label={t("thermal.paper")}
          value={String(settings.paper) as "58" | "80"}
          onChange={(v) => savePrinterSettings({ paper: v === "80" ? 80 : 58 })}
          options={[
            { value: "58", label: "58 mm" },
            { value: "80", label: "80 mm" },
          ]}
        />
      </div>
      <div className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-[14px] text-ink">
          <Printer size={16} className="shrink-0 text-ink-3" />
          <span className="truncate">{settings.printer?.name ?? <span className="text-ink-3">{t("thermal.none")}</span>}</span>
        </span>
        {settings.printer && (
          <button type="button" className="press inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-danger" onClick={() => savePrinterSettings({ printer: null })}>
            <Trash2 size={13} />
            {t("thermal.forget")}
          </button>
        )}
      </div>
      {native ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-ink-2">{t("thermal.paired")}</p>
          {paired === null ? null : paired.length === 0 ? (
            <p className="text-[13px] text-ink-3">{t("thermal.noPaired")}</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {paired.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => choose(p)} className={cn("press flex w-full items-center justify-between px-3 py-2.5 text-left text-[14px]", settings.printer?.id === p.id ? "bg-accent-soft text-accent-ink" : "text-ink")}>
                    <span className="truncate">{p.name}</span>
                    <span className="font-mono text-[11.5px] text-ink-3">{p.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12.5px] text-ink-3">{t("thermal.pairHint")}</p>
        </div>
      ) : (
        <Button icon={<Bluetooth size={16} />} disabled={busy} onClick={() => void find()}>
          {t("thermal.find")}
        </Button>
      )}
      {settings.printer && (
        <Button variant="soft" icon={<Printer size={16} />} disabled={busy} onClick={() => void test()}>
          {t("thermal.test")}
        </Button>
      )}
    </div>
  );
}
