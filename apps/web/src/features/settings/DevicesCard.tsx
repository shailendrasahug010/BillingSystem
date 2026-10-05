import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { DataTable, ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { useConfirm } from "../../components/ui/Confirm";
import { Badge } from "../../components/ui/Badge";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  seriesCode: string | null;
  userName: string;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  revokedAt: string | null;
  wipedAt: string | null;
  offlineBills: number;
  /** Work waiting on the device, as it last reported (it can only while online). */
  queueWaiting: number;
  queueRefused: number;
  queueOldestAt: string | null;
  queueReportedAt: string | null;
}

/** Phones and PCs that keep a copy of the business (those that bill, with their own series); a lost one can be removed. */
export function DevicesCard() {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const canEdit = allowed("settings.update");
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["devices"], queryFn: () => api.get<{ data: DeviceRow[] }>("/devices").then((r) => r.data) });
  const [error, setError] = useState<unknown>(null);

  const revoke = async (d: DeviceRow) => {
    const ok = await confirm({ title: t("offline.devices.removeTitle"), body: t("offline.devices.removeConfirm", { name: d.name, code: d.seriesCode ?? "" }), confirmLabel: t("offline.devices.remove"), danger: true });
    if (!ok) return;
    setError(null);
    try {
      await api.post(`/devices/${d.id}/revoke`);
      await q.refetch();
      toast({ tone: "success", title: t("offline.devices.removedToast"), body: [d.name, d.seriesCode].filter(Boolean).join(" · ") });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };

  return (
    <Card>
      <CardHeader title={t("offline.devices.title")} subtitle={t("offline.devices.help")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error ? <ErrorNote error={error} /> : null}
        <DataTable
          rows={q.data ?? []}
          loading={q.isPending}
          rowKey={(d) => d.id}
          minWidth={680}
          empty={<p className="p-4 text-[13.5px] text-ink-3">{t("offline.devices.empty")}</p>}
          columns={[
            {
              key: "name",
              header: t("offline.devices.name"),
              render: (d) => (
                <span className={d.revokedAt ? "text-ink-3 line-through" : "font-medium text-ink"}>
                  {d.name}
                  <span className="block text-[12px] font-normal text-ink-3 no-underline">{d.userName}</span>
                </span>
              ),
            },
            { key: "series", header: t("offline.devices.series"), render: (d) => (d.seriesCode ? <span className="font-mono">{d.seriesCode}</span> : <span className="text-ink-3">{t("offline.devices.noSeries")}</span>) },
            { key: "seen", header: t("offline.devices.lastSeen"), render: (d) => <span className="text-ink-2">{d.lastSeenAt ? dateTime(d.lastSeenAt) : "—"}</span> },
            { key: "bills", header: t("offline.devices.bills"), align: "right", render: (d) => d.offlineBills },
            {
              key: "waiting",
              header: t("offline.devices.waiting"),
              render: (d) =>
                d.revokedAt || (d.queueWaiting === 0 && d.queueRefused === 0) ? (
                  <span className="text-ink-3">{d.queueReportedAt ? t("offline.devices.allSent") : "—"}</span>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    {d.queueWaiting > 0 && (
                      <span className={d.queueRefused > 0 ? "text-ink-2" : "text-warn"}>
                        {t("offline.devices.waitingSince", { count: d.queueWaiting, when: d.queueOldestAt ? dateTime(d.queueOldestAt) : "—" })}
                      </span>
                    )}
                    {d.queueRefused > 0 && <span className="text-danger">{t("offline.devices.refused", { count: d.queueRefused })}</span>}
                    {d.queueReportedAt && <span className="text-[11.5px] text-ink-3">{t("offline.devices.reportedAt", { when: dateTime(d.queueReportedAt) })}</span>}
                  </span>
                ),
            },
            {
              key: "action",
              header: "",
              align: "right",
              render: (d) =>
                d.revokedAt ? (
                  <span className="flex flex-col items-end gap-0.5">
                    <Badge tone="neutral">{t("offline.devices.removed")}</Badge>
                    <span className="text-[11.5px] text-ink-3">{d.wipedAt ? t("offline.devices.wipedOn", { when: dateTime(d.wipedAt) }) : t("offline.devices.wipePending")}</span>
                  </span>
                ) : canEdit ? (
                  <Button size="sm" variant="ghost" onClick={() => void revoke(d)}>
                    {t("offline.devices.remove")}
                  </Button>
                ) : null,
            },
          ]}
        />
      </div>
    </Card>
  );
}
