import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Check, X } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, TAB_TRIGGER, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { usePaged } from "../../lib/usePaged";
import { useEmployeeOptions, useLeaveTypes, useLocalName } from "./api";

type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";
const TONE: Record<LeaveStatus, Tone> = { pending: "warn", approved: "good", rejected: "danger", cancelled: "neutral" };

interface RequestRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  leaveTypeNameHi: string | null;
  isPaid: boolean;
  fromDate: string;
  toDate: string;
  halfDay: boolean;
  days: string;
  reason: string | null;
  status: LeaveStatus;
  decisionNote: string | null;
}

export function LeavePage() {
  const { t } = useI18n();
  const [applying, setApplying] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("leave.title")}
        subtitle={t("leave.subtitle")}
        actions={
          allowed("leave.apply") ? (
            <Button variant="primary" icon={<CalendarPlus size={16} />} onClick={() => setApplying(true)}>
              {t("leave.apply")}
            </Button>
          ) : undefined
        }
      />
      <Tabs.Root defaultValue="requests" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("leave.title")}>
          <Tabs.Trigger value="requests" className={TAB_TRIGGER}>
            {t("leave.requests")}
          </Tabs.Trigger>
          <Tabs.Trigger value="balances" className={TAB_TRIGGER}>
            {t("leave.balances")}
          </Tabs.Trigger>
          <Tabs.Trigger value="types" className={TAB_TRIGGER}>
            {t("leave.types")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="requests">
          <Requests />
        </Tabs.Content>
        <Tabs.Content value="balances">
          <Balances />
        </Tabs.Content>
        <Tabs.Content value="types">
          <LeaveTypes />
        </Tabs.Content>
      </Tabs.Root>
      <ApplyLeaveDialog open={applying} onOpenChange={setApplying} />
    </div>
  );
}

