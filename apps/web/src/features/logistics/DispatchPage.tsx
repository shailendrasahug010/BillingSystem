import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FileJson, Printer, Truck } from "lucide-react";
import { downloadPortalFile, fileName } from "../gst/einvoiceDialogs";
import { Tabs } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button, IconButton } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { EmptyState, Segmented, Skeleton } from "../../components/ui/misc";
import { DataTable, ErrorNote, FilterBar, LoadMore, PageHeader, Stat, TAB_TRIGGER, useFieldError } from "../../components/ui/Page";
import { PrintPortal } from "../../components/ui/PrintPortal";
import { useToast } from "../../components/ui/Toast";
import { allowed, TODAY, WORKSPACE } from "../../data/db";
import { api, ApiError } from "../../lib/api";
import { usePaged } from "../../lib/usePaged";
import { useEmployeeOptions } from "../people/api";
import { DispatchSheetDocument, type PrintableTrip } from "./DispatchSheetDocument";

export type TripStatus = "planned" | "dispatched" | "in_transit" | "delivered" | "partially_delivered" | "returned" | "cancelled";
export const TRIP_TONE: Record<TripStatus, Tone> = { planned: "neutral", dispatched: "accent", in_transit: "accent", delivered: "good", partially_delivered: "warn", returned: "danger", cancelled: "danger" };

interface ReadyInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  grandTotal: string;
  customerName: string;
  city: string | null;
  address: string | null;
  route: string | null;
  orderNumber: string | null;
  orderStatus: string | null;
}

interface TripRow {
  id: string;
  dispatchNumber: string;
  dispatchDate: string;
  vehicleNumber: string | null;
  driverName: string | null;
  status: TripStatus;
  stops: number;
  done: number;
  value: string;
}

export function DispatchPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState("ready");
  const [openTrip, setOpenTrip] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("dispatch.title")} subtitle={t("dispatch.subtitle")} />
      <Tabs.Root value={tab} onValueChange={setTab} className="flex flex-col gap-4">
        <Tabs.List className="scroll-x flex gap-1 border-b border-line" aria-label={t("dispatch.title")}>
          <Tabs.Trigger value="ready" className={TAB_TRIGGER}>
            {t("dispatch.ready")}
          </Tabs.Trigger>
          <Tabs.Trigger value="trips" className={TAB_TRIGGER}>
            {t("dispatch.trips")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="ready">
          <Ready
            onPlanned={(id) => {
              setTab("trips");
              setOpenTrip(id);
            }}
          />
        </Tabs.Content>
        <Tabs.Content value="trips">
          <Trips onOpen={setOpenTrip} />
        </Tabs.Content>
      </Tabs.Root>
      <TripDialog id={openTrip} onClose={() => setOpenTrip(null)} />
    </div>
  );
}

