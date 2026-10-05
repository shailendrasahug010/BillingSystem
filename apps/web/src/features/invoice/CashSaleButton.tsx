import { Banknote } from "lucide-react";
import { useState } from "react";
import { translateError } from "@digitalbahi/i18n";
import { useI18n } from "../../app/i18n";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { allowed } from "../../data/db";
import { LIVE } from "../../data/source";
import { ApiError } from "../../lib/api";
import { cashSaleCustomer, findCashSale } from "./cashSale";

/** A walk-in bill in one tap: the counter customer, made the first time it is needed. */
export function CashSaleButton({ onPicked, large = false }: { onPicked(id: string): void; large?: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!findCashSale() && !(LIVE && allowed("customer.create"))) return null;
  return (
    <Button
      size={large ? "md" : "sm"}
      className={large ? "min-h-12 w-full justify-center" : undefined}
      icon={<Banknote size={16} />}
      disabled={busy}
      title={t("invoice.cashSaleHint")}
      onClick={async () => {
        setBusy(true);
        try {
          onPicked(await cashSaleCustomer());
        } catch (e) {
          toast({ tone: "danger", title: translateError(i18n, e instanceof ApiError ? e : new ApiError(0, "generic")) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {t("invoice.cashSale")}
    </Button>
  );
}
