import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { PRODUCTS } from "./db";
import { fetchInsight } from "./live";
import { LIVE } from "./source";
import { customerInsight, setLiveInsight, useStoreVersion, type CustomerInsight } from "./store";

/**
 * A customer's buying and payment picture. Demo mode computes it from the
 * sample invoices; live mode fetches /customers/:id/insight once (cached) and
 * shows the quick balance-only version meanwhile.
 */
export function useCustomerInsight(customerId: string | null): CustomerInsight | null {
  useStoreVersion();
  useQuery({
    queryKey: ["insight", customerId],
    queryFn: async () => {
      const insight = await fetchInsight(customerId!);
      setLiveInsight(customerId!, insight);
      return true;
    },
    enabled: LIVE && Boolean(customerId),
    staleTime: 60_000,
  });
  return customerId ? customerInsight(customerId) : null;
}

/** The catalogue prepared for @digitalbahi/core product search; follows workspace updates. */
export function useSearchableProducts() {
  const version = useStoreVersion();
  return useMemo(
    () =>
      PRODUCTS.map((p) => ({
        ...p,
        barcodes: p.barcodes ?? [p.barcode],
        aliases: [p.nameHi, ...p.aliases],
        sku: p.code,
        active: p.active ?? true,
        inStock: p.stock > 0,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
}
