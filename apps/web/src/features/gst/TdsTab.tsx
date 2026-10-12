import { useQuery, useQueryClient } from "@tanstack/react-query";
import { taxQuarterOf, tdsLabel } from "@digitalbahi/core";
import { Download, Landmark, Trash2 } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button, IconButton } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Field";
import { EmptyState } from "../../components/ui/misc";
import { DataTable, ErrorNote, Tile, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { downloadCsv } from "../../lib/download";

interface Deducted {
  month: string;
  dueDate: string;
  total: string;
  paid: string;
  pending: string;
  overdue: boolean;
  data: Array<{
    purchaseId: string;
    purchaseNumber: string | null;
    supplierInvoiceNumber: string;
    date: string;
    supplierId: string;
    partyName: string;
    pan: string | null;
    billValue: string;
    base: string;
    rate: string | null;
    tds: string;
    challan: { id: string; bsrCode: string; challanSerial: string; depositDate: string } | null;
  }>;
}

interface Challan {
  id: string;
  periodMonth: string;
  depositDate: string;
  bsrCode: string;
  challanSerial: string;
  taxAmount: string;
  interest: string;
  lateFee: string;
  bills: number;
}

interface Received {
  total: string;
  quarters: Array<{ quarter: string; tds: string; receipts: number; withCertificate: number }>;
  data: Array<{ paymentId: string; paymentNumber: string | null; date: string; customerId: string; partyName: string; pan: string | null; amount: string; tds: string; section: string | null; certificate: string | null }>;
}

const MONEY = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * Income tax deducted at source: what the business kept back on the month's
 * purchase bills (to pay the government by the 7th of the next month, with
 * the challan recorded here), and what customers deducted on their payments
 * in the quarter, with their certificates, to match against Form 26AS.
 */
export function TdsTab({ period }: { period: string }) {
  return (
    <div className="flex flex-col gap-5">
      <KeptBack month={period} />
      <DeductedByCustomers month={period} />
    </div>
  );
}

function KeptBack({ month }: { month: string }) {
  const { t, money, number, dateMedium } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const valid = /^\d{4}-\d{2}$/.test(month);
  const q = useQuery({ queryKey: ["tds", "deducted", month], queryFn: () => api.get<Deducted>("/tds/deducted", { month }), enabled: valid, placeholderData: (prev) => prev });
  const challans = useQuery({ queryKey: ["tds", "challans", month], queryFn: () => api.get<{ data: Challan[] }>("/tds/challans", { month }), enabled: valid });
  const [recording, setRecording] = useState(false);
  const [form, setForm] = useState({ date: TODAY, bsr: "", serial: "", interest: "", lateFee: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const fieldError = useFieldError(error);
  const d = q.data;
  const canFile = allowed("gst.file");

  const problems = {
    depositDate: !form.date ? t("validation.required") : form.date > TODAY ? t("errors.FUTURE_DATE_NOT_ALLOWED") : null,
    bsrCode: /^\d{7}$/.test(form.bsr) ? null : t("tds.challan.bsrHint"),
    challanSerial: /^\d{5}$/.test(form.serial) ? null : t("tds.challan.serialHint"),
    interest: form.interest && !MONEY.test(form.interest) ? t("validation.amount") : null,
    lateFee: form.lateFee && !MONEY.test(form.lateFee) ? t("validation.amount") : null,
  };
  const show = (k: keyof typeof problems) => (touched ? problems[k] : null) ?? fieldError(k);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tds"] });
  };
  const save = async () => {
    setTouched(true);
    if (Object.values(problems).some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/tds/challans", {
        periodMonth: month,
        depositDate: form.date,
        bsrCode: form.bsr,
        challanSerial: form.serial,
        ...(form.interest ? { interest: form.interest } : {}),
        ...(form.lateFee ? { lateFee: form.lateFee } : {}),
      });
      toast({ tone: "success", title: t("tds.challan.saved"), body: `${form.bsr}/${form.serial}` });
      setRecording(false);
      setTouched(false);
      setForm({ date: TODAY, bsr: "", serial: "", interest: "", lateFee: "" });
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c: Challan) => {
    try {
      await api.delete(`/tds/challans/${c.id}`);
      toast({ tone: "success", title: t("tds.challan.removed"), body: `${c.bsrCode}/${c.challanSerial}` });
      refresh();
    } catch (e) {
      toast({ tone: "danger", title: e instanceof ApiError && e.code ? t("tds.challan.notRemoved") : t("errors.generic") });
    }
  };

  const pending = d ? Number(d.pending) : 0;
  return (
    <Card data-tds-kept>
      <CardHeader
        title={t("tds.deducted.title")}
        subtitle={d ? t("tds.deducted.subtitle", { due: dateMedium(d.dueDate) }) : undefined}
        action={
          d && d.data.length > 0 && allowed("gst.export") ? (
            <Button
              size="sm"
              icon={<Download size={14} />}
              onClick={() =>
                downloadCsv(
                  `tds-deducted-${month}.csv`,
                  [
                    { label: "Bill date", value: (r) => r.date },
                    { label: "Supplier", value: (r) => r.partyName },
                    { label: "PAN", value: (r) => r.pan },
                    { label: "Supplier bill", value: (r) => r.supplierInvoiceNumber },
                    { label: "Section", value: () => "393(1) [194Q]" },
                    { label: "Amount credited", value: (r) => r.base },
                    { label: "Rate %", value: (r) => r.rate },
                    { label: "TDS", value: (r) => r.tds },
                    { label: "BSR code", value: (r) => r.challan?.bsrCode },
                    { label: "Challan no.", value: (r) => r.challan?.challanSerial },
                    { label: "Paid on", value: (r) => r.challan?.depositDate },
                  ],
                  d.data,
                )
              }
            >
              {t("tds.deducted.export")}
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label={t("tds.deducted.total")} value={money(d?.total ?? "0")} />
          <Tile label={t("tds.deducted.paid")} value={money(d?.paid ?? "0")} />
          <Tile
            label={t("tds.deducted.pending")}
            value={money(d?.pending ?? "0")}
            tone={d?.overdue ? "danger" : undefined}
            sub={d && pending > 0 ? (d.overdue ? t("tds.deducted.overdue", { date: dateMedium(d.dueDate) }) : t("tds.deducted.by", { date: dateMedium(d.dueDate) })) : undefined}
          />
        </div>
        <DataTable
          rows={d?.data ?? []}
          loading={q.isPending}
          rowKey={(r) => r.purchaseId}
          minWidth={820}
          empty={<EmptyState title={t("tds.deducted.empty")} hint={t("tds.deducted.emptyHint")} />}
          columns={[
            { key: "date", header: t("purchase.billDate"), render: (r) => dateMedium(r.date) },
            {
              key: "supplier",
              header: t("nav.suppliers"),
              render: (r) => (
                <span>
                  <span className="font-medium text-ink">{r.partyName}</span>
                  <span className="block text-[12px] text-ink-3">{r.pan ?? t("tds.noPan")}</span>
                </span>
              ),
            },
            { key: "bill", header: t("purchase.billNumber"), render: (r) => r.supplierInvoiceNumber },
            { key: "base", header: t("tds.deducted.base"), align: "right", render: (r) => money(r.base) },
            { key: "rate", header: t("tds.deducted.rate"), align: "right", render: (r) => `${number(Number(r.rate ?? 0))}%` },
            { key: "tds", header: "TDS", align: "right", render: (r) => <span className="font-semibold text-ink">{money(r.tds)}</span> },
            {
              key: "challan",
              header: t("tds.challan.one"),
              render: (r) => (r.challan ? <span className="font-mono text-[12.5px]">{`${r.challan.bsrCode}/${r.challan.challanSerial}`}</span> : <Badge tone="warn">{t("tds.deducted.notPaid")}</Badge>),
            },
          ]}
        />
        {canFile && pending > 0 && !recording && (
          <div>
            <Button variant="primary" icon={<Landmark size={16} />} onClick={() => setRecording(true)}>
              {t("tds.challan.record")}
            </Button>
          </div>
        )}
        {recording && (
          <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface-2/60 p-3 sm:p-4" data-tds-challan>
            <p className="text-[13px] text-ink-2">{t("tds.challan.hint", { amount: money(pending) })}</p>
            {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Field label={t("tds.challan.date")} htmlFor="tds-date" error={show("depositDate")}>
                <Input id="tds-date" type="date" max={TODAY} value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
              </Field>
              <Field label={t("tds.challan.bsr")} htmlFor="tds-bsr" error={show("bsrCode")}>
                <Input id="tds-bsr" inputMode="numeric" maxLength={7} value={form.bsr} onChange={(e) => setForm((f) => ({ ...f, bsr: e.target.value.replace(/\D/g, "") }))} />
              </Field>
              <Field label={t("tds.challan.serial")} htmlFor="tds-serial" error={show("challanSerial")}>
                <Input id="tds-serial" inputMode="numeric" maxLength={5} value={form.serial} onChange={(e) => setForm((f) => ({ ...f, serial: e.target.value.replace(/\D/g, "") }))} />
              </Field>
              <Field label={t("tds.challan.interest")} htmlFor="tds-interest" hint={t("common.optional")} error={show("interest")}>
                <Input id="tds-interest" inputMode="decimal" value={form.interest} onChange={(e) => setForm((f) => ({ ...f, interest: e.target.value.trim() }))} />
              </Field>
              <Field label={t("tds.challan.lateFee")} htmlFor="tds-fee" hint={t("common.optional")} error={show("lateFee")}>
                <Input id="tds-fee" inputMode="decimal" value={form.lateFee} onChange={(e) => setForm((f) => ({ ...f, lateFee: e.target.value.trim() }))} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? t("common.saving") : t("tds.challan.save")}
              </Button>
              <Button onClick={() => (setRecording(false), setError(null), setTouched(false))}>{t("common.cancel")}</Button>
            </div>
          </div>
        )}
        {(challans.data?.data.length ?? 0) > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("tds.challan.list")}</h3>
            <ul className="num divide-y divide-line rounded-xl border border-line text-[13.5px]">
              {challans.data!.data.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <span>
                    <span className="font-mono font-medium text-ink">{`${c.bsrCode}/${c.challanSerial}`}</span>
                    <span className="text-ink-3">
                      {" · "}
                      {dateMedium(c.depositDate)} · {t("tds.challan.bills", { count: c.bills })}
                      {Number(c.interest) > 0 ? ` · ${t("tds.challan.interest")} ${money(c.interest)}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-semibold text-ink">{money(c.taxAmount)}</span>
                    {canFile && (
                      <IconButton label={t("tds.challan.remove")} onClick={() => void remove(c)}>
                        <Trash2 size={16} />
                      </IconButton>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function DeductedByCustomers({ month }: { month: string }) {
  const { t, money, dateMedium } = useI18n();
  const valid = /^\d{4}-\d{2}$/.test(month);
  const quarter = taxQuarterOf(`${valid ? month : TODAY.slice(0, 7)}-01`);
  const q = useQuery({
    queryKey: ["tds", "received", quarter.from, quarter.to],
    queryFn: () => api.get<Received>("/tds/received", { from: quarter.from, to: quarter.to }),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const label = `${t("tds.received.quarter", { quarter: quarter.quarter, year: quarter.year })}`;
  return (
    <Card data-tds-received>
      <CardHeader
        title={t("tds.received.title")}
        subtitle={`${label} · ${t("tds.received.hint")}`}
        action={
          d && d.data.length > 0 && allowed("gst.export") ? (
            <Button
              size="sm"
              icon={<Download size={14} />}
              onClick={() =>
                downloadCsv(
                  `tds-by-customers-${quarter.year}-Q${quarter.quarter}.csv`,
                  [
                    { label: "Date", value: (r) => r.date },
                    { label: "Customer", value: (r) => r.partyName },
                    { label: "PAN", value: (r) => r.pan },
                    { label: "Receipt", value: (r) => r.paymentNumber },
                    { label: "Received", value: (r) => r.amount },
                    { label: "TDS", value: (r) => r.tds },
                    { label: "Section", value: (r) => tdsLabel(r.section) },
                    { label: "Certificate", value: (r) => r.certificate },
                  ],
                  d.data,
                )
              }
            >
              {t("tds.received.export")}
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Tile label={t("tds.received.total")} value={money(d?.total ?? "0")} />
          <Tile
            label={t("tds.received.certificates")}
            value={d ? `${d.data.filter((r) => r.certificate).length} / ${d.data.length}` : "—"}
          />
        </div>
        <DataTable
          rows={d?.data ?? []}
          loading={q.isPending}
          rowKey={(r) => r.paymentId}
          minWidth={820}
          empty={<EmptyState title={t("tds.received.empty")} hint={t("tds.received.emptyHint")} />}
          columns={[
            { key: "date", header: t("common.date"), render: (r) => dateMedium(r.date) },
            {
              key: "customer",
              header: t("nav.customers"),
              render: (r) => (
                <span>
                  <span className="font-medium text-ink">{r.partyName}</span>
                  <span className="block text-[12px] text-ink-3">{r.pan ?? t("tds.noPan")}</span>
                </span>
              ),
            },
            { key: "receipt", header: t("payment.receipt"), render: (r) => r.paymentNumber ?? "—" },
            { key: "amount", header: t("tds.received.amount"), align: "right", render: (r) => money(r.amount) },
            { key: "tds", header: "TDS", align: "right", render: (r) => <span className="font-semibold text-ink">{money(r.tds)}</span> },
            { key: "section", header: t("tds.section"), render: (r) => tdsLabel(r.section) },
            { key: "certificate", header: t("tds.receipt.certificate"), render: (r) => <CertificateCell row={r} /> },
          ]}
        />
      </div>
    </Card>
  );
}

/** The customer's TDS certificate number on a receipt: shown, or typed in once it comes. */
function CertificateCell({ row }: { row: Received["data"][number] }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.certificate ?? "");
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        {row.certificate ? <span className="font-mono text-[12.5px]">{row.certificate}</span> : <Badge tone="warn">{t("tds.received.missing")}</Badge>}
        {allowed("payment.collect") && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {row.certificate ? t("common.edit") : t("tds.received.add")}
          </Button>
        )}
      </span>
    );
  }
  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/payments/${row.paymentId}/tds-certificate`, { certificate: value.trim() });
      toast({ tone: "success", title: t("tds.received.saved"), body: row.paymentNumber ?? "" });
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["tds", "received"] });
    } catch {
      toast({ tone: "danger", title: t("errors.generic") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex items-center gap-2">
      <Input inputSize="sm" aria-label={`${t("tds.receipt.certificate")} ${row.paymentNumber ?? ""}`} className="w-36" maxLength={40} autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
        {t("common.save")}
      </Button>
    </span>
  );
}