function Requests() {
  const { t, dateMedium, number } = useI18n();
  const name = useLocalName();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<LeaveStatus | "all">("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const list = usePaged<RequestRow>("leave", "/leave/requests", { status });
  const act = async (id: string, path: string, body: unknown, done: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/leave/requests/${id}/${path}`, body);
      void qc.invalidateQueries({ queryKey: ["leave"] });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
      toast({ tone: "success", title: done });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Segmented
          size="sm"
          label={t("common.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "pending", label: t("leave.status.pending") },
            { value: "approved", label: t("leave.status.approved") },
            { value: "all", label: t("common.all") },
          ]}
        />
      </FilterBar>
      {error ? <ErrorNote error={error} /> : null}
      {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
      <DataTable
        rows={list.rows}
        rowKey={(r) => r.id}
        loading={list.loading}
        minWidth={820}
        empty={<EmptyState title={t("leave.empty")} hint={t("leave.emptyHint")} />}
        columns={[
          {
            key: "employee",
            header: t("leave.employee"),
            render: (r) => (
              <div>
                <p className="font-medium text-ink">{r.employeeName}</p>
                <p className="text-[12px] text-ink-3">{r.employeeCode}</p>
              </div>
            ),
          },
          {
            key: "type",
            header: t("leave.type"),
            render: (r) => (
              <span className="flex items-center gap-1.5">
                <Badge tone={r.isPaid ? "accent" : "neutral"}>{r.leaveTypeCode}</Badge>
                <span className="text-ink-2">{name({ name: r.leaveTypeName, nameHi: r.leaveTypeNameHi })}</span>
              </span>
            ),
          },
          {
            key: "dates",
            header: t("leave.dates"),
            render: (r) => (
              <div>
                <p className="text-ink">{r.fromDate === r.toDate ? dateMedium(r.fromDate) : `${dateMedium(r.fromDate)} – ${dateMedium(r.toDate)}`}</p>
                <p className="text-[12px] text-ink-3">
                  {r.halfDay ? t("leave.halfDay") : t("leave.dayCount", { count: Number(r.days) })}
                  {r.reason ? ` · ${r.reason}` : ""}
                </p>
              </div>
            ),
          },
          { key: "days", header: t("leave.days"), align: "right", render: (r) => number(r.days, 1) },
          { key: "status", header: t("common.status"), render: (r) => <Badge tone={TONE[r.status]}>{t(`leave.status.${r.status}`)}</Badge> },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (r) => (
              <div className="flex justify-end gap-1">
                {r.status === "pending" && allowed("leave.approve") && (
                  <>
                    <Button size="sm" icon={<Check size={14} />} disabled={busy === r.id} onClick={() => void act(r.id, "decide", { decision: "approve" }, t("leave.approved"))}>
                      {t("leave.approve")}
                    </Button>
                    <Button size="sm" variant="ghost" icon={<X size={14} />} disabled={busy === r.id} onClick={() => void act(r.id, "decide", { decision: "reject" }, t("leave.rejected"))}>
                      {t("leave.reject")}
                    </Button>
                  </>
                )}
                {(r.status === "pending" || (r.status === "approved" && allowed("leave.approve"))) && allowed("leave.apply") && (
                  <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void act(r.id, "cancel", {}, t("leave.cancelled"))}>
                    {t("leave.withdraw")}
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
    </div>
  );
}

function Balances() {
  const { t, number } = useI18n();
  const name = useLocalName();
  const [year, setYear] = useState(Number(TODAY.slice(0, 4)));
  const q = useQuery({
    queryKey: ["leave", "balances", year],
    queryFn: () => api.get<{ data: Array<{ employeeId: string; employeeName: string; leaveTypeId: string; code: string; name: string; nameHi: string | null; isPaid: boolean; entitled: string; used: string; pending: string; available: string }> }>("/leave/balances", { year }).then((r) => r.data),
  });
  const types = [...new Map((q.data ?? []).filter((b) => b.isPaid && Number(b.entitled) > 0).map((b) => [b.leaveTypeId, b])).values()];
  const employees = [...new Map((q.data ?? []).map((b) => [b.employeeId, b.employeeName])).entries()];
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Select aria-label={t("leave.year")} value={String(year)} onChange={(e) => setYear(Number(e.target.value))} className="md:w-32">
          {[year - 1, year, year + 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        <span className="text-[13px] text-ink-3">{t("leave.balanceHint")}</span>
      </FilterBar>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      <DataTable
        rows={employees}
        rowKey={([id]) => id}
        loading={q.isPending}
        minWidth={520}
        empty={<EmptyState title={t("people.empty")} hint={t("people.emptyHint")} />}
        columns={[
          { key: "name", header: t("leave.employee"), render: ([, n]) => <span className="font-medium text-ink">{n}</span> },
          ...types.map((ty) => ({
            key: ty.leaveTypeId,
            header: `${ty.code} · ${name(ty)}`,
            align: "right" as const,
            render: ([id]: [string, string]) => {
              const b = q.data!.find((x) => x.employeeId === id && x.leaveTypeId === ty.leaveTypeId)!;
              return (
                <span title={t("leave.balanceTitle", { used: number(b.used, 1), entitled: number(b.entitled, 1), pending: number(b.pending, 1) })}>
                  <span className={Number(b.available) <= 0 ? "font-semibold text-danger" : "font-semibold text-ink"}>{number(b.available, 1)}</span>
                  <span className="text-ink-3"> / {number(b.entitled, 1)}</span>
                </span>
              );
            },
          })),
        ]}
      />
    </div>
  );
}

function LeaveTypes() {
  const { t, number } = useI18n();
  const name = useLocalName();
  const toast = useToast();
  const qc = useQueryClient();
  const types = useLeaveTypes();
  const [quota, setQuota] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const canEdit = allowed("leave.configure");
  const save = async (id: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      await api.patch(`/leave-types/${id}`, body);
      void qc.invalidateQueries({ queryKey: ["leave-types"] });
      void qc.invalidateQueries({ queryKey: ["leave"] });
      toast({ tone: "success", title: t("leave.typeSaved") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorNote error={error} /> : null}
      <DataTable
        rows={types.data ?? []}
        rowKey={(x) => x.id}
        loading={types.isPending}
        columns={[
          { key: "code", header: t("leave.type"), render: (x) => <span className={x.isActive ? "font-medium text-ink" : "text-ink-3 line-through"}>{`${x.code} · ${name(x)}`}</span> },
          { key: "paid", header: t("leave.paid"), render: (x) => <Badge tone={x.isPaid ? "good" : "neutral"}>{x.isPaid ? t("leave.paidYes") : t("leave.unpaid")}</Badge> },
          {
            key: "quota",
            header: t("leave.quota"),
            align: "right",
            render: (x) =>
              canEdit && x.isPaid ? (
                <div className="flex items-center justify-end gap-1">
                  <Input
                    inputSize="sm"
                    inputMode="decimal"
                    aria-label={`${t("leave.quota")} ${x.code}`}
                    className="w-16 [&_input]:text-right"
                    value={quota[x.id] ?? String(Number(x.annualQuota))}
                    onChange={(e) => setQuota((q) => ({ ...q, [x.id]: e.target.value.trim() }))}
                  />
                  {quota[x.id] !== undefined && quota[x.id] !== String(Number(x.annualQuota)) && (
                    <Button size="sm" onClick={() => void save(x.id, { annualQuota: quota[x.id] })}>
                      {t("common.save")}
                    </Button>
                  )}
                </div>
              ) : (
                number(x.annualQuota, 1)
              ),
          },
          { key: "half", header: t("leave.halfDayAllowed"), render: (x) => (x.allowHalfDay ? "✓" : "—") },
        ]}
      />
      <p className="text-[13px] text-ink-3">{t("leave.quotaHint")}</p>
    </div>
  );
}

function ApplyLeaveDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t, number } = useI18n();
  const name = useLocalName();
  const toast = useToast();
  const qc = useQueryClient();
  const employees = useEmployeeOptions();
  const types = useLeaveTypes();
  const [form, setForm] = useState({ employeeId: "", leaveTypeId: "", fromDate: TODAY, toDate: TODAY, halfDay: false, reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);
  useEffect(() => {
    if (!open) return;
    setForm({ employeeId: "", leaveTypeId: "", fromDate: TODAY, toDate: TODAY, halfDay: false, reason: "" });
    setError(null);
  }, [open]);
  const type = types.data?.find((x) => x.id === form.leaveTypeId);
  const balance = useQuery({
    queryKey: ["leave", "balances", "one", form.employeeId, form.fromDate.slice(0, 4)],
    queryFn: () => api.get<{ data: Array<{ leaveTypeId: string; available: string; pending: string }> }>("/leave/balances", { employeeId: form.employeeId, year: form.fromDate.slice(0, 4) }).then((r) => r.data),
    enabled: open && Boolean(form.employeeId),
  });
  const bal = balance.data?.find((b) => b.leaveTypeId === form.leaveTypeId);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/leave/requests", { ...form, toDate: form.halfDay ? form.fromDate : form.toDate, ...(form.reason.trim() ? { reason: form.reason.trim() } : { reason: undefined }) });
      void qc.invalidateQueries({ queryKey: ["leave"] });
      toast({ tone: "success", title: t("leave.appliedDone") });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("leave.apply")}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !form.employeeId || !form.leaveTypeId || (!form.halfDay && form.toDate < form.fromDate)} onClick={() => void save()}>
            {busy ? t("common.saving") : t("leave.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <Field label={t("leave.employee")} htmlFor="lv-emp" error={fieldError("employeeId")}>
          <Select id="lv-emp" autoFocus value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}>
            <option value="">—</option>
            {(employees.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.employeeCode}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("leave.type")} htmlFor="lv-type" hint={bal ? t("leave.availableHint", { days: number(Number(bal.available) - Number(bal.pending), 1) }) : undefined} error={fieldError("leaveTypeId")}>
          <Select id="lv-type" value={form.leaveTypeId} onChange={(e) => setForm((f) => ({ ...f, leaveTypeId: e.target.value }))}>
            <option value="">—</option>
            {(types.data ?? [])
              .filter((x) => x.isActive)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} · {name(x)}
                  {x.isPaid ? "" : ` (${t("leave.unpaid")})`}
                </option>
              ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("common.from")} htmlFor="lv-from" error={fieldError("fromDate")}>
            <Input id="lv-from" type="date" value={form.fromDate} onChange={(e) => setForm((f) => ({ ...f, fromDate: e.target.value, toDate: f.toDate < e.target.value ? e.target.value : f.toDate }))} />
          </Field>
          <Field label={t("common.to")} htmlFor="lv-to" error={fieldError("toDate")}>
            <Input id="lv-to" type="date" min={form.fromDate} disabled={form.halfDay} value={form.halfDay ? form.fromDate : form.toDate} onChange={(e) => setForm((f) => ({ ...f, toDate: e.target.value }))} />
          </Field>
        </div>
        {type?.allowHalfDay !== false && <Checkbox label={t("leave.halfDayOption")} checked={form.halfDay} onChange={(v) => setForm((f) => ({ ...f, halfDay: v }))} />}
        <Field label={t("common.reason")} htmlFor="lv-reason" hint={t("common.optional")}>
          <Input id="lv-reason" maxLength={300} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
        </Field>
      </div>
    </Dialog>
  );
}
