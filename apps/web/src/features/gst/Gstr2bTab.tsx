import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, Info, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { useRouter } from "../../app/router";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, Tile, type Column } from "../../components/ui/Page";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { downloadCsv } from "../../lib/download";

type Status = "matched" | "mismatch" | "not_in_books" | "not_in_2b";
interface Heads {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}
interface Row {
  status: Status;
  supplierGstin: string;
  supplierName: string | null;
  number: string;
  date: string;
  portal: (Heads & { value: number; itcAvailable: boolean; reverseCharge: boolean }) | null;
  books: (Heads & { id: string; value: number; date: string; number: string }) | null;
  taxDifference: number;
  dateDiffers: boolean;
}
interface Result {
  period: string;
  gstin: string | null;
  otherGstin: boolean;
  notes: number;
  summary: { matched: number; mismatch: number; notInBooks: number; notIn2b: number; itc2b: number; itcBooks: number; itcAtRisk: number; itcNotEntered: number };
  rows: Row[];
  suppliers: Record<string, string>;
  fileName: string;
}

const KEY = ["gst", "gstr2b"];
const taxOf = (h: Heads | null) => (h ? h.igst + h.cgst + h.sgst + h.cess : 0);
const TONE: Record<Status, "good" | "warn" | "danger" | "accent"> = { matched: "good", mismatch: "warn", not_in_books: "accent", not_in_2b: "danger" };

/**
 * GSTR-2B matching: the statement downloaded from the GST portal, read
 * against the purchase bills entered. What matches, what differs, the
 * portal's bills not entered, and the bills the portal does not show, whose
 * credit is at risk until the supplier reports them.
 */
