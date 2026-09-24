import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PaymentMethod } from "@vyapaar/core";
import { Plus, Search } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, ProgressBar, Segmented, Skeleton } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, Stat, TAB_TRIGGER, type Column } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { usePaged } from "../../lib/usePaged";
import { ExportButton, PeriodBar, usePeriod } from "../reports/period";
import { ExpenseDialog, useCategoryLabel, useExpenseCategories } from "./ExpenseDialog";

interface ExpenseRow {
  id: string;
  expenseNumber: string;
  expenseDate: string;
  categoryId: string;
  categoryName: string;
  categoryNameHi: string | null;
  paidTo: string | null;
  amount: string;
  gst: string;
  totalAmount: string;
  paymentMethod: PaymentMethod;
  referenceNumber: string | null;
  status: "posted" | "cancelled";
}

interface ExpenseDetail extends Omit<ExpenseRow, "gst"> {
  vendorGstin: string | null;
  gstRate: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  itcEligibility: string | null;
  notes: string | null;
  cancelReason: string | null;
  accountName: string | null;
}

interface Totals {
  count: number;
  amount: string;
  gst: string;
  total: string;
}

export function ExpensesPage() {
  const { t } = useI18n();
  const [entering, setEntering] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("expenses.title")}
        subtitle={t("expenses.subtitle")}
        actions={
          allowed("expense.create") ? (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEntering(true)}>
              {t("expenses.new")}
            </Button>
          ) : undefined
        }
      />
      <Tabs.Root defaultValue="list" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("expenses.title")}>
          <Tabs.Trigger value="list" className={TAB_TRIGGER}>
            {t("expenses.title")}
          </Tabs.Trigger>
          <Tabs.Trigger value="summary" className={TAB_TRIGGER}>
            {t("expenses.summary")}
          </Tabs.Trigger>
          <Tabs.Trigger value="categories" className={TAB_TRIGGER}>
            {t("expenses.categories")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="list">
          <ExpenseList />
        </Tabs.Content>
        <Tabs.Content value="summary">
          <ExpenseSummary />
        </Tabs.Content>
        <Tabs.Content value="categories">
          <CategoryManager />
        </Tabs.Content>
      </Tabs.Root>
      <ExpenseDialog open={entering} onOpenChange={setEntering} />
    </div>
  );
}

