import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Field";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { Badge } from "../../components/ui/Badge";
import { allowed, WORKSPACE } from "../../data/db";
import { refreshWarehouses } from "../../data/live";
import { useStoreVersion } from "../../data/store";
import { api, ApiError } from "../../lib/api";

/** Godowns: where stock is kept. Purchases, adjustments and transfers pick one; the default is used for billing. */
export function WarehousesCard() {
  const { t } = useI18n();
  const toast = useToast();
  useStoreVersion();
  const canEdit = allowed("settings.update");
  const [form, setForm] = useState({ name: "", code: "", city: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshWarehouses();
      toast({ tone: "success", title: done });
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const ok = await run(() => api.post("/warehouses", { name: form.name.trim(), code: form.code.trim(), ...(form.city.trim() ? { city: form.city.trim() } : {}) }), t("godowns.added"));
    if (ok) setForm({ name: "", code: "", city: "" });
  };

  return (
    <Card>
      <CardHeader title={t("godowns.title")} subtitle={t("godowns.hint")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {WORKSPACE.warehouses.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[14px]">
              <span className="min-w-0">
                <span className="font-medium text-ink">{w.name}</span> <span className="font-mono text-[12px] text-ink-3">{w.code}</span>
                {w.city && <span className="text-[12.5px] text-ink-3"> · {w.city}</span>}
              </span>
              <span className="flex items-center gap-2">
                {w.isDefault && <Badge tone="accent">{t("godowns.default")}</Badge>}
                {!w.isActive && <Badge tone="danger">{t("common.inactive")}</Badge>}
                {canEdit && !w.isDefault && w.isActive && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.patch(`/warehouses/${w.id}`, { isDefault: true }), t("godowns.madeDefault"))}>
                    {t("godowns.makeDefault")}
                  </Button>
                )}
                {canEdit && !w.isDefault && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.patch(`/warehouses/${w.id}`, { isActive: !w.isActive }), t("settings.saved"))}>
                    {w.isActive ? t("users.deactivate") : t("users.activate")}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_120px_1fr_auto]">
            <Field label={t("godowns.name")} htmlFor="wh-name" error={fieldError("name")}>
              <Input id="wh-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label={t("common.code")} htmlFor="wh-code" error={fieldError("code")}>
              <Input id="wh-code" maxLength={20} className="[&_input]:font-mono [&_input]:uppercase" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.replace(/[^A-Za-z0-9/_-]/g, "") }))} />
            </Field>
            <Field label={t("common.city")} htmlFor="wh-city">
              <Input id="wh-city" value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
            </Field>
            <Button disabled={busy || !form.name.trim() || !form.code.trim()} onClick={() => void add()}>
              {t("godowns.add")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