function Ready({ onPlanned }: { onPlanned(id: string): void }) {
  const { t, money, dateMedium } = useI18n();
  const [selected, setSelected] = useState<string[]>([]);
  const [planning, setPlanning] = useState(false);
  const q = useQuery({ queryKey: ["dispatch", "ready"], queryFn: () => api.get<{ data: ReadyInvoice[] }>("/dispatch/ready").then((r) => r.data) });
  const rows = q.data ?? [];
  useEffect(() => setSelected((s) => s.filter((id) => rows.some((r) => r.id === id))), [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const chosen = selected.map((id) => rows.find((r) => r.id === id)).filter((r): r is ReadyInvoice => Boolean(r));
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <span className="text-[13px] text-ink-2">{t("dispatch.readyHint")}</span>
        {allowed("dispatch.dispatch") && (
          <Button variant="primary" className="md:ml-auto" icon={<Truck size={16} />} disabled={selected.length === 0} onClick={() => setPlanning(true)}>
            {t("dispatch.planTrip", { count: selected.length })}
          </Button>
        )}
      </FilterBar>
      {q.error ? <ErrorNote error={q.error} onRetry={() => void q.refetch()} /> : null}
      <DataTable
        id="dispatch-ready"
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.isPending}
        minWidth={760}
        onRowClick={allowed("dispatch.dispatch") ? (r) => toggle(r.id) : undefined}
        empty={<EmptyState title={t("dispatch.nothingReady")} hint={t("dispatch.nothingReadyHint")} />}
        columns={[
          {
            key: "pick",
            header: "",
            render: (r) => <input type="checkbox" className="size-4 accent-[var(--accent)]" aria-label={r.invoiceNumber} checked={selected.includes(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} />,
          },
          {
            key: "invoice",
            header: t("dispatch.invoice"),
            sortValue: (r) => r.invoiceNumber,
            render: (r) => (
              <div>
                <p className="font-medium text-ink">{r.invoiceNumber}</p>
                <p className="text-[12px] text-ink-3">{dateMedium(r.invoiceDate)}</p>
              </div>
            ),
          },
          { key: "customer", header: t("customer.name"), sortValue: (r) => r.customerName, render: (r) => <span className="text-ink">{r.customerName}</span> },
          { key: "place", header: t("dispatch.routeCity"), sortValue: (r) => [r.route, r.city].filter(Boolean).join(" · "), render: (r) => <span className="text-ink-2">{[r.route, r.city].filter(Boolean).join(" · ") || "—"}</span> },
          { key: "order", header: t("packing.order"), sortValue: (r) => r.orderNumber, render: (r) => (r.orderNumber ? <span className="text-ink-2">{r.orderNumber} · {t(`status.order.${r.orderStatus as "packed"}`)}</span> : <span className="text-ink-3">{t("dispatch.counterBill")}</span>) },
          { key: "value", header: t("common.amount"), align: "right", sortValue: (r) => Number(r.grandTotal), render: (r) => money(r.grandTotal) },
        ]}
      />
      <PlanTripDialog
        open={planning}
        invoices={chosen}
        onOpenChange={setPlanning}
        onReorder={setSelected}
        onSaved={(id) => {
          setSelected([]);
          onPlanned(id);
        }}
      />
    </div>
  );
}

function PlanTripDialog({ open, invoices, onOpenChange, onReorder, onSaved }: { open: boolean; invoices: ReadyInvoice[]; onOpenChange(v: boolean): void; onReorder(ids: string[]): void; onSaved(id: string): void }) {
  const { t, money } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const employees = useEmployeeOptions();
  const [form, setForm] = useState({ dispatchDate: TODAY, vehicleNumber: "", driverEmployeeId: "", driverName: "", driverMobile: "", transporterName: "", lrNumber: "", expectedDeliveryDate: "", remarks: "" });
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const move = (i: number, by: number) => {
    const ids = invoices.map((x) => x.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    onReorder(ids);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { invoiceIds: invoices.map((x) => x.id), start };
      for (const [k, v] of Object.entries(form)) if (v.trim()) body[k] = v.trim();
      const res = await api.post<{ id: string; dispatchNumber: string }>("/dispatches", body);
      void qc.invalidateQueries({ queryKey: ["dispatch"] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
      toast({ tone: "success", title: start ? t("dispatch.dispatchedDone") : t("dispatch.plannedDone"), body: res.dispatchNumber });
      onOpenChange(false);
      onSaved(res.id);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const total = invoices.reduce((s, x) => s + Number(x.grandTotal), 0);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("dispatch.newTrip")}
      description={t("dispatch.newTripHint", { count: invoices.length, amount: money(total) })}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || invoices.length === 0} onClick={() => void save()}>
            {busy ? t("common.saving") : start ? t("dispatch.saveAndDispatch") : t("dispatch.savePlanned")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t("common.date")} htmlFor="tr-date">
            <Input id="tr-date" type="date" value={form.dispatchDate} onChange={set("dispatchDate")} />
          </Field>
          <Field label={t("dispatch.vehicle")} htmlFor="tr-vehicle" hint={t("common.optional")} error={fieldError("vehicleNumber")}>
            <Input id="tr-vehicle" className="[&_input]:uppercase" maxLength={15} value={form.vehicleNumber} onChange={set("vehicleNumber")} placeholder="MP09AB1234" />
          </Field>
          <Field label={t("dispatch.driver")} htmlFor="tr-driver-emp" hint={t("common.optional")}>
            <Select id="tr-driver-emp" value={form.driverEmployeeId} onChange={set("driverEmployeeId")}>
              <option value="">{t("dispatch.driverOther")}</option>
              {(employees.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
          {!form.driverEmployeeId && (
            <>
              <Field label={t("dispatch.driverName")} htmlFor="tr-driver" hint={t("common.optional")}>
                <Input id="tr-driver" maxLength={80} value={form.driverName} onChange={set("driverName")} />
              </Field>
              <Field label={t("dispatch.driverMobile")} htmlFor="tr-driver-mobile" hint={t("common.optional")} error={fieldError("driverMobile")}>
                <Input id="tr-driver-mobile" inputMode="tel" value={form.driverMobile} onChange={set("driverMobile")} />
              </Field>
            </>
          )}
          <Field label={t("dispatch.transporter")} htmlFor="tr-transporter" hint={t("common.optional")}>
            <Input id="tr-transporter" maxLength={120} value={form.transporterName} onChange={set("transporterName")} />
          </Field>
          <Field label={t("dispatch.lr")} htmlFor="tr-lr" hint={t("common.optional")}>
            <Input id="tr-lr" maxLength={30} value={form.lrNumber} onChange={set("lrNumber")} />
          </Field>
          <Field label={t("dispatch.expected")} htmlFor="tr-expected" hint={t("common.optional")}>
            <Input id="tr-expected" type="date" min={form.dispatchDate} value={form.expectedDeliveryDate} onChange={set("expectedDeliveryDate")} />
          </Field>
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-ink-2">{t("dispatch.stopsOrder")}</p>
          <ol className="divide-y divide-line rounded-lg border border-line text-[13.5px]">
            {invoices.map((x, i) => (
              <li key={x.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="num w-5 text-ink-3">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-ink">{x.customerName}</span>
                  <span className="text-ink-3"> · {x.invoiceNumber}{x.city ? ` · ${x.city}` : ""}</span>
                </span>
                <IconButton label={t("dispatch.moveUp")} onClick={() => move(i, -1)} disabled={i === 0}>
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton label={t("dispatch.moveDown")} onClick={() => move(i, 1)} disabled={i === invoices.length - 1}>
                  <ArrowDown size={14} />
                </IconButton>
              </li>
            ))}
          </ol>
        </div>
        <Checkbox label={t("dispatch.leaveNow")} checked={start} onChange={setStart} />
      </div>
    </Dialog>
  );
}

function Trips({ onOpen }: { onOpen(id: string): void }) {
  const { t, money, dateMedium } = useI18n();
  const [status, setStatus] = useState<"open" | "delivered" | "all">("open");
  const list = usePaged<TripRow>("dispatch", "/dispatches", { status });
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Segmented
          size="sm"
          label={t("common.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: t("dispatch.onTheWay") },
            { value: "delivered", label: t("dispatch.completed") },
            { value: "all", label: t("common.all") },
          ]}
        />
      </FilterBar>
      {list.error ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : null}
      <DataTable
        id="dispatch-trips"
        rows={list.rows}
        rowKey={(r) => r.id}
        loading={list.loading}
        onRowClick={(r) => onOpen(r.id)}
        minWidth={720}
        empty={<EmptyState title={t("dispatch.noTrips")} hint={t("dispatch.noTripsHint")} />}
        columns={[
          {
            key: "number",
            header: t("common.number"),
            sortValue: (r) => r.dispatchNumber,
            render: (r) => (
              <div>
                <p className="font-medium text-ink">{r.dispatchNumber}</p>
                <p className="text-[12px] text-ink-3">{dateMedium(r.dispatchDate)}</p>
              </div>
            ),
          },
          { key: "vehicle", header: t("dispatch.vehicle"), sortValue: (r) => r.vehicleNumber, render: (r) => <span className="text-ink-2">{[r.vehicleNumber, r.driverName].filter(Boolean).join(" · ") || "—"}</span> },
          { key: "status", header: t("common.status"), sortValue: (r) => t(`dispatch.status.${r.status}`), render: (r) => <Badge tone={TRIP_TONE[r.status]}>{t(`dispatch.status.${r.status}`)}</Badge> },
          { key: "stops", header: t("dispatch.delivered"), align: "right", sortValue: (r) => (r.stops > 0 ? r.done / r.stops : null), render: (r) => `${r.done}/${r.stops}` },
          { key: "value", header: t("common.amount"), align: "right", sortValue: (r) => Number(r.value), render: (r) => money(r.value) },
        ]}
      />
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} onClick={list.loadMore} />
    </div>
  );
}

function TripDialog({ id, onClose }: { id: string | null; onClose(): void }) {
  const { t, money, number, dateTime } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [receivedBy, setReceivedBy] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({ queryKey: ["dispatch", "detail", id], queryFn: () => api.get<PrintableTrip>(`/dispatches/${id}`), enabled: Boolean(id) });
  const trip = q.data;
  useEffect(() => {
    setReceivedBy({});
    setError(null);
  }, [id]);
  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/dispatches/${id}/${path}`, body);
      void qc.invalidateQueries({ queryKey: ["dispatch"] });
      void qc.invalidateQueries({ queryKey: ["orders"] });
      toast({ tone: "success", title: done });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    } finally {
      setBusy(false);
    }
  };
  const onRoad = trip?.status === "dispatched" || trip?.status === "in_transit";
  /** The trip's invoices above the limit without an e-way bill, with its vehicle and transporter, for the e-way bill portal. */
  const ewayBills = async () => {
    setError(null);
    try {
      await downloadPortalFile(`/dispatches/${id}/ewaybills`, {}, fileName("EWB", trip?.dispatchNumber ?? "trip"));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };
  const value = useMemo(() => (trip?.stops ?? []).reduce((s, x) => s + Number(x.grandTotal ?? 0), 0), [trip]);
  return (
    <Dialog
      open={Boolean(id)}
      onOpenChange={(v) => !v && onClose()}
      size="xl"
      title={trip ? `${t("dispatch.trip")} ${trip.dispatchNumber}` : t("common.loading")}
      description={trip ? [trip.vehicleNumber, trip.driverEmployeeName ?? trip.driverName, trip.driverMobile].filter(Boolean).join(" · ") || undefined : undefined}
      closeLabel={t("common.close")}
      footer={
        trip ? (
          <>
            {trip.status === "planned" && allowed("dispatch.dispatch") && (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => void act("cancel", {}, t("dispatch.cancelledDone"))}>
                  {t("dispatch.cancelTrip")}
                </Button>
                <Button variant="primary" icon={<Truck size={16} />} disabled={busy} onClick={() => void act("start", {}, t("dispatch.dispatchedDone"))}>
                  {t("dispatch.start")}
                </Button>
              </>
            )}
            {trip.status !== "cancelled" && trip.stops.some((s) => !s.ewayBillNumber && Number(s.grandTotal ?? 0) > WORKSPACE.ewayThreshold) && (
              <Button icon={<FileJson size={16} />} disabled={busy} onClick={() => void ewayBills()}>
                {t("einvoice.tripEwayBills")}
              </Button>
            )}
            <Button icon={<Printer size={16} />} onClick={() => window.print()}>
              {t("dispatch.printSheet")}
            </Button>
          </>
        ) : undefined
      }
    >
      {q.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : q.error ? (
        <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
      ) : trip ? (
        <div className="flex flex-col gap-4">
          {error ? <ErrorNote error={error} /> : null}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={t("common.status")} value={<Badge tone={TRIP_TONE[trip.status]}>{t(`dispatch.status.${trip.status}`)}</Badge>} />
            <Stat label={t("dispatch.stops")} value={trip.stops.length} />
            <Stat label={t("common.amount")} value={money(value)} />
            {trip.lrNumber && <Stat label={t("dispatch.lr")} value={`${trip.lrNumber}${trip.transporterName ? ` · ${trip.transporterName}` : ""}`} />}
          </div>
          <ol className="divide-y divide-line rounded-lg border border-line text-[13.5px]">
            {trip.stops.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="num w-5 text-ink-3">{s.sequence}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">
                    {s.customerName} <span className="font-normal text-ink-3">· {s.invoiceNumber}</span>
                  </p>
                  {s.ewayBillNumber && <p className="font-mono text-[12px] text-ink-2">{t("einvoice.print.ewayBill", { number: s.ewayBillNumber })}</p>}
                  <p className="text-[12px] text-ink-3">
                    {[s.address, s.city, s.mobile].filter(Boolean).join(" · ")}
                    {s.deliveredAt && ` · ${dateTime(s.deliveredAt)}`}
                    {s.receivedBy && ` · ${t("dispatch.receivedByName", { name: s.receivedBy })}`}
                    {s.remarks && ` · ${s.remarks}`}
                  </p>
                </div>
                <span className="num text-ink-2">{money(s.grandTotal ?? "0")}</span>
                <Badge tone={TRIP_TONE[s.status]}>{t(`dispatch.status.${s.status}`)}</Badge>
                {onRoad && (s.status === "dispatched" || s.status === "in_transit") && allowed("dispatch.deliver") && (
                  <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <Input inputSize="sm" className="w-36" placeholder={t("dispatch.receivedBy")} aria-label={`${t("dispatch.receivedBy")} ${s.customerName}`} value={receivedBy[s.id] ?? ""} onChange={(e) => setReceivedBy((r) => ({ ...r, [s.id]: e.target.value }))} />
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(`stops/${s.id}/deliver`, { status: "delivered", ...(receivedBy[s.id]?.trim() ? { receivedBy: receivedBy[s.id]!.trim() } : {}) }, t("dispatch.deliveredDone"))}>
                      {t("dispatch.markDelivered")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(`stops/${s.id}/deliver`, { status: "returned" }, t("dispatch.returnedDone"))}>
                      {t("dispatch.markReturned")}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ol>
          {trip.loading.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[13px] font-semibold tracking-wide text-ink-3 uppercase">{t("dispatch.loading")}</h3>
              <ul className="num grid grid-cols-1 gap-x-6 text-[13px] sm:grid-cols-2">
                {trip.loading.map((l) => (
                  <li key={l.productId} className="flex justify-between border-b border-line py-1">
                    <span>{l.productName}</span>
                    <span className="font-medium">
                      {number(l.qty, 0)} {l.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <PrintPortal>
            <DispatchSheetDocument trip={trip} />
          </PrintPortal>
        </div>
      ) : null}
    </Dialog>
  );
}
