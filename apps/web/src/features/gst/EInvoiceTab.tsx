import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Field";
import { EmptyState } from "../../components/ui/misc";
import { DataTable, ErrorNote } from "../../components/ui/Page";
import { allowed } from "../../data/db";
import { ApiError } from "../../lib/api";
import { api } from "../../lib/api";
import { downloadPortalFile, EwayBillDialog, IrnDialog, type EwayTarget, type IrnTarget } from "./einvoiceDialogs";

export interface PortalIssue {
  code: string;
  level: "error" | "warning";
  line?: number;
}

interface EInvoiceDoc {
  kind: "invoice" | "credit_note";
  id: string;
  number: string;
  date: string;
  partyName: string;
  partyGstin: string | null;
  value: string;
  supplyType: string;
  irn: string | null;
  ackNumber: string | null;
  ackDate: string | null;
  issues: PortalIssue[];
}

interface EwayDoc {
  id: string;
  number: string;
  date: string;
  partyName: string;
  value: string;
  due: boolean;
  ewayBillNumber: string | null;
  ewayBillDate: string | null;
  validUntil: string | null;
  trip: { id: string; number: string | null; vehicleNumber: string | null } | null;
  issues: PortalIssue[];
}

/** What stops a document (errors) or is worth a look (warnings), in words. */
export function IssueList({ issues }: { issues: PortalIssue[] }) {
  const { t } = useI18n();
  if (!issues.length) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-[12px]">
      {issues.map((i, n) => (
        <li key={n} className={i.level === "error" ? "text-danger" : "text-warn"}>
          {t(`einvoice.issues.${i.code as "HSN_MISSING"}`)}
          {i.line ? ` · ${t("einvoice.line", { line: i.line })}` : ""}
        </li>
      ))}
    </ul>
  );
}

const hasErrors = (issues: PortalIssue[]) => issues.some((i) => i.level === "error");

/**
 * E-invoices and e-way bills for the month: download the portals' JSON for
 * the documents still without an IRN / e-way bill, upload it there, then
 * record the numbers the portals return (they print on the documents).
 */