export function Gstr2bTab({ period }: { period: string }) {
  const { t, money, dateMedium, locale } = useI18n();
  const { navigate } = useRouter();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [show, setShow] = useState<Status | "all">("all");
  const [readError, setReadError] = useState<string | null>(null);
  // Kept while moving between the GST tabs.
  const result = useQuery<Result>({ queryKey: KEY, queryFn: () => Promise.reject(new Error("not loaded")), enabled: false, staleTime: Infinity, gcTime: 30 * 60_000 }).data;
  const match = useMutation({
    mutationFn: async (file: File) => {
      let body: unknown;
      try {
        body = JSON.parse(await file.text());
      } catch {
        throw new ApiError(400, "GSTR2B_NOT_JSON");
      }
      const res = await api.post<Omit<Result, "fileName">>("/gst/gstr2b/match", body, { query: { period } });
      return { ...res, fileName: file.name };
    },
    onMutate: () => setReadError(null),
    onSuccess: (r) => {
      qc.setQueryData(KEY, r);
      setShow(r.summary.mismatch + r.summary.notInBooks + r.summary.notIn2b > 0 ? "all" : "matched");
    },
  });
  const pick = (files: FileList | null) => {
    const f = files?.[0];
    if (input.current) input.current.value = "";
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) return setReadError(t("gstr2b.tooBig"));
    match.mutate(f);
  };
  const rows = (result?.rows ?? []).filter((r) => show === "all" || r.status === show);
  const s = result?.summary;
  const label = (r: Row) => t(`gstr2b.status.${r.status}`);

  const columns: Column<Row>[] = [
    {
      key: "supplier",
      header: t("gstr2b.supplier"),
      sortValue: (r) => r.supplierName ?? r.supplierGstin,
      render: (r) => (
        <span>
          <span className="block text-ink">{r.supplierName ?? "—"}</span>
          <span className="font-mono text-[12px] text-ink-3">{r.supplierGstin}</span>
        </span>
      ),
    },
    {
      key: "bill",
      header: t("gstr2b.bill"),
      sortValue: (r) => r.date,
      render: (r) => (
        <span>
          <span className="block font-medium text-ink">{r.number}</span>
          <span className="text-[12px] text-ink-3">
            {dateMedium(r.date)}
            {r.dateDiffers && r.books && <span className="text-warn"> · {t("gstr2b.booksDate", { date: dateMedium(r.books.date) })}</span>}
          </span>
        </span>
      ),
    },
    { key: "taxable", header: t("gstr2b.taxable"), align: "right", sortValue: (r) => (r.portal ?? r.books)?.taxable ?? 0, render: (r) => money((r.portal ?? r.books)?.taxable ?? 0) },
    { key: "portal", header: t("gstr2b.gstPortal"), align: "right", sortValue: (r) => taxOf(r.portal), render: (r) => (r.portal ? money(taxOf(r.portal)) : "—") },
    { key: "books", header: t("gstr2b.gstBooks"), align: "right", sortValue: (r) => taxOf(r.books), render: (r) => (r.books ? money(taxOf(r.books)) : "—") },
    {
      key: "status",
      header: t("common.status"),
      sortValue: (r) => r.status,
      render: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <Badge tone={TONE[r.status]}>{label(r)}</Badge>
          {r.status === "mismatch" && <span className="num text-[12px] text-warn">{t("gstr2b.differsBy", { amount: money(r.taxDifference) })}</span>}
          {r.portal && !r.portal.itcAvailable && <span className="text-[12px] text-danger">{t("gstr2b.noItc")}</span>}
        </span>
      ),
    },
    {
      key: "act",
      header: "",
      align: "right",
      render: (r) =>
        r.books ? (
          <Button size="sm" variant="ghost" onClick={() => navigate({ name: "purchase-view", purchaseId: r.books!.id })}>
            {t("gstr2b.openBill")}
          </Button>
        ) : allowed("purchase.create") ? (
          <Button size="sm" onClick={() => navigate(result?.suppliers[r.supplierGstin] ? { name: "purchase-new", supplierId: result.suppliers[r.supplierGstin]! } : { name: "purchase-new" })}>
            {t("gstr2b.enterBill")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t("gstr2b.title")}
          subtitle={t("gstr2b.subtitle")}
          action={
            <Button variant={result ? "secondary" : "primary"} icon={<FileUp size={16} />} disabled={match.isPending} onClick={() => input.current?.click()}>
              {match.isPending ? t("gstr2b.reading") : result ? t("gstr2b.another") : t("gstr2b.choose")}
            </Button>
          }
        />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          <input ref={input} type="file" accept=".json,application/json" className="hidden" aria-label={t("gstr2b.choose")} onChange={(e) => pick(e.target.files)} data-gstr2b-file />
          <p className="flex items-start gap-2 text-[13px] text-ink-3">
            <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
            {t("gstr2b.how")}
          </p>
          {readError && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger" role="alert">
              {readError}
            </p>
          )}
          <ErrorNote error={match.error} />
          {result && (
            <p className="text-[13px] text-ink-2" data-gstr2b-for>
              {t("gstr2b.readFile", { file: result.fileName, month: monthName(result.period) })}
            </p>
          )}
          {result?.otherGstin && (
            <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" role="alert">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
              {t("gstr2b.otherGstin", { gstin: result.gstin ?? "" })}
            </p>
          )}
        </div>
      </Card>

      {result && s ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label={t("gstr2b.itc2b")} value={money(s.itc2b)} sub={t("gstr2b.itc2bHint")} />
            <Tile label={t("gstr2b.itcBooks")} value={money(s.itcBooks)} sub={t("gstr2b.itcBooksHint")} />
            <Tile label={t("gstr2b.atRisk")} value={money(s.itcAtRisk)} sub={t("gstr2b.atRiskHint", { count: s.notIn2b })} tone={s.itcAtRisk > 0 ? "danger" : "good"} />
            <Tile label={t("gstr2b.notEntered")} value={money(s.itcNotEntered)} sub={t("gstr2b.notEnteredHint", { count: s.notInBooks })} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label={t("common.status")}
              value={show}
              onChange={setShow}
              options={[
                { value: "all", label: `${t("common.all")} ${result.rows.length}` },
                { value: "mismatch", label: `${t("gstr2b.status.mismatch")} ${s.mismatch}` },
                { value: "not_in_books", label: `${t("gstr2b.status.not_in_books")} ${s.notInBooks}` },
                { value: "not_in_2b", label: `${t("gstr2b.status.not_in_2b")} ${s.notIn2b}` },
                { value: "matched", label: `${t("gstr2b.status.matched")} ${s.matched}` },
              ]}
            />
            <Button
              size="sm"
              icon={<Download size={15} />}
              onClick={() =>
                downloadCsv(
                  `GSTR-2B_match_${result.period}.csv`,
                  [
                    { label: t("common.status"), value: label },
                    { label: t("gstr2b.supplier"), value: (r) => r.supplierName ?? "" },
                    { label: "GSTIN", value: (r) => r.supplierGstin },
                    { label: t("gstr2b.bill"), value: (r) => r.number },
                    { label: t("common.date"), value: (r) => r.date },
                    { label: t("gstr2b.taxable"), value: (r) => ((r.portal ?? r.books)?.taxable ?? 0).toFixed(2) },
                    { label: t("gstr2b.gstPortal"), value: (r) => (r.portal ? taxOf(r.portal).toFixed(2) : "") },
                    { label: t("gstr2b.gstBooks"), value: (r) => (r.books ? taxOf(r.books).toFixed(2) : "") },
                    { label: t("gstr2b.difference"), value: (r) => r.taxDifference.toFixed(2) },
                  ],
                  result.rows,
                )
              }
            >
              {t("gstPage.downloadCsv")}
            </Button>
          </div>
          {show !== "all" && <p className="text-[13px] text-ink-3">{t(`gstr2b.what.${show}`)}</p>}
          <DataTable
            id="gstr2b"
            columns={columns}
            rows={rows}
            rowKey={(r) => `${r.status}:${r.supplierGstin}:${r.number}:${r.books?.id ?? ""}`}
            minWidth={900}
            empty={<EmptyState title={t("gstr2b.noneHere")} hint={t("gstr2b.noneHereHint")} />}
          />
          {result.notes > 0 && <p className="text-[12.5px] text-ink-3">{t("gstr2b.notes", { count: result.notes })}</p>}
        </>
      ) : (
        !match.isPending && <EmptyState icon={<FileUp size={24} />} title={t("gstr2b.empty")} hint={t("gstr2b.emptyHint")} />
      )}
    </div>
  );

  function monthName(p: string) {
    const [y, m] = p.split("-").map(Number) as [number, number];
    return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
  }
}
