import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { DataTable, ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { api, ApiError } from "../../lib/api";

interface Series {
  id: string;
  docType: string;
  name: string;
  financialYear: string;
  pattern: string;
  nextNumber: number;
  isActive: boolean;
}

export function SeriesCard() {
  const { t } = useI18n();
  const toast = useToast();
  const canEdit = allowed("settings.update");
  const q = useQuery({ queryKey: ["document-series"], queryFn: () => api.get<{ data: Series[] }>("/document-series").then((r) => r.data) });
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);

  const save = async (s: Series) => {
    setError(null);
    try {
      await api.patch(`/document-series/${s.id}`, { pattern: editing[s.id] });
      await q.refetch();
      setEditing(({ [s.id]: _, ...rest }) => rest);
      toast({ tone: "success", title: t("settings.saved"), body: s.name });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
    }
  };

  return (
    <Card>
      <CardHeader title={t("settings.series")} subtitle={t("settings.seriesHint")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error ? <ErrorNote error={error} /> : null}
        <DataTable
          rows={q.data ?? []}
          loading={q.isPending}
          rowKey={(s) => s.id}
          minWidth={560}
          columns={[
            { key: "name", header: t("common.name"), render: (s) => <span className="font-medium text-ink">{s.name}</span> },
            { key: "fy", header: t("settings.financialYear"), render: (s) => <span className="text-ink-2">{s.financialYear}</span> },
            {
              key: "pattern",
              header: t("settings.pattern"),
              render: (s) =>
                canEdit ? (
                  <div className="flex items-center gap-2">
                    <Input
                      inputSize="sm"
                      aria-label={`${t("settings.pattern")} ${s.name}`}
                      className="w-48 [&_input]:font-mono"
                      value={editing[s.id] ?? s.pattern}
                      onChange={(e) => setEditing((x) => ({ ...x, [s.id]: e.target.value }))}
                    />
                    {editing[s.id] !== undefined && editing[s.id] !== s.pattern && (
                      <Button size="sm" variant="primary" onClick={() => void save(s)}>
                        {t("common.save")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <span className="font-mono">{s.pattern}</span>
                ),
            },
            { key: "next", header: t("settings.nextNumber"), align: "right", render: (s) => s.nextNumber },
          ]}
        />
        <p className="text-[12.5px] text-ink-3">{t("settings.patternHint")}</p>
      </div>
    </Card>
  );
}
