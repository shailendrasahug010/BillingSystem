import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, RefreshCw, Store } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../app/i18n";
import { WhatsAppIcon } from "../../components/brand/WhatsAppIcon";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/Confirm";
import { Dialog } from "../../components/ui/Dialog";
import { Input } from "../../components/ui/Field";
import { ErrorNote } from "../../components/ui/Page";
import { useToast } from "../../components/ui/Toast";
import { BUSINESS } from "../../data/db";
import { api } from "../../lib/api";
import { shareOnWhatsApp } from "../../lib/share";
import { serverOrigin } from "../../platform/server";

interface LinkState {
  key: string | null;
  createdAt?: string;
  lastUsedAt?: string | null;
  ordersPlaced?: number;
}

/** The address a shop opens: this server's own web app at its order page. */
export const orderLinkUrl = (key: string) => `${serverOrigin() || window.location.origin}/#shop/${key}`;

/**
 * "Order link" on a customer: a private page for the shop to see its rates
 * and order from its phone, sent on WhatsApp. A new link stops the old one.
 */
export function OrderLinkButton({ customerId, customerName, mobile }: { customerId: string; customerName: string; mobile: string | null }) {
  const { t, dateTime } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const key = ["order-link", customerId];
  const link = useQuery({ queryKey: key, queryFn: () => api.get<LinkState>(`/customers/${customerId}/order-link`), enabled: open });
  const make = useMutation({
    mutationFn: () => api.post<LinkState>(`/customers/${customerId}/order-link`),
    onSuccess: (r) => qc.setQueryData(key, r),
  });
  const off = useMutation({
    mutationFn: () => api.delete(`/customers/${customerId}/order-link`),
    onSuccess: () => {
      qc.setQueryData(key, { key: null });
      toast({ tone: "success", title: t("orderLink.turnedOff", { name: customerName }) });
    },
  });
  const current = link.data?.key ? link.data : null;
  const url = current?.key ? orderLinkUrl(current.key) : "";
  const message = t("orderLink.message", { name: customerName, business: BUSINESS.name, url });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ tone: "success", title: t("orderLink.copied") });
    } catch {
      toast({ tone: "danger", title: t("orderLink.copyFailed") });
    }
  };

  return (
    <>
      <Button
        icon={<Link2 size={16} />}
        onClick={() => {
          // Orders placed since it was last open: counted afresh.
          void qc.invalidateQueries({ queryKey: key });
          setOpen(true);
        }}
        title={t("orderLink.hint")}
      >
        {t("orderLink.button")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t("orderLink.title", { name: customerName })}
        description={t("orderLink.hint")}
        closeLabel={t("common.close")}
        footer={
          current ? (
            <>
              <Button variant="ghost" disabled={off.isPending} onClick={() => void confirm({ title: t("orderLink.offTitle"), body: t("orderLink.offBody", { name: customerName }), confirmLabel: t("orderLink.off"), danger: true }).then((yes) => yes && off.mutate())}>
                {t("orderLink.off")}
              </Button>
              <Button variant="primary" icon={<WhatsAppIcon size={16} />} onClick={() => shareOnWhatsApp(message, mobile)}>
                {t("orderLink.send")}
              </Button>
            </>
          ) : (
            <Button variant="primary" icon={<Link2 size={16} />} disabled={make.isPending || link.isPending} onClick={() => make.mutate()}>
              {make.isPending ? t("common.saving") : t("orderLink.make")}
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-4">
          <ErrorNote error={link.error ?? make.error ?? off.error} />
          {link.isPending ? (
            <p className="text-[13px] text-ink-3" role="status">
              {t("common.loading")}
            </p>
          ) : current ? (
            <>
              <div className="flex gap-2">
                <Input readOnly aria-label={t("orderLink.address")} value={url} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 [&_input]:font-mono [&_input]:text-[12.5px]" data-order-link />
                <Button icon={<Copy size={15} />} onClick={() => void copy()}>
                  {t("orderLink.copy")}
                </Button>
              </div>
              <p className="text-[12.5px] text-ink-3">
                {t("orderLink.made", { date: dateTime(current.createdAt!) })}
                {" · "}
                {t("orderLink.placed", { count: current.ordersPlaced ?? 0 })}
                {current.lastUsedAt ? ` · ${t("orderLink.lastOrder", { date: dateTime(current.lastUsedAt) })}` : ""}
              </p>
              <button
                type="button"
                className="press inline-flex items-center gap-1.5 self-start text-[13px] text-accent hover:underline"
                disabled={make.isPending}
                onClick={() => void confirm({ title: t("orderLink.newTitle"), body: t("orderLink.newBody"), confirmLabel: t("orderLink.new") }).then((yes) => yes && make.mutate())}
              >
                <RefreshCw size={14} aria-hidden />
                {t("orderLink.new")}
              </button>
            </>
          ) : (
            <div className="flex items-start gap-3 rounded-xl bg-accent-soft px-3.5 py-3 text-[13px] text-accent-ink">
              <Store size={18} className="mt-0.5 shrink-0" aria-hidden />
              <p>{t("orderLink.about")}</p>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