function ExpenseList() {
  const { t, money, dateMedium } = useI18n();
  const label = useCategoryLabel();
  const categories = useExpenseCategories();
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState<"posted" | "cancelled" | "all">("posted");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const query = { status, categoryId: categoryId || undefined, from: from || undefined, to: to || undefined, q: q.trim().length >= 2 ? q.trim() : undefined };
  const list = usePaged<ExpenseRow>("expenses", "/expenses", query);
  // Totals for the whole filter come with the first page.
  const totals = useQuery({
    queryKey: ["expenses", "totals", query],
    queryFn: () => api.get<{ totals: Totals }>("/expenses", { ...query, limit: 1 }).then((r) => r.totals),
    placeholderData: (prev) => prev,
  });

  const columns: Column<ExpenseRow>[] = [
    { key: "date", header: t("common.date"), render: (x) => <span className="text-ink-2">{dateMedium(x.expenseDate)}</span> },
    {
      key: "category",
      header: t("expenses.category"),
      render: (x) => (
        <div>
          <p className="font-medium text-ink">{label(x)}</p>
          <p className="text-[12px] text-ink-3">{x.expenseNumber}</p>
        </div>
      ),
    },
    {
      key: "paidTo",
      header: t("expenses.paidTo"),
      render: (x) => (
        <span className="text-ink-2">
          {x.paidTo ?? "—"}
          {x.referenceNumber && <span className="text-ink-3"> · {x.referenceNumber}</span>}
        </span>
      ),
    },
    { key: "method", header: t("common.method"), render: (x) => <span className="text-ink-2">{t(`paymentMethod.${x.paymentMethod}`)}</span> },
    { key: "gst", header: "GST", align: "right", render: (x) => (Number(x.gst) > 0 ? money(x.gst) : <span className="text-ink-3">—</span>) },
    {
      key: "total",
      header: t("common.total"),
      align: "right",
      render: (x) => (x.status === "cancelled" ? <span className="text-ink-3 line-through">{money(x.totalAmount)}</span> : <span className="font-semibold text-ink">{money(x.totalAmount)}</span>),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("expenses.search")} aria-label={t("expenses.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label={t("expenses.category")} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="md:w-44">
          <option value="">
            {t("expenses.category")}: {t("common.all")}
          </option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {label(c)}
            </option>
          ))}
        </Select>
        <Input type="date" aria-label={t("common.from")} value={from} onChange={(e) => setFrom(e.target.value)} className="md:w-40" />
        <Input type="date" aria-label={t("common.to")} value={to} onChange={(e) => setTo(e.target.value)} className="md:w-40" />
        <Segmented
          size="sm"
          label={t("common.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "posted", label: t("status.document.posted") },
            { value: "cancelled", label: t("common.cancelled") },
            { value: "all", label: t("common.all") },
          ]}
        />
      </FilterBar>
      {totals.data && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t("expenses.count")} value={totals.data.count} />
          <Stat label={t("expenses.amountBeforeGst")} value={money(totals.data.amount)} />
          <Stat label="GST" value={money(totals.data.gst)} />
          <Stat label={t("common.total")} value={money(totals.data.total)} />
        </div>
      )}
      {list.error ? <ErrorNote error={list.error} /> : null}
      <DataTable
        columns={columns}
        rows={list.rows}
        rowKey={(x) => x.id}
        loading={list.loading}
        onRowClick={(x) => setOpenId(x.id)}
        minWidth={760}
        empty={<EmptyState title={t("expenses.empty")} hint={t("expenses.emptyHint")} />}
      />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
      <ExpenseDetailDialog expenseId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function ExpenseDetailDialog({ expenseId, onClose }: { expenseId: string | null; onClose(): void }) {
  const { t, money, dateMedium } = useI18n();
  const label = useCategoryLabel();
  const toast = useToast();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const detail = useQuery({ queryKey: ["expenses", "detail", expenseId], queryFn: () => api.get<ExpenseDetail>(`/expenses/${expenseId}`), enabled: Boolean(expenseId) });
  useEffect(() => {
    setCancelling(false);
    setReason("");
    setError(null);
  }, [expenseId]);
  const x = detail.data;

  const cancel = async () => {
    if (!x) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/expenses/${x.id}/cancel`, { reason: reason.trim() });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["reports"] });
      void qc.invalidateQueries({ queryKey: ["gst"] });
      toast({ tone: "success", title: t("expenses.cancelled"), body: x.expenseNumber });
      setCancelling(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(expenseId)}
      onOpenChange={(v) => !v && onClose()}
      title={x ? `${t("expenses.expense")} ${x.expenseNumber}` : t("common.loading")}
      description={x ? `${label(x)} · ${dateMedium(x.expenseDate)}` : undefined}
      closeLabel={t("common.close")}
      footer={
        x?.status === "posted" && allowed("expense.delete") ? (
          cancelling ? (
            <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => void cancel()}>
              {t("expenses.confirmCancel")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setCancelling(true)}>
              {t("expenses.cancel")}
            </Button>
          )
        ) : undefined
      }
    >
      {detail.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : detail.error ? (
        <ErrorNote error={detail.error} />
      ) : x ? (
        <div className="flex flex-col gap-4">
          {error ? <ErrorNote error={error} /> : null}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label={t("common.total")} value={money(x.totalAmount)} tone={x.status === "cancelled" ? "danger" : undefined} />
            <Stat label={t("expenses.amountBeforeGst")} value={money(x.amount)} />
            <Stat label={t("common.method")} value={t(`paymentMethod.${x.paymentMethod}`) + (x.accountName ? ` · ${x.accountName}` : "")} />
            {x.paidTo && <Stat label={t("expenses.paidTo")} value={x.paidTo} />}
            {x.referenceNumber && <Stat label={t("expenses.billNumber")} value={x.referenceNumber} />}
            <Stat label={t("common.status")} value={x.status === "cancelled" ? <Badge tone="danger">{t("common.cancelled")}</Badge> : <Badge tone="good">{t("status.document.posted")}</Badge>} />
          </div>
          {Number(x.gstRate) > 0 && (
            <dl className="num grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line px-3 py-2 text-[13px] sm:grid-cols-4">
              <div>
                <dt className="text-ink-3">{t("expenses.vendorGstin")}</dt>
                <dd className="font-medium text-ink">{x.vendorGstin}</dd>
              </div>
              <div>
                <dt className="text-ink-3">{t("expenses.gstRate")}</dt>
                <dd className="font-medium text-ink">{Number(x.gstRate)}%</dd>
              </div>
              <div>
                <dt className="text-ink-3">{Number(x.igstAmount) > 0 ? "IGST" : "CGST + SGST"}</dt>
                <dd className="font-medium text-ink">{Number(x.igstAmount) > 0 ? money(x.igstAmount) : `${money(x.cgstAmount)} + ${money(x.sgstAmount)}`}</dd>
              </div>
              <div>
                <dt className="text-ink-3">{t("expenses.itc")}</dt>
                <dd className="font-medium text-ink">{x.itcEligibility ? t(`expenses.itcTypes.${x.itcEligibility as "eligible"}`) : "—"}</dd>
              </div>
            </dl>
          )}
          {x.notes && <p className="text-[13px] text-ink-2">{x.notes}</p>}
          {x.cancelReason && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {t("common.reason")}: {x.cancelReason}
            </p>
          )}
          {cancelling && (
            <Field label={t("common.reason")} htmlFor="ex-reason" hint={t("expenses.cancelHint")}>
              <Input id="ex-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </Field>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

type SummaryRow = { key: string; label: string; labelHi: string | null; count: number; amount: string; gst: string; itc: string; total: string };

function ExpenseSummary() {
  const { t, money, number, locale } = useI18n();
  const period = usePeriod();
  const [groupBy, setGroupBy] = useState<"category" | "month" | "year" | "method">("category");
  const query = { from: period.from, to: period.to, groupBy };
  const q = useQuery({
    queryKey: ["reports", "expenses", query],
    queryFn: () => api.get<{ rows: SummaryRow[]; totals: Totals }>("/reports/expenses", query),
    enabled: Boolean(period.from && period.to),
    placeholderData: (prev) => prev,
  });
  const top = Math.max(1, ...(q.data?.rows ?? []).map((r) => Number(r.total)));
  const rowLabel = (r: SummaryRow) => (groupBy === "method" ? t(`paymentMethod.${r.label as "cash"}`) : (locale === "hi" && r.labelHi) || r.label);
  return (
    <div className="flex flex-col gap-4">
      <PeriodBar period={period}>
        <Select aria-label={t("common.groupBy")} value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)} className="md:w-48">
          {(["category", "month", "year", "method"] as const).map((g) => (
            <option key={g} value={g}>
              {t("common.groupBy")}: {t(`reports.groups.${g}`)}
            </option>
          ))}
        </Select>
        <div className="md:ml-auto">
          <ExportButton path="/reports/expenses" query={query} filename={`expenses-${period.from}-${period.to}.csv`} />
        </div>
      </PeriodBar>
      {q.error ? <ErrorNote error={q.error} /> : null}
      <DataTable
        rows={q.data?.rows ?? []}
        rowKey={(r) => r.key}
        loading={q.isPending}
        empty={<EmptyState title={t("expenses.empty")} />}
        columns={[
          {
            key: "label",
            header: t(`reports.groups.${groupBy}`),
            render: (r) => (
              <div className="flex min-w-40 flex-col gap-1">
                <span className="font-medium text-ink">{rowLabel(r)}</span>
                <ProgressBar value={Number(r.total) / top} label={rowLabel(r)} />
              </div>
            ),
          },
          { key: "count", header: t("expenses.count"), align: "right", render: (r) => number(r.count, 0) },
          { key: "amount", header: t("expenses.amountBeforeGst"), align: "right", render: (r) => money(r.amount) },
          { key: "gst", header: "GST", align: "right", render: (r) => money(r.gst) },
          { key: "itc", header: t("expenses.itcShort"), align: "right", render: (r) => money(r.itc) },
          { key: "total", header: t("common.total"), align: "right", render: (r) => <span className="font-semibold">{money(r.total)}</span> },
        ]}
        footer={
          q.data?.totals ? (
            <tfoot className="num border-t border-line bg-surface-2 font-semibold text-ink">
              <tr>
                <td className="py-2.5 pl-4">{t("common.total")}</td>
                <td className="py-2.5 pr-3 pl-3 text-right">{number(q.data.totals.count, 0)}</td>
                <td className="py-2.5 pr-3 pl-3 text-right">{money(q.data.totals.amount)}</td>
                <td className="py-2.5 pr-3 pl-3 text-right">{money(q.data.totals.gst)}</td>
                <td />
                <td className="py-2.5 pr-4 pl-3 text-right">{money(q.data.totals.total)}</td>
              </tr>
            </tfoot>
          ) : undefined
        }
      />
    </div>
  );
}

function CategoryManager() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const categories = useExpenseCategories();
  const [name, setName] = useState("");
  const [nameHi, setNameHi] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canAdd = allowed("expense.create");
  const canEdit = allowed("expense.update");

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ["expense-categories"] });
      toast({ tone: "success", title: done });
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorNote error={error} /> : null}
      {canAdd && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-line p-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.post("/expense-categories", { name: name.trim(), ...(nameHi.trim() ? { nameHi: nameHi.trim() } : {}) }), t("expenses.categoryAdded")).then((ok) => {
              if (ok) {
                setName("");
                setNameHi("");
              }
            });
          }}
        >
          <div className="flex-1">
            <Field label={t("common.name")} htmlFor="ec-name">
              <Input id="ec-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <div className="flex-1">
            <Field label={t("expenses.nameHi")} htmlFor="ec-name-hi" hint={t("common.optional")}>
              <Input id="ec-name-hi" maxLength={60} value={nameHi} onChange={(e) => setNameHi(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" disabled={busy || !name.trim()} icon={<Plus size={16} />}>
            {t("expenses.addCategory")}
          </Button>
        </form>
      )}
      <DataTable
        rows={categories.data ?? []}
        rowKey={(c) => c.id}
        loading={categories.isPending}
        columns={[
          { key: "name", header: t("common.name"), render: (c) => <span className={c.isActive ? "font-medium text-ink" : "text-ink-3 line-through"}>{c.name}</span> },
          { key: "nameHi", header: t("expenses.nameHi"), render: (c) => <span className="text-ink-2">{c.nameHi ?? "—"}</span> },
          { key: "status", header: t("common.status"), render: (c) => <Badge tone={c.isActive ? "good" : "neutral"}>{c.isActive ? t("common.active") : t("common.inactive")}</Badge> },
          {
            key: "action",
            header: "",
            align: "right",
            render: (c) =>
              canEdit ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.patch(`/expense-categories/${c.id}`, { isActive: !c.isActive }), c.isActive ? t("expenses.categoryHidden") : t("expenses.categoryShown"))}>
                  {c.isActive ? t("expenses.hide") : t("expenses.show")}
                </Button>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
