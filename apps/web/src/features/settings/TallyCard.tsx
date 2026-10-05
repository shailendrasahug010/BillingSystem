import { decodeTallyFile, parseTallyMasters, type TallyRow } from "@digitalbahi/core";
import { translateError } from "@digitalbahi/i18n";
import { Download, FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY } from "../../data/db";
import { refreshCatalog, refreshCustomers, refreshSuppliers } from "../../data/live";
import { api, ApiError } from "../../lib/api";
import { downloadBlob } from "../../lib/download";

type Section = "customers" | "suppliers" | "products";
const SECTIONS: Section[] = ["customers", "suppliers", "products"];

interface RowError {
  row: number;
  column: string;
  code: string;
  params?: Record<string, string>;
}
interface SectionResult {
  total: number;
  created: number;
  errors: RowError[];
}
interface ImportResult {
  customers: SectionResult | null;
  suppliers: SectionResult | null;
  products: SectionResult | null;
  skipped: Record<Section, number>;
  imported: boolean;
}

interface Read {
  file: string;
  rows: Record<Section, TallyRow[]>;
  otherLedgers: number;
  company: string | null;
}

/**
 * Tally, both ways: masters (customers, suppliers, stock items with their
 * opening balances) from Tally's XML export, and the period's vouchers for
 * the CA's Tally as an XML file Tally imports.
 */
export function TallyCard() {
  const i18n = useI18n();
  const { t } = i18n;
  const canExport = allowed("gst.export");
  const canImport = allowed("customer.create") && allowed("supplier.create") && allowed("product.import");
  if (!canExport && !canImport) return null;
  return (
    <Card>
      <CardHeader title={t("tally.title")} subtitle={t("tally.hint")} />
      <div className="flex flex-col gap-6 p-4 sm:p-5">
        {canImport && <TallyImport />}
        {canExport && <TallyExport />}
      </div>
    </Card>
  );
}

function TallyImport() {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const send = (r: Read, dryRun: boolean) => api.post<ImportResult>("/tally/import", { ...r.rows, dryRun });

  const choose = async (file: File) => {
    setError(null);
    setChecked(null);
    setRead(null);
    setBusy(true);
    try {
      const masters = parseTallyMasters(decodeTallyFile(new Uint8Array(await file.arrayBuffer())));
      const r: Read = { file: file.name, rows: { customers: masters.customers, suppliers: masters.suppliers, products: masters.products }, otherLedgers: masters.otherLedgers, company: masters.company };
      setRead(r);
      if (SECTIONS.every((s) => r.rows[s].length === 0)) return;
      setChecked(await send(r, true));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(400, "TALLY_FILE_UNREADABLE"));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const importNow = async () => {
    if (!read) return;
    setBusy(true);
    setError(null);
    try {
      const res = await send(read, false);
      setChecked(res);
      if (res.imported) {
        await Promise.all([refreshCustomers(), refreshSuppliers(), refreshCatalog()]).catch(() => undefined);
        toast({
          tone: "success",
          title: t("tally.imported"),
          body: SECTIONS.map((s) => t(`tally.created.${s}`, { count: res[s]?.created ?? 0 })).join(" · "),
        });
        setRead(null);
        setChecked(null);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const problems = checked ? SECTIONS.flatMap((s) => (checked[s]?.errors ?? []).map((e) => ({ ...e, section: s }))) : [];
  const toAdd = checked ? SECTIONS.reduce((n, s) => n + (read?.rows[s].length ?? 0) - checked.skipped[s], 0) : 0;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="tally-import">
      <div>
        <h3 id="tally-import" className="text-[14px] font-semibold text-ink">
          {t("tally.importTitle")}
        </h3>
        <p className="text-[13px] text-ink-3">{t("tally.importHint")}</p>
      </div>
      <div>
        <input ref={input} type="file" accept=".xml,text/xml,application/xml" className="sr-only" id="tally-file" onChange={(e) => e.target.files?.[0] && void choose(e.target.files[0])} />
        <Button icon={<FileUp size={16} />} disabled={busy} onClick={() => input.current?.click()}>
          {read ? t("imports.otherFile") : t("tally.chooseFile")}
        </Button>
      </div>
      {busy && <p className="text-[13px] text-ink-3">{t("imports.checking")}</p>}
      {read && (
        <div className="rounded-xl border border-line bg-surface-2/50 p-3 text-[13px] text-ink-2" role="status">
          <p className="font-medium text-ink">
            {read.file}
            {read.company ? ` · ${read.company}` : ""}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {SECTIONS.map((s) => (
              <li key={s}>
                {t(`tally.found.${s}`, { count: read.rows[s].length })}
                {checked && checked.skipped[s] > 0 ? ` · ${t("tally.alreadyThere", { count: checked.skipped[s] })}` : ""}
              </li>
            ))}
            {read.otherLedgers > 0 && <li className="text-ink-3">{t("tally.otherLedgers", { count: read.otherLedgers })}</li>}
          </ul>
        </div>
      )}
      {problems.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] font-medium text-danger">{t("imports.fix", { count: problems.length })}</p>
          <ul className="max-h-56 overflow-y-auto rounded-xl border border-line text-[12.5px]">
            {problems.slice(0, 50).map((e, i) => (
              <li key={i} className="flex gap-3 border-b border-line/70 px-3 py-1.5 last:border-b-0">
                <span className="shrink-0 font-medium text-ink">
                  {t(`tally.section.${e.section}`)} {(read?.rows[e.section][e.row - 1]?.name as string | undefined) ?? `#${e.row}`}
                </span>
                <span className="text-ink-3">{e.column}</span>
                <span className="text-danger">{translateError(i18n, new ApiError(400, e.code, e.params ?? {}))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {checked && problems.length === 0 && toAdd > 0 && (
        <div>
          <Button variant="primary" disabled={busy} onClick={() => void importNow()}>
            {t("imports.importCount", { count: toAdd })}
          </Button>
        </div>
      )}
      {checked && problems.length === 0 && toAdd === 0 && <p className="text-[13px] text-ink-3">{t("tally.nothingNew")}</p>}
      <ErrorNote error={error} />
    </section>
  );
}

function TallyExport() {
  const { t } = useI18n();
  const toast = useToast();
  const [from, setFrom] = useState(`${TODAY.slice(0, 8)}01`);
  const [to, setTo] = useState(TODAY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await api.blob("/tally/export", { from, to });
      downloadBlob(`tally-vouchers-${from}-to-${to}.xml`, blob);
      toast({ tone: "success", title: t("tally.exported") });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="tally-export">
      <div>
        <h3 id="tally-export" className="text-[14px] font-semibold text-ink">
          {t("tally.exportTitle")}
        </h3>
        <p className="text-[13px] text-ink-3">{t("tally.exportHint")}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("common.from")} htmlFor="tally-from">
          <Input id="tally-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t("common.to")} htmlFor="tally-to">
          <Input id="tally-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button icon={<Download size={16} />} disabled={busy || !from || !to} onClick={() => void download()}>
          {t("tally.download")}
        </Button>
      </div>
      <ErrorNote error={error} />
    </section>
  );
}
