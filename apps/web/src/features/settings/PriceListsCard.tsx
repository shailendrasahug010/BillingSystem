import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Field";
import { ErrorNote, useFieldError } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { Badge } from "../../components/ui/Badge";
import { allowed, WORKSPACE } from "../../data/db";
import { refreshCatalog } from "../../data/live";
import { touch, useStoreVersion } from "../../data/store";
import { api, ApiError } from "../../lib/api";

/**
 * Selling price lists (Price A / B / C, or Retail, Wholesale...): each
 * customer buys on one. The default list is the product's selling price and
 * is what new customers get; the others have their own price on each product.
 */
export function PriceListsCard() {
  const { t } = useI18n();
  const toast = useToast();
  useStoreVersion();
  const canEdit = allowed("product.update_price");
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldError = useFieldError(error);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshCatalog();
      touch();
      toast({ tone: "success", title: done });
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "generic"));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const rename = async (id: string) => {
    const name = names[id]?.trim();
    if (!name) return;
    if (await run(() => api.patch(`/price-levels/${id}`, { name }), t("priceLists.renamed", { name }))) {
      setNames((n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== id)));
    }
  };
  const add = async () => {
    const name = newName.trim();
    if (await run(() => api.post("/price-levels", { name }), t("priceLists.added", { name }))) setNewName("");
  };

  return (
    <Card>
      <CardHeader title={t("priceLists.title")} subtitle={t("priceLists.hint")} />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {error instanceof ApiError && !error.field ? <ErrorNote error={error} /> : null}
        <ul className="divide-y divide-line rounded-lg border border-line">
          {WORKSPACE.priceLevels.map((l) => {
            const draft = names[l.id];
            const changed = draft !== undefined && draft.trim() !== "" && draft.trim() !== l.name;
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[14px]">
                {canEdit ? (
                  <form
                    className="flex min-w-0 flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (changed) void rename(l.id);
                    }}
                  >
                    <Input aria-label={`${t("priceLists.name")} ${l.name}`} className="max-w-60" value={draft ?? l.name} maxLength={50} onChange={(e) => setNames((n) => ({ ...n, [l.id]: e.target.value }))} />
                    {changed && (
                      <Button size="sm" type="submit" disabled={busy}>
                        {t("common.save")}
                      </Button>
                    )}
                  </form>
                ) : (
                  <span className="font-medium text-ink">{l.name}</span>
                )}
                <span className="flex items-center gap-2">
                  {l.isDefault && <Badge tone="accent">{t("priceLists.default")}</Badge>}
                  {canEdit && !l.isDefault && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.patch(`/price-levels/${l.id}`, { isDefault: true }), t("priceLists.madeDefault", { name: l.name }))}>
                      {t("godowns.makeDefault")}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {canEdit && (
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) void add();
            }}
          >
            <Field label={t("priceLists.newName")} htmlFor="pl-name" error={fieldError("name")}>
              <Input id="pl-name" maxLength={50} placeholder="Price D" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <Button type="submit" disabled={busy || !newName.trim()}>
              {t("priceLists.add")}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
