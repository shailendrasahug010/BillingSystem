import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Plus, Search } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input, Select } from "../../components/ui/Field";
import { EmptyState, Segmented } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, TAB_TRIGGER, type Column } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";
import { usePaged } from "../../lib/usePaged";
import { STATUS_TONE, useDepartments, type EmployeeRow } from "./api";
import { EmployeeDetailDialog } from "./EmployeeDetailDialog";
import { EmployeeDialog } from "./EmployeeDialog";

export function EmployeesPage() {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("people.title")}
        subtitle={t("people.subtitle")}
        actions={
          allowed("employee.create") ? (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
              {t("people.add")}
            </Button>
          ) : undefined
        }
      />
      <Tabs.Root defaultValue="list" className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("people.title")}>
          <Tabs.Trigger value="list" className={TAB_TRIGGER}>
            {t("people.title")}
          </Tabs.Trigger>
          <Tabs.Trigger value="attendance" className={TAB_TRIGGER}>
            {t("people.attendance")}
          </Tabs.Trigger>
          <Tabs.Trigger value="register" className={TAB_TRIGGER}>
            {t("people.register")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="list">
          <EmployeeList />
        </Tabs.Content>
        <Tabs.Content value="attendance">
          <AttendanceDay />
        </Tabs.Content>
        <Tabs.Content value="register">
          <AttendanceRegister />
        </Tabs.Content>
      </Tabs.Root>
      <EmployeeDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function EmployeeList() {
  const { t, money, dateMedium } = useI18n();
  const departments = useDepartments();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"current" | "all">("current");
  const [departmentId, setDepartmentId] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const list = usePaged<EmployeeRow>("employees", "/employees", { status, departmentId: departmentId || undefined, q: q.trim().length >= 2 ? q.trim() : undefined });
  const columns: Column<EmployeeRow>[] = [
    {
      key: "name",
      header: t("common.name"),
      sortValue: (e) => e.name,
      render: (e) => (
        <div>
          <p className="font-medium text-ink">{e.name}</p>
          <p className="text-[12px] text-ink-3">
            <span className="font-mono">{e.employeeCode}</span>
            {e.designation ? ` · ${e.designation}` : ""}
          </p>
        </div>
      ),
    },
    { key: "dept", header: t("people.department"), sortValue: (e) => e.departmentName, render: (e) => <span className="text-ink-2">{e.departmentName ?? "—"}</span> },
    { key: "mobile", header: t("common.mobile"), render: (e) => <span className="text-ink-2">{e.mobile}</span> },
    { key: "joined", header: t("people.joiningDate"), sortValue: (e) => e.joiningDate, render: (e) => <span className="text-ink-2">{dateMedium(e.joiningDate)}</span> },
    { key: "status", header: t("common.status"), sortValue: (e) => t(`people.status.${e.status}`), render: (e) => <Badge tone={STATUS_TONE[e.status]}>{t(`people.status.${e.status}`)}</Badge> },
    ...(allowed("payroll.view") ? [{ key: "salary", header: t("people.monthlySalary"), align: "right" as const, sortValue: (e: EmployeeRow) => (e.monthlySalary ? Number(e.monthlySalary) : null), render: (e: EmployeeRow) => (e.monthlySalary && Number(e.monthlySalary) > 0 ? money(e.monthlySalary) : "—") }] : []),
  ];
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Input className="flex-1" leading={<Search size={16} />} placeholder={t("people.search")} aria-label={t("people.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label={t("people.department")} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="md:w-44">
          <option value="">
            {t("people.department")}: {t("common.all")}
          </option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <Segmented
          size="sm"
          label={t("common.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "current", label: t("people.current") },
            { value: "all", label: t("common.all") },
          ]}
        />
      </FilterBar>
      {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
      <DataTable id="employees" columns={columns} rows={list.rows} rowKey={(e) => e.id} loading={list.loading} onRowClick={(e) => setOpenId(e.id)} minWidth={760} empty={<EmptyState title={t("people.empty")} hint={t("people.emptyHint")} />} />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
      <EmployeeDetailDialog employeeId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

type Status = "present" | "absent" | "half_day" | "leave" | "holiday" | "week_off";
const STATUSES: Status[] = ["present", "absent", "half_day", "leave", "holiday", "week_off"];
const STATUS_STYLE: Record<Status, string> = {
  present: "bg-good text-white",
  absent: "bg-danger text-white",
  half_day: "bg-warn text-white",
  leave: "bg-accent text-white",
  holiday: "bg-ink-3 text-white",
  week_off: "bg-ink-3 text-white",
};

interface DayRow {
  employeeId: string;
  employeeCode: string;
  name: string;
  designation: string | null;
  status: Status | null;
  overtimeHours: string;
  note: string | null;
  leave: { type: string; halfDay: boolean } | null;
}

/** Mark a day for everyone: one tap per person; unmarked people count as present in payroll. */
function AttendanceDay() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [date, setDate] = useState(TODAY);
  const [marks, setMarks] = useState<Record<string, { status: Status | null; overtimeHours: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const day = useQuery({ queryKey: ["attendance", date], queryFn: () => api.get<{ data: DayRow[] }>("/attendance", { date }).then((r) => r.data), enabled: Boolean(date) });
  useEffect(() => {
    setMarks(Object.fromEntries((day.data ?? []).map((r) => [r.employeeId, { status: r.status, overtimeHours: Number(r.overtimeHours) ? String(Number(r.overtimeHours)) : "" }])));
  }, [day.data]);
  const canMark = allowed("employee.update") && date <= TODAY;
  const changed = (day.data ?? []).filter((r) => {
    const m = marks[r.employeeId];
    return m && m.status && (m.status !== r.status || (m.overtimeHours || "0") !== String(Number(r.overtimeHours)));
  });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put("/attendance", { date, entries: changed.map((r) => ({ employeeId: r.employeeId, status: marks[r.employeeId]!.status, overtimeHours: marks[r.employeeId]!.overtimeHours || "0" })) });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
      toast({ tone: "success", title: t("people.attendanceSaved"), body: t("people.attendanceCount", { count: changed.length }) });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Input type="date" aria-label={t("common.date")} value={date} max={TODAY} onChange={(e) => setDate(e.target.value)} className="md:w-48" />
        {canMark && (
          <Button
            size="sm"
            icon={<CheckCheck size={14} />}
            onClick={() => setMarks((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, status: v.status ?? "present" }])))}
          >
            {t("people.markRestPresent")}
          </Button>
        )}
        {canMark && (
          <Button variant="primary" className="md:ml-auto" disabled={busy || changed.length === 0} onClick={() => void save()}>
            {busy ? t("common.saving") : changed.length ? t("people.saveMarks", { count: changed.length }) : t("common.save")}
          </Button>
        )}
      </FilterBar>
      {error ? <ErrorNote error={error} /> : null}
      <p className="text-[13px] text-ink-3">{t("people.attendanceHint")}</p>
      <DataTable
        rows={day.data ?? []}
        rowKey={(r) => r.employeeId}
        loading={day.isPending}
        minWidth={640}
        empty={<EmptyState title={t("people.empty")} hint={t("people.emptyHint")} />}
        columns={[
          {
            key: "name",
            header: t("common.name"),
            render: (r) => (
              <div>
                <p className="font-medium text-ink">{r.name}</p>
                <p className="text-[12px] text-ink-3">
                  {r.employeeCode}
                  {r.leave ? ` · ${t("people.onLeave", { type: r.leave.type })}` : ""}
                </p>
              </div>
            ),
          },
          {
            key: "status",
            header: t("common.status"),
            render: (r) => (
              <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={`${t("common.status")} ${r.name}`}>
                {STATUSES.map((s) => {
                  const on = marks[r.employeeId]?.status === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={!canMark}
                      title={t(`people.att.${s}`)}
                      onClick={() => setMarks((m) => ({ ...m, [r.employeeId]: { overtimeHours: m[r.employeeId]?.overtimeHours ?? "", status: s } }))}
                      className={cn(
                        "h-8 min-w-9 rounded-md border px-2 text-[12.5px] font-semibold transition-colors",
                        on ? `${STATUS_STYLE[s]} border-transparent` : "border-line bg-surface text-ink-2 hover:bg-surface-2",
                      )}
                    >
                      {t(`people.attShort.${s}`)}
                    </button>
                  );
                })}
              </div>
            ),
          },
          {
            key: "ot",
            header: t("people.overtime"),
            align: "right",
            render: (r) => (
              <Input
                inputSize="sm"
                inputMode="decimal"
                aria-label={`${t("people.overtime")} ${r.name}`}
                disabled={!canMark}
                className="ml-auto w-20 [&_input]:text-right"
                value={marks[r.employeeId]?.overtimeHours ?? ""}
                onChange={(e) => setMarks((m) => ({ ...m, [r.employeeId]: { status: m[r.employeeId]?.status ?? "present", overtimeHours: e.target.value.trim() } }))}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

interface RegisterRow {
  id: string;
  employeeCode: string;
  name: string;
  days: Record<string, Status>;
  counts: { present: number; absent: number; halfDay: number; leave: number; holiday: number; weekOff: number };
  overtimeHours: string;
}

function AttendanceRegister() {
  const { t, number } = useI18n();
  const [month, setMonth] = useState(TODAY.slice(0, 7));
  const q = useQuery({
    queryKey: ["attendance", "month", month],
    queryFn: () => api.get<{ from: string; to: string; data: RegisterRow[] }>("/attendance/month", { month }),
    enabled: /^\d{4}-\d{2}$/.test(month),
  });
  const days = q.data ? Number(q.data.to.slice(8, 10)) : 0;
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Input type="month" aria-label={t("common.period")} value={month} max={TODAY.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} className="md:w-48" />
      </FilterBar>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      <DataTable
        rows={q.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={q.isPending}
        minWidth={900}
        empty={<EmptyState title={t("people.empty")} hint={t("people.emptyHint")} />}
        columns={[
          { key: "name", header: t("common.name"), render: (r) => <span className="font-medium text-ink">{r.name}</span> },
          {
            key: "days",
            header: t("people.days"),
            render: (r) => (
              <div className="flex gap-px" aria-hidden>
                {Array.from({ length: days }, (_, i) => {
                  const d = `${month}-${String(i + 1).padStart(2, "0")}`;
                  const s = r.days[d];
                  return <span key={d} title={`${i + 1}: ${s ? t(`people.att.${s}`) : "—"}`} className={cn("h-4 w-1.5 rounded-sm", s ? STATUS_STYLE[s].split(" ")[0] : "bg-line")} />;
                })}
              </div>
            ),
          },
          { key: "absent", header: t("people.attShort.absent"), align: "right", render: (r) => r.counts.absent || "—" },
          { key: "half", header: t("people.attShort.half_day"), align: "right", render: (r) => r.counts.halfDay || "—" },
          { key: "leave", header: t("people.attShort.leave"), align: "right", render: (r) => r.counts.leave || "—" },
          { key: "ot", header: t("people.overtime"), align: "right", render: (r) => (Number(r.overtimeHours) ? number(r.overtimeHours, 1) : "—") },
        ]}
      />
      <p className="flex flex-wrap gap-3 text-[12px] text-ink-3">
        {STATUSES.map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cn("inline-block h-3 w-1.5 rounded-sm", STATUS_STYLE[s].split(" ")[0])} /> {t(`people.att.${s}`)}
          </span>
        ))}
      </p>
    </div>
  );
}
