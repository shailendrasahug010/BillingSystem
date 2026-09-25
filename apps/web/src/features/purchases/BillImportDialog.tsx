import { readBillFile, type BillFile } from "@vyapaar/core";
import { FileDown, FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorNote } from "../../components/ui/Page";
import { api, ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { downloadText } from "../../lib/download";
import { readSheetFile, SHEET_ACCEPT, SheetError } from "../../lib/sheet";
import { draftFromMatch, SAMPLE_BILL, type MatchResponse } from "./billImport";

const MAX_LINES = 300;

/**
 * Bring in a supplier's bill from the file they sent (Excel or CSV): the
 * sheet is read on this device, its items are matched to our products (and
 * to what this supplier's items were matched to before), and the bill opens
 * in purchase entry to be checked and saved. Nothing is saved here.
 */
export function BillImportDialog({ open, onOpenChange, supplierId }: { open: boolean; onOpenChange(v: boolean): void; supplierId?: string }) {
  const { t, dateMedium, number } = useI18n();
  const { navigate } = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: BillFile } | null>(null);
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setPick(0);
    setError(null);
  }, [open]);

  const choose = async (f: File) => {
    setError(null);
    setFile(null);
    setPick(0);
    try {
      const data = readBillFile(await readSheetFile(f));
      setFile({ name: f.name, data });
    } catch (e) {
      setError(new ApiError(400, e instanceof SheetError ? e.code : "IMPORT_UNREADABLE"));
    }
  };

  const bill = file?.data.bills[pick];
  const tooLong = bill ? bill.lines.length > MAX_LINES : false;

  const proceed = async () => {
    if (!file || !bill || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const match = await api.post<MatchResponse>("/purchases/import/match", {
        ...(supplierId ? { supplierId } : {}),
        ...(bill.supplierGstin ? { supplierGstin: bill.supplierGstin.slice(0, 20) } : {}),
        ...(bill.supplierName ? { supplierName: bill.supplierName.slice(0, 200) } : {}),
        ...(bill.billNumber ? { billNumber: bill.billNumber.slice(0, 30) } : {}),
        lines: bill.lines.map((l) => ({
          itemName: l.itemName.slice(0, 200),
          ...(l.itemCode ? { itemCode: l.itemCode.slice(0, 60) } : {}),
          ...(l.barcode ? { barcode: l.barcode.slice(0, 64) } : {}),
        })),
      });
      onOpenChange(false);
      navigate({ name: "purchase-new", draft: draftFromMatch(file.name, bill, match) });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const sample = () => {
    const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    downloadText("supplier-bill-sample.csv", `﻿${SAMPLE_BILL.map((r) => r.map(quote).join(",")).join("\r\n")}\r\n`);
  };

  const data = file?.data;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("billImport.title")}
      description={t("billImport.hint")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !bill || tooLong} onClick={() => void proceed()}>
            {busy ? t("billImport.matching") : t("billImport.review")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="soft" icon={<FileUp size={16} />} onClick={() => input.current?.click()}>
            {file ? t("imports.otherFile") : t("billImport.chooseFile")}
          </Button>
          <Button icon={<FileDown size={16} />} onClick={sample}>
            {t("billImport.sample")}
          </Button>
          <input
            ref={input}
            type="file"
            accept={SHEET_ACCEPT}
            className="hidden"
            aria-label={t("billImport.chooseFile")}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void choose(f);
            }}
          />
        </div>
        <p className="text-[12.5px] text-ink-3">{t("billImport.columnsHelp")}</p>
        {error ? <ErrorNote error={error} /> : null}
        {data && (
          <div className="flex flex-col gap-3 rounded-lg border border-line p-3 text-[13.5px]">
            <p className="font-medium text-ink">{file.name}</p>
            {data.headerRow === 0 ? (
              <p className="text-danger" role="alert">
                {t("billImport.noHeader")}
              </p>
            ) : data.bills.length === 0 ? (
              <p className="text-danger" role="alert">
                {t("billImport.noItems")}
              </p>
            ) : (
              <>
                {data.bills.length > 1 && <p className="text-ink-2">{t("billImport.billsInFile", { count: data.bills.length })}</p>}
                <div role="radiogroup" aria-label={t("billImport.whichBill")} className="flex flex-col gap-2">
                  {data.bills.map((b, i) => (
                    <button
                      key={`${b.billNumber}-${i}`}
                      type="button"
                      role="radio"
                      aria-checked={pick === i}
                      onClick={() => setPick(i)}
                      className={cn(
                        "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left",
                        pick === i ? "border-accent bg-accent-soft/60" : "border-line hover:bg-surface-2",
                        data.bills.length === 1 && "pointer-events-none",
                      )}
                    >
                      <span className="font-medium text-ink">
                        {b.billNumber ? t("billImport.billLabel", { number: b.billNumber }) : t("billImport.noBillNumber")}
                        {b.billDate && <span className="font-normal text-ink-2"> · {dateMedium(b.billDate)}</span>}
                      </span>
                      <span className="text-[12.5px] text-ink-3">
                        {t("common.items", { count: b.lines.length })}
                        {(b.supplierName || b.supplierGstin) && ` · ${[b.supplierName, b.supplierGstin].filter(Boolean).join(" · ")}`}
                      </span>
                    </button>
                  ))}
                </div>
                {tooLong && (
                  <p className="text-danger" role="alert">
                    {t("billImport.tooManyLines", { count: bill!.lines.length, max: MAX_LINES })}
                  </p>
                )}
              </>
            )}
            {data.ignored.length > 0 && <p className="text-[12.5px] text-ink-3">{t("imports.ignored", { columns: data.ignored.join(", ") })}</p>}
            {data.problems.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[12.5px] font-medium text-warn">{t("billImport.problems", { count: data.problems.length })}</p>
                <ul className="max-h-40 overflow-y-auto text-[12.5px] text-ink-2">
                  {data.problems.slice(0, 50).map((p, i) => (
                    <li key={i}>{t("billImport.problem", { row: number(p.row, 0), column: data.headers[p.column] ?? p.column, value: p.value })}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
