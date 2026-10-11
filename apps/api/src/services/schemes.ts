import type { SchemeStatus, SchemeView } from "@digitalbahi/contracts";
import type { SchemeRule } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { inSequence } from "../lib/db.js";

export type SchemeRow = typeof schema.schemes.$inferSelect;

/** A scheme as the engine (core's applySchemes) takes it. */
export function schemeRule(row: SchemeRow): SchemeRule & { name: string } {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    measure: row.measure,
    productIds: row.productIds,
    brandIds: row.brandIds,
    categoryIds: row.categoryIds,
    slabs: row.slabs.map((s) => ({ from: s.from, freeQty: s.freeQty ?? null, discountPercent: s.discountPercent ?? null, discountPerUnit: s.discountPerUnit ?? null })),
    repeat: row.repeat,
    freeProductId: row.freeProductId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    customerCategoryIds: row.customerCategoryIds,
    priceLevelIds: row.priceLevelIds,
    active: row.isActive,
  };
}

export function schemeStatus(row: Pick<SchemeRow, "isActive" | "validFrom" | "validTo">, today: string): SchemeStatus {
  if (!row.isActive) return "off";
  if (row.validFrom > today) return "upcoming";
  if (row.validTo !== null && row.validTo < today) return "ended";
  return "running";
}

/** The schemes running on a day, and any others named (to say why one named is not given). */
export async function schemesOn(tx: Tx, businessId: string, date: string, named: string[] = []): Promise<SchemeRow[]> {
  const s = schema.schemes;
  const running = and(eq(s.isActive, true), lte(s.validFrom, date), or(isNull(s.validTo), gte(s.validTo, date)));
  return tx
    .select()
    .from(s)
    .where(and(eq(s.businessId, businessId), named.length ? or(running, inArray(s.id, named)) : running));
}

/**
 * The schemes a device keeps for billing (with the catalogue and in the pull
 * feed's lists): switched on and not ended by `today`, the coming ones too,
 * so a device offline tomorrow still has tomorrow's.
 */
export async function schemesForDevices(tx: Tx, businessId: string, today: string) {
  const s = schema.schemes;
  const rows = await tx
    .select()
    .from(s)
    .where(and(eq(s.businessId, businessId), eq(s.isActive, true), or(isNull(s.validTo), gte(s.validTo, today))))
    .orderBy(s.name);
  return rows.map(schemeRule);
}

export async function schemeViews(tx: Tx, rows: SchemeRow[], today: string): Promise<SchemeView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const supplierIds = [...new Set(rows.map((r) => r.supplierId).filter((x): x is string => x !== null))];
  const [suppliers, bills] = await inSequence([
    () => (supplierIds.length ? tx.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, supplierIds)) : []),
    () =>
      tx
        .select({ schemeId: schema.invoiceItems.schemeId, bills: sql<number>`count(distinct ${schema.invoiceItems.invoiceId})::int` })
        .from(schema.invoiceItems)
        .innerJoin(schema.invoices, eq(schema.invoices.id, schema.invoiceItems.invoiceId))
        .where(and(inArray(schema.invoiceItems.schemeId, ids), eq(schema.invoices.status, "posted")))
        .groupBy(schema.invoiceItems.schemeId),
  ]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    measure: r.measure,
    productIds: r.productIds,
    brandIds: r.brandIds,
    categoryIds: r.categoryIds,
    slabs: r.slabs.map((s) => ({ from: s.from, freeQty: s.freeQty ?? null, discountPercent: s.discountPercent ?? null, discountPerUnit: s.discountPerUnit ?? null })),
    repeat: r.repeat,
    freeProductId: r.freeProductId,
    validFrom: r.validFrom,
    validTo: r.validTo,
    customerCategoryIds: r.customerCategoryIds,
    priceLevelIds: r.priceLevelIds,
    supplierId: r.supplierId,
    supplierName: suppliers.find((x) => x.id === r.supplierId)?.name ?? null,
    reference: r.reference,
    notes: r.notes,
    isActive: r.isActive,
    status: schemeStatus(r, today),
    bills: Number(bills.find((b) => b.schemeId === r.id)?.bills ?? 0),
  }));
}
