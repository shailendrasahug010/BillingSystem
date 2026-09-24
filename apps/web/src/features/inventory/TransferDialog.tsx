import { useQueryClient } from "@tanstack/react-query";
import { searchProducts } from "@vyapaar/core";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../app/i18n";
import { Button, IconButton } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { SearchSelect } from "../../components/ui/SearchSelect";
import { useToast } from "../../components/ui/Toast";
import { productById, TODAY, WORKSPACE } from "../../data/db";
import { useSearchableProducts } from "../../data/hooks";
import { api, ApiError } from "../../lib/api";

const QTY = /^\d{1,12}(\.\d{1,3})?$/;

/** Move stock from one godown to another (e.g. main godown to the shop counter). */
export function TransferDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const { t, number } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const searchable = useSearchableProducts();
  const godowns = WORKSPACE.warehouses.filter((w) => w.isActive);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [date, setDate] = useState(TODAY);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Array<{ productId: string; qty: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    const main = godowns.find((w) => w.isDefault) ?? godowns[0];
    setFrom(main?.id ?? "");
    setTo(godowns.find((w) => w.id !== main?.id)?.id ?? "");
    setDate(TODAY);
    setNotes("");
    setLines([]);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ready = from && to && from !== to && lines.length > 0 && lines.every((l) => QTY.test(l.qty) && Number(l.qty) > 0);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ transferNumber: string; lines: unknown[] }>("/stock/transfers", {
        fromWarehouseId: from,
        toWarehouseId: to,
        transferDate: date,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      });
      void qc.invalidateQueries({ queryKey: ["stock"] });
      toast({ tone: "success", title: t("godowns.transferred"), body: `${res.transferNumber} · ${t("common.items", { count: res.lines.length })}` });
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
      title={t("godowns.transfer")}
      size="lg"
      closeLabel={t("common.close")}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label={t("godowns.from")} htmlFor="tr-from">
            <Select id="tr-from" value={from} onChange={(e) => setFrom(e.target.value)}>
              {godowns.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("godowns.to")} htmlFor="tr-to" error={from && from === to ? t("errors.TRANSFER_SAME_GODOWN") : null}>
            <Select id="tr-to" value={to} onChange={(e) => setTo(e.target.value)}>
              {godowns.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("common.date")} htmlFor="tr-date">
            <Input id="tr-date" type="date" max={TODAY} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <SearchSelect
          value={null}
          onChange={(id) => id && !lines.some((l) => l.productId === id) && setLines((ls) => [...ls, { productId: id, qty: "" }])}
          placeholder={t("invoice.searchProduct")}
          clearLabel={t("common.clear")}
          emptyText={t("empty.products")}
          search={(q) => (q.trim() ? searchProducts(q, searchable, { limit: 8 }).map((h) => h.product) : []).map((p) => ({ id: p.id, label: p.name, sub: p.code, trailing: `${number(p.stock)} ${p.unit}` }))}
        />
        {lines.length > 0 && (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {lines.map((l) => {
              const p = productById.get(l.productId);
              return (
                <li key={l.productId} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{p?.name}</span>
                  <Input
                    inputSize="sm"
                    inputMode="decimal"
                    aria-label={`${t("invoice.qty")} ${p?.name ?? ""}`}
                    placeholder={p?.unit}
                    className="w-28 [&_input]:text-right"
                    value={l.qty}
                    onChange={(e) => setLines((ls) => ls.map((x) => (x.productId === l.productId ? { ...x, qty: e.target.value.trim() } : x)))}
                  />
                  <IconButton label={t("invoice.remove")} onClick={() => setLines((ls) => ls.filter((x) => x.productId !== l.productId))}>
                    <Trash2 size={16} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
        <Field label={t("common.notes")} htmlFor="tr-notes" hint={t("common.optional")}>
          <Input id="tr-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