export function EInvoiceTab({ period }: { period: string }) {
  const { t, money, date } = useI18n();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedEway, setPickedEway] = useState<Set<string>>(new Set());
  const [transport, setTransport] = useState({ vehicleNo: "", distance: "" });
  const [irnFor, setIrnFor] = useState<IrnTarget | null>(null);
  const [ewayFor, setEwayFor] = useState<EwayTarget | null>(null);
  const ok = /^\d{4}-\d{2}$/.test(period);
  const einv = useQuery({ queryKey: ["gst", "einvoice", period], queryFn: () => api.get<{ enabled: boolean; documents: EInvoiceDoc[] }>("/gst/einvoice", { period }), enabled: ok });
  const eway = useQuery({ queryKey: ["gst", "ewaybills", period], queryFn: () => api.get<{ threshold: number; documents: EwayDoc[] }>("/ewaybills", { period }), enabled: ok });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["gst"] });
  const canEdit = allowed("invoice.update");

  const download = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const pickBox = (checked: boolean, disabled: boolean, onChange: () => void, label: string) => (
    <input type="checkbox" aria-label={label} className="size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={onChange} onClick={(e) => e.stopPropagation()} />
  );

  const einvDocs = einv.data?.documents ?? [];
  const openEinv = einvDocs.filter((d) => !d.irn && !hasErrors(d.issues));
  const ewayDocs = eway.data?.documents ?? [];
  const openEway = ewayDocs.filter((d) => !d.ewayBillNumber && !hasErrors(d.issues));
  const [y, m] = period.split("-");

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorNote error={error} /> : null}
      <Card>
        <CardHeader
          title={t("einvoice.title")}
          subtitle={t("einvoice.hint")}
          action={
            einv.data?.enabled ? (
              <Button
                size="sm"
                variant="primary"
                icon={<Download size={14} />}
                disabled={picked.size === 0}
                onClick={() => void download(() => downloadPortalFile("/einvoice/file", { ids: [...picked].join(",") }, `EINV_${m}${y}_${picked.size}.json`))}
              >
                {t("einvoice.downloadJson", { count: picked.size })}
              </Button>
            ) : undefined
          }
        />
        <div className="px-4 pt-3 pb-4 sm:px-5">
          {einv.error ? <ErrorNote error={einv.error} onRetry={() => void einv.refetch()} /> : null}
          {einv.data && !einv.data.enabled ? (
            <p className="text-[13px] text-ink-3">{t("einvoice.off")}</p>
          ) : (
            <>
              {openEinv.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setPicked(new Set(openEinv.map((d) => d.id)))}>
                    {t("einvoice.pickAll", { count: openEinv.length })}
                  </Button>
                  {picked.size > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                      {t("einvoice.pickNone")}
                    </Button>
                  )}
                </div>
              )}
              <DataTable
                rows={einvDocs}
                rowKey={(d) => d.id}
                loading={einv.isPending}
                minWidth={760}
                empty={<EmptyState title={t("einvoice.none")} hint={t("einvoice.noneHint")} />}
                columns={[
                  { key: "pick", header: "", render: (d) => pickBox(picked.has(d.id), Boolean(d.irn) || hasErrors(d.issues), () => setPicked((s) => toggle(s, d.id)), `${t("einvoice.pick")} ${d.number}`) },
                  {
                    key: "doc",
                    header: t("einvoice.document"),
                    render: (d) => (
                      <div>
                        <p className="font-mono text-[13px] font-medium text-ink">{d.number}</p>
                        <p className="text-[12px] text-ink-3">
                          {date(d.date)} · {d.kind === "invoice" ? t("einvoice.kinds.invoice") : t("einvoice.kinds.credit_note")} · {d.supplyType}
                        </p>
                      </div>
                    ),
                  },
                  {
                    key: "party",
                    header: t("einvoice.party"),
                    render: (d) => (
                      <div>
                        <p className="text-ink">{d.partyName}</p>
                        {d.partyGstin && <p className="font-mono text-[11.5px] text-ink-3">{d.partyGstin}</p>}
                      </div>
                    ),
                  },
                  { key: "value", header: t("common.amount"), align: "right", render: (d) => money(d.value) },
                  {
                    key: "status",
                    header: t("common.status"),
                    render: (d) =>
                      d.irn ? (
                        <div className="text-[12px]">
                          <Badge tone="good" icon={<CheckCircle2 size={12} />}>
                            {t("einvoice.irnDone")}
                          </Badge>
                          <p className="mt-1 font-mono text-ink-3">{d.ackNumber}</p>
                        </div>
                      ) : (
                        <div>
                          <Badge tone={hasErrors(d.issues) ? "danger" : "warn"} icon={hasErrors(d.issues) ? <TriangleAlert size={12} /> : undefined}>
                            {hasErrors(d.issues) ? t("einvoice.fixFirst") : t("einvoice.toUpload")}
                          </Badge>
                          <IssueList issues={d.issues} />
                        </div>
                      ),
                  },
                  {
                    key: "act",
                    header: "",
                    align: "right",
                    render: (d) =>
                      canEdit ? (
                        <Button size="sm" onClick={() => setIrnFor({ kind: d.kind, id: d.id, number: d.number, irn: d.irn, ackNumber: d.ackNumber, ackDate: d.ackDate })}>
                          {d.irn ? t("einvoice.changeIrn") : t("einvoice.enterIrn")}
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t("einvoice.ewayTitle")}
          subtitle={eway.data ? t("einvoice.ewayHint", { amount: money(eway.data.threshold) }) : undefined}
          action={
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={14} />}
              disabled={pickedEway.size === 0}
              onClick={() =>
                void download(() =>
                  downloadPortalFile(
                    "/ewaybills/file",
                    { ids: [...pickedEway].join(","), ...(transport.vehicleNo.trim() ? { vehicleNo: transport.vehicleNo.trim() } : {}), ...(transport.distance ? { distance: transport.distance } : {}) },
                    `EWB_${m}${y}_${pickedEway.size}.json`,
                  ),
                )
              }
            >
              {t("einvoice.downloadJson", { count: pickedEway.size })}
            </Button>
          }
        />
        <div className="flex flex-col gap-3 px-4 pt-3 pb-4 sm:px-5">
          {eway.error ? <ErrorNote error={eway.error} onRetry={() => void eway.refetch()} /> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("einvoice.vehicle")} htmlFor="ewb-vehicle" hint={t("einvoice.vehicleHint")}>
              <Input id="ewb-vehicle" maxLength={15} className="[&_input]:font-mono [&_input]:uppercase" placeholder="MP09AB1234" value={transport.vehicleNo} onChange={(e) => setTransport((x) => ({ ...x, vehicleNo: e.target.value.toUpperCase() }))} />
            </Field>
            <Field label={t("einvoice.distance")} htmlFor="ewb-distance" hint={t("einvoice.distanceHint")}>
              <Input id="ewb-distance" inputMode="numeric" maxLength={4} value={transport.distance} onChange={(e) => setTransport((x) => ({ ...x, distance: e.target.value.replace(/\D/g, "") }))} />
            </Field>
          </div>
          {openEway.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setPickedEway(new Set(openEway.map((d) => d.id)))}>
                {t("einvoice.pickAll", { count: openEway.length })}
              </Button>
              {pickedEway.size > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setPickedEway(new Set())}>
                  {t("einvoice.pickNone")}
                </Button>
              )}
            </div>
          )}
          <DataTable
            rows={ewayDocs}
            rowKey={(d) => d.id}
            loading={eway.isPending}
            minWidth={720}
            empty={<EmptyState title={t("einvoice.noEway")} hint={t("einvoice.noEwayHint")} />}
            columns={[
              { key: "pick", header: "", render: (d) => pickBox(pickedEway.has(d.id), Boolean(d.ewayBillNumber) || hasErrors(d.issues), () => setPickedEway((s) => toggle(s, d.id)), `${t("einvoice.pick")} ${d.number}`) },
              {
                key: "doc",
                header: t("einvoice.document"),
                render: (d) => (
                  <div>
                    <p className="font-mono text-[13px] font-medium text-ink">{d.number}</p>
                    <p className="text-[12px] text-ink-3">
                      {date(d.date)} · {d.partyName}
                    </p>
                  </div>
                ),
              },
              { key: "value", header: t("common.amount"), align: "right", render: (d) => money(d.value) },
              { key: "trip", header: t("einvoice.trip"), render: (d) => (d.trip ? <span className="font-mono text-[12.5px]">{d.trip.vehicleNumber ?? d.trip.number}</span> : <span className="text-ink-3">—</span>) },
              {
                key: "status",
                header: t("common.status"),
                render: (d) =>
                  d.ewayBillNumber ? (
                    <div className="text-[12px]">
                      <Badge tone="good" icon={<CheckCircle2 size={12} />}>
                        {d.ewayBillNumber}
                      </Badge>
                    </div>
                  ) : (
                    <div>
                      <Badge tone={hasErrors(d.issues) ? "danger" : "warn"}>{hasErrors(d.issues) ? t("einvoice.fixFirst") : t("einvoice.toGenerate")}</Badge>
                      <IssueList issues={d.issues} />
                    </div>
                  ),
              },
              {
                key: "act",
                header: "",
                align: "right",
                render: (d) =>
                  canEdit ? (
                    <Button size="sm" onClick={() => setEwayFor({ id: d.id, number: d.number, ewayBillNumber: d.ewayBillNumber, ewayBillDate: d.ewayBillDate, validUntil: d.validUntil })}>
                      {d.ewayBillNumber ? t("einvoice.changeEwayBill") : t("einvoice.enterEwayBill")}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </div>
      </Card>
      <IrnDialog target={irnFor} onClose={() => setIrnFor(null)} onSaved={refresh} />
      <EwayBillDialog target={ewayFor} onClose={() => setEwayFor(null)} onSaved={refresh} />
    </div>
  );
}
