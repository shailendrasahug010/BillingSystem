import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { WORKSPACE } from "../../data/db";
import { LIVE } from "../../data/source";
import { api } from "../../lib/api";
import { offlineScope } from "../../offline/sync";

/**
 * Godowns (warehouses) on bills and returns: the business's default one
 * unless another is picked; this device remembers the last one picked per
 * business, so a counter that sells from the back godown keeps doing so.
 */
export type Godown = (typeof WORKSPACE.warehouses)[number];

/** The godowns goods can leave from or come back into, the default first. */
export function godowns(): Godown[] {
  return WORKSPACE.warehouses.filter((w) => w.isActive).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/** More than one godown: the screens offer the choice. */
export const pickGodown = () => godowns().length > 1;

export const defaultGodownId = (): string | null => godowns().find((w) => w.isDefault)?.id ?? godowns()[0]?.id ?? null;

const key = () => `godown:${offlineScope()?.businessId ?? "local"}`;

/** The godown this device last billed from (when it is still there), else the default. */
export function lastGodownId(): string | null {
  try {
    const id = localStorage.getItem(key());
    if (id && godowns().some((w) => w.id === id)) return id;
  } catch {
    // Storage blocked: the default it is.
  }
  return defaultGodownId();
}

export function rememberGodown(id: string | null): void {
  try {
    if (id && id !== defaultGodownId()) localStorage.setItem(key(), id);
    else localStorage.removeItem(key());
  } catch {
    // Storage full or blocked: the next bill starts from the default godown.
  }
}

/**
 * What each product has in one godown, for a bill taking goods from it: a
 * map of product id to stock (base units), or null while unknown (the totals
 * across godowns are shown meanwhile). Only fetched when there is a choice.
 */
export function useGodownStock(warehouseId: string | null): Map<string, number> | null {
  const q = useQuery({
    queryKey: ["godown-stock", warehouseId],
    queryFn: () => api.get<{ data: Array<{ productId: string; qty: string }> }>(`/warehouses/${warehouseId}/stock`),
    enabled: LIVE && Boolean(warehouseId) && pickGodown(),
    staleTime: 30_000,
  });
  return useMemo(() => (q.data ? new Map(q.data.data.map((r) => [r.productId, Number(r.qty)])) : null), [q.data]);
}
