import { isStatementHeader, readBankStatement, type StatementLine } from "@digitalbahi/core";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { allowed, customerById, supplierById } from "../../data/db";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { readSheetFile, SheetError } from "../../lib/sheet";
import { searchCustomers } from "../invoice/CustomerPicker";
import { searchSuppliers, supplierLabel } from "../suppliers/search";
import { invalidateMoney } from "./PaymentDialog";

type Status = "recorded" | "matched" | "likely" | "unmatched";

interface MatchLine {
  row: number;
  status: Status;
  partyId: string | null;
  partyName: string | null;
  reasons: string[];
}

interface Row {
  line: StatementLine;
  status: Status;
  reasons: string[];
  partyId: string | null;
  partyName: string | null;
  picked: boolean;
  /** Sent once: a retry after a lost answer records it only once. */
  key: string;
  saved?: boolean;
}

const ACCEPT = ".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TONE: Record<Status, Tone> = { recorded: "neutral", matched: "good", likely: "accent", unmatched: "warn" };

/**
 * Bank reconciliation: a statement from net banking (CSV, Excel or PDF) read
 * here, each line matched on the server to the customer who paid or the
 * supplier paid, and the ones ticked recorded as payments. Lines already in
 * the books are shown and left alone.
 */
export function BankStatementDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const i18n = useI18n();
  const { t, money, date } = i18n;
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canIn = allowed("payment.collect");
  const canOut = allowed("payment.pay");

  const reset = () => {
    setFile(null);
    setRows(null);
    setError(null);
  };

  const choose = async (f: File) => {
    reset();
    setBusy(true);
    try {
      const sheet = await readSheetFile(f, { isHeader: isStatementHeader });
      const read = readBankStatement(sheet.rows);
      if (!read || read.lines.length === 0) throw new ApiError(400, "BANK_STATEMENT_UNREADABLE");
      const lines = read.lines.slice(0, 2000);
      const res = await api.post<{ lines: MatchLine[] }>("/bank-statement/match", { lines });
      const byRow = new Map(res.lines.map((m) => [m.row, m]));
      setFile(f.name);
      setRows(
        lines.map((line) => {
          const m = byRow.get(line.row);
          const status = m?.status ?? "unmatched";
          return { line, status, reasons: m?.reasons ?? [], partyId: m?.partyId ?? null, partyName: m?.partyName ?? null, picked: status === "matched", key: newIdempotencyKey() };
        }),
      );
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(400, e instanceof SheetError ? e.code : "BANK_STATEMENT_UNREADABLE"));
    } finally {
      setBusy(false);
    }
  };

  const update = (row: number, patch: Partial<Row>) => setRows((rs) => rs?.map((r) => (r.line.row === row ? { ...r, ...patch } : r)) ?? null);
  const can = (r: Row) => (r.line.amount > 0 ? canIn : canOut);
  const toRecord = (rows ?? []).filter((r) => r.picked && r.partyId && !r.saved && r.status !== "recorded" && can(r));

  const record = async () => {
    setBusy(true);
    setError(null);
    let done = 0;
    try {
      for (const r of toRecord) {
        const inflow = r.line.amount > 0;
        await api.post(
          "/payments",
          {
            direction: inflow ? "in" : "out",
            ...(inflow ? { customerId: r.partyId } : { supplierId: r.partyId }),
            paymentDate: r.line.date,
            amount: Math.abs(r.line.amount).toFixed(2),
            method: /\bUPI\b/i.test(r.line.narration) ? "upi" : "bank_transfer",
            ...(r.line.reference ? { referenceNumber: r.line.reference.slice(0, 40) } : {}),
            notes: t("bank.note", { narration: r.line.narration }).slice(0, 500),
          },
          { idempotencyKey: r.key },
        );
        update(r.line.row, { saved: true, picked: false });
        done++;
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (done) {
        toast({ tone: "success", title: t("bank.recorded", { count: done }) });
        invalidateMoney(qc);
      }
    }
  };

  const counts = (rows ?? []).reduce<Record<Status, number>>((n, r) => ({ ...n, [r.status]: n[r.status] + 1 }), { recorded: 0, matched: 0, likely: 0, unmatched: 0 });
  const partyLabel = (r: Row) => {
    if (!r.partyId) return null;
    if (r.line.amount > 0) {
      const c = customerById.get(r.partyId);
      return c ? c.businessName || c.name : r.partyName;
    }
    const s = supplierById.get(r.partyId);
    return s ? supplierLabel(s) : r.partyName;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={t("bank.title")}
      description={t("bank.hint")}
      size="xl"
      closeLabel={t("common.close")}
      footer={
        rows ? (
          <Button variant="primary" disabled={busy || toRecord.length === 0} onClick={() => void record()}>
            {t("bank.record", { count: toRecord.length })}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            id="bank-file"
            type="file"
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void choose(f);
            }}
          />
          <Button icon={<FileUp size={16} />} disabled={busy} onClick={() => input.current?.click()}>
            {rows ? t("imports.otherFile") : t("bank.choose")}
          </Button>
          {busy && <span className="text-[13px] text-ink-3">{t("imports.checking")}</span>}
          {file && rows && (
            <span className="text-[13px] text-ink-3" role="status">
              {file} · {t("bank.summary", { count: rows.length, matched: counts.matched, likely: counts.likely, recorded: counts.recorded, unmatched: counts.unmatched })}
            </span>
          )}
        </div>
        <ErrorNote error={error} />
        {rows && (
          <ul className="flex max-h-[60vh] flex-col divide-y divide-line overflow-y-auto rounded-xl border border-line" aria-label={t("bank.lines")}>
            {rows.map((r) => {
              const inflow = r.line.amount > 0;
              const label = partyLabel(r);
              const editable = !r.saved && r.status !== "recorded" && can(r);
              return (
                <li key={r.line.row} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center" data-row={r.line.row}>
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    {editable ? (
                      <Checkbox
                        checked={r.picked && !!r.partyId}
                        disabled={!r.partyId}
                        onChange={(v) => update(r.line.row, { picked: v })}
                        label={<span className="sr-only">{t("bank.pick", { row: r.line.row })}</span>}
                      />
                    ) : (
                      <span className="w-4" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`num font-semibold ${inflow ? "text-success" : "text-ink"}`}>
                          {inflow ? "+" : "−"}
                          {money(Math.abs(r.line.amount))}
                        </span>
                        <span className="text-[12.5px] text-ink-3">{date(r.line.date)}</span>
                        <Badge tone={r.saved ? "good" : TONE[r.status]}>{r.saved ? t("bank.status.saved") : t(`bank.status.${r.status}`)}</Badge>
                      </div>
                      <p className="truncate text-[12.5px] text-ink-3" title={r.line.narration}>
                        {r.line.narration || r.line.reference}
                      </p>
                    </div>
                  </div>
                  <div className="sm:w-72">
                    {editable ? (
                      <SearchSelect
                        id={`bank-party-${r.line.row}`}
                        value={r.partyId}
                        onChange={(id) => update(r.line.row, { partyId: id, picked: !!id, status: id && r.status === "unmatched" ? "likely" : r.status })}
                        selectedLabel={label}
                        placeholder={inflow ? t("bank.whoPaid") : t("bank.paidTo")}
                        clearLabel={t("common.clear")}
                        emptyText={t("search.noResults")}
                        search={(q) =>
                          inflow
                            ? searchCustomers(q).map((c) => ({ id: c.id, label: c.businessName || c.name, sub: [c.code, c.city].filter(Boolean).join(" · ") }))
                            : searchSuppliers(q).map((s) => ({ id: s.id, label: supplierLabel(s), sub: [s.code, s.city].filter(Boolean).join(" · ") }))
                        }
                      />
                    ) : (
                      <span className="text-[13px] text-ink-2">{label}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
