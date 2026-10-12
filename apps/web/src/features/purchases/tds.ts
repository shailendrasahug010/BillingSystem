import { useQuery } from "@tanstack/react-query";
import { purchaseTds, type Dec, type PurchaseTds } from "@digitalbahi/core";
import { LIVE } from "../../data/source";
import { api } from "../../lib/api";
import { useOffline } from "../../offline/sync";

/** The business's TDS rule for a supplier (GET /suppliers/:id/tds): whether it applies, and the year's purchases so far. */
export interface SupplierTds {
  enabled: boolean;
  applies: boolean;
  exempt: boolean;
  rate: string;
  noPanRate: string;
  threshold: string;
  hasPan: boolean;
  taxYear: string;
  boughtBefore: string;
}

/** The TDS rule for a bill from this supplier on this date; null offline, before a supplier is chosen, or while loading. */
export function useSupplierTds(supplierId: string | null, billDate: string): SupplierTds | null {
  const offline = useOffline();
  const q = useQuery({
    queryKey: ["supplier-tds", supplierId, billDate],
    queryFn: () => api.get<SupplierTds>(`/suppliers/${supplierId}/tds`, { date: billDate }),
    enabled: LIVE && Boolean(supplierId) && offline.online && !offline.offlineMode && /^\d{4}-\d{2}-\d{2}$/.test(billDate),
    staleTime: 60_000,
  });
  return q.data ?? null;
}

/** What the server will keep back on a bill of this value (before GST), as the bill screen shows it; null when nothing. */
export function tdsEstimate(rule: SupplierTds | null, billValue: Dec | null | undefined): PurchaseTds | null {
  if (!rule?.applies || !billValue) return null;
  const tds = purchaseTds({ boughtBefore: rule.boughtBefore, billValue, hasPan: rule.hasPan }, { rate: rule.rate, noPanRate: rule.noPanRate, threshold: rule.threshold });
  return tds.amount.gt(0) ? tds : null;
}
