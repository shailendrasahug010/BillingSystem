import { translateError } from "@digitalbahi/i18n";
import { CircleCheck, FileDown, FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { refreshCatalog, refreshCustomers } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { headerKey, sheetRecords } from "../../lib/csv";
import { downloadText } from "../../lib/download";
import { readSheetFile, SHEET_ACCEPT, SheetError } from "../../lib/sheet";
import { ReadingStatus, type Reading } from "./ReadingStatus";

type Kind = "products" | "customers";

interface ImportResult {
  total: number;
  created: number;
  errors: Array<{ row: number; column: string; code: string; params?: Record<string, string> }>;
  newBrands?: number;
  newCategories?: number;
  withOpeningStock?: number;
  newRoutes?: number;
  withOpeningBalance?: number;
}

const COLUMNS: Record<Kind, string[]> = {
  products: ["name", "name_hindi", "code", "barcode", "hsn", "gst", "unit", "case_unit", "case_size", "brand", "category", "pack_size", "mrp", "selling_price", "purchase_price", "prices_include_tax", "min_stock", "opening_stock"],
  customers: ["name", "contact_person", "mobile", "gstin", "state", "city", "address", "pincode", "credit_limit", "credit_days", "opening_balance", "price_level", "route", "email", "code"],
};

const SAMPLE: Record<Kind, string[][]> = {
  products: [
    ["Parle-G Biscuit 100 g", "पारले-जी बिस्किट 100 ग्राम", "", "8901719101045", "1905", "5", "PCS", "BOX", "24", "Parle", "Biscuits", "100 g", "10", "9.20", "8", "no", "48", "240"],
    ["Surf Excel 1 kg", "", "", "8901030865278", "3402", "18", "PCS", "CTN", "12", "HUL", "Detergent", "1 kg", "140", "128", "115", "no", "12", "36"],
  ],
  customers: [
    ["Sharma Kirana Store", "Ramesh Sharma", "9826012345", "", "23", "Indore", "12 MG Road", "452001", "20000", "7", "1500", "Price A", "Rajwada", "", ""],
    ["Bhopal Mart", "Anil Jain", "9893012345", "23AABCB9999C1ZX", "", "Bhopal", "", "", "50000", "15", "0", "Price B", "", "", ""],
  ],
};

/** Header words people actually use in their spreadsheets / other software exports. */
const ALIASES: Record<Kind, Record<string, string>> = {
  products: {
    product: "name",
    product_name: "name",
    item: "name",
    item_name: "name",
    hindi_name: "name_hindi",
    name_hi: "name_hindi",
    hsn_code: "hsn",
    hsn_sac: "hsn",
    gst_rate: "gst",
    tax: "gst",
    tax_rate: "gst",
    uom: "unit",
    company: "brand",
    sale_price: "selling_price",
    sales_price: "selling_price",
    rate: "selling_price",
    purchase_rate: "purchase_price",
    cost: "purchase_price",
    stock: "opening_stock",
    opening_qty: "opening_stock",
    qty: "opening_stock",
    min_qty: "min_stock",
    reorder_level: "min_stock",
    sku: "code",
    item_code: "code",
  },
  customers: {
    customer: "name",
    customer_name: "name",
    shop_name: "name",
    firm: "name",
    party: "name",
    party_name: "name",
    business_name: "name",
    contact: "contact_person",
    owner: "contact_person",
    phone: "mobile",
    mobile_no: "mobile",
    phone_no: "mobile",
    gst_no: "gstin",
    gst_number: "gstin",
    gst: "gstin",
    credit_period: "credit_days",
    balance: "opening_balance",
    outstanding: "opening_balance",
    beat: "route",
    rate_list: "price_level",
  },
};

/**
 * Bring an existing product list or customer list in from a spreadsheet
 * (saved as CSV). Everything is checked first and nothing is saved unless
 * every row is right, so the file can be fixed and uploaded again.
 */
export function ImportDialog({ kind, open, onOpenChange }: { kind: Kind; open: boolean; onOpenChange(v: boolean): void }) {
  const i18n = useI18n();
  const { t, number } = i18n;
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; rows: Array<Record<string, string>>; known: string[]; ignored: string[] } | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  // Only the file chosen last is shown (another may be picked while a photo is read).
  const choice = useRef(0);

  useEffect(() => {
    choice.current++;
    setReading(null);
    if (open) {
      setFile(null);
      setCheck(null);
      setError(null);
    }
  }, [open]);

  const path = kind === "products" ? "/products/import" : "/customers/import";
  const run = async (dryRun: boolean, rows: Array<Record<string, string>>) => api.post<ImportResult>(path, { dryRun, rows });

  const choose = async (f: File) => {
    const mine = ++choice.current;
    setError(null);
    setCheck(null);
    setReading({ page: 0, pages: 0 });
    let sheet: string[][];
    try {
      sheet = (
        await readSheetFile(f, {
          isHeader: (cells) => cells.some((c) => headerKey(c, ALIASES[kind]) === "name"),
          onProgress: (page, pages) => mine === choice.current && setReading({ page, pages }),
        })
      ).rows;
    } catch (e) {
      if (mine !== choice.current) return;
      setFile(null);
      setError(e instanceof ApiError ? e : new ApiError(400, e instanceof SheetError ? e.code : "IMPORT_UNREADABLE"));
      return;
    } finally {
      if (mine === choice.current) setReading(null);
    }
    if (mine !== choice.current) return;
    const { columns, records } = sheetRecords(sheet, ALIASES[kind]);
    const known = columns.filter((c) => COLUMNS[kind].includes(c));
    const ignored = columns.filter((c) => c && !COLUMNS[kind].includes(c));
    const rows = records.map((r) => Object.fromEntries(known.map((k) => [k, r[k] ?? ""])));
    setFile({ name: f.name, rows, known, ignored });
    if (!rows.length || !known.includes("name")) return;
    if (rows.length > 5000) {
      setError(new ApiError(400, "IMPORT_TOO_MANY"));
      return;
    }
    setBusy(true);
    try {
      setCheck(await run(true, rows));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await run(false, file.rows);
      if (res.errors.length) {
        setCheck(res);
        return;
      }
      await (kind === "products" ? refreshCatalog() : refreshCustomers()).catch(() => undefined);
      toast({ tone: "success", title: t("imports.done"), body: t(kind === "products" ? "imports.productsCreated" : "imports.customersCreated", { count: res.created }) });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const template = () => {
    const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    const lines = [COLUMNS[kind], ...SAMPLE[kind]].map((r) => r.map(quote).join(","));
    downloadText(`${kind}-template.csv`, `﻿${lines.join("\r\n")}\r\n`);
  };

  const ready = check && check.errors.length === 0;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={kind === "products" ? t("imports.products") : t("imports.customers")}
      description={t("imports.hint")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void commit()}>
            {busy ? t("common.saving") : ready ? t("imports.importCount", { count: check!.total }) : t("imports.import")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button icon={<FileDown size={16} />} onClick={template}>
            {t("imports.template")}
          </Button>
          <Button variant="soft" icon={<FileUp size={16} />} disabled={reading !== null} onClick={() => input.current?.click()}>
            {file ? t("imports.otherFile") : t("imports.chooseFile")}
          </Button>
          <input
            ref={input}
            type="file"
            accept={SHEET_ACCEPT}
            className="hidden"
            aria-label={t("imports.chooseFile")}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void choose(f);
            }}
          />
        </div>
        <p className="text-[12.5px] text-ink-3">{t("imports.columns", { columns: COLUMNS[kind].join(", ") })}</p>
        {reading && <ReadingStatus reading={reading} />}
        {error ? <ErrorNote error={error} /> : null}
        {file && (
          <div className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[13.5px]">
            <p className="font-medium text-ink">
              {file.name} · {t("imports.rows", { count: file.rows.length })}
            </p>
            {!file.known.includes("name") && <p className="text-danger">{t("imports.noNameColumn")}</p>}
            {file.ignored.length > 0 && <p className="text-[12.5px] text-warn">{t("imports.ignored", { columns: file.ignored.join(", ") })}</p>}
            {busy && !check && <p className="text-ink-3">{t("imports.checking")}</p>}
            {ready && (
              <p className="flex items-start gap-2 text-good">
                <CircleCheck size={16} className="mt-0.5 shrink-0" />
                <span>
                  {t("imports.ready", { count: check!.total })}
                  {kind === "products"
                    ? ` · ${t("imports.productExtras", { brands: check!.newBrands ?? 0, categories: check!.newCategories ?? 0, stocked: check!.withOpeningStock ?? 0 })}`
                    : ` · ${t("imports.customerExtras", { routes: check!.newRoutes ?? 0, balances: check!.withOpeningBalance ?? 0 })}`}
                </span>
              </p>
            )}
          </div>
        )}
        {check && check.errors.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[13.5px] font-medium text-danger">{t("imports.fix", { count: check.errors.length })}</p>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                    <th className="py-2 pl-3 font-medium">{t("imports.row")}</th>
                    <th className="py-2 pl-3 font-medium">{t("imports.column")}</th>
                    <th className="py-2 pr-3 pl-3 font-medium">{t("imports.problem")}</th>
                  </tr>
                </thead>
                <tbody>
                  {check.errors.slice(0, 200).map((e, i) => (
                    <tr key={i} className="border-b border-line last:border-b-0">
                      {/* +1: the header is row 1 in the spreadsheet. */}
                      <td className="num py-1.5 pl-3 text-ink-2">{number(e.row + 1, 0)}</td>
                      <td className="py-1.5 pl-3 font-mono text-[12px] text-ink-2">{e.column}</td>
                      <td className="py-1.5 pr-3 pl-3 text-ink">{translateError(i18n, new ApiError(400, e.code, e.params ?? {}))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
