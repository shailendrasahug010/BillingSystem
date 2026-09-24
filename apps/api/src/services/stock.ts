import { applyMovement, dec, directionOf, roundRate, toQtyString, toRateString, type NegativeStockPolicy, type StockCheck, type StockMovementType } from "@vyapaar/core";
import { schema, type Tx } from "@vyapaar/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

export interface StockMovementInput {
  businessId: string;
  productId: string;
  productName: string;
  warehouseId: string;
  batchId?: string | null;
  date: string;
  type: StockMovementType;
  /** Positive quantity in the product's base unit. */
  qty: string;
  unitCost?: string;
  refType: string;
  refId?: string | null;
  refLineId?: string | null;
  refNumber?: string | null;
  reason?: string | null;
  userId: string;
}

export interface StockMovementResult {
  ledgerId: number;
  balanceAfter: string;
  warning: StockCheck | null;
}

/**
 * The only way stock changes: lock the balance row, apply the movement under
 * the negative-stock policy, append the ledger row and update the cached
 * balance, all in the caller's transaction. Callers lock several products in
 * a stable order (sorted ids) to avoid deadlocks.
 */
export async function postStockMovement(tx: Tx, m: StockMovementInput, policy: NegativeStockPolicy): Promise<StockMovementResult> {
  const batchId = m.batchId ?? null;
  await tx
    .insert(schema.stockBalances)
    .values({ id: uuidv7(), businessId: m.businessId, productId: m.productId, warehouseId: m.warehouseId, batchId, qty: "0" })
    .onConflictDoNothing();
  const [balance] = await tx
    .select({ id: schema.stockBalances.id, qty: schema.stockBalances.qty })
    .from(schema.stockBalances)
    .where(
      and(
        eq(schema.stockBalances.businessId, m.businessId),
        eq(schema.stockBalances.productId, m.productId),
        eq(schema.stockBalances.warehouseId, m.warehouseId),
        batchId ? eq(schema.stockBalances.batchId, batchId) : isNull(schema.stockBalances.batchId),
      ),
    )
    .for("update");

  if (directionOf(m.type) === "in" && m.unitCost && dec(m.unitCost).gt(0)) {
    await updateAverageCost(tx, m.businessId, m.productId, m.qty, m.unitCost);
  }

  const applied = applyMovement(balance!.qty, { type: m.type, qty: m.qty }, policy, m.productName);
  const [row] = await tx
    .insert(schema.stockLedger)
    .values({
      businessId: m.businessId,
      productId: m.productId,
      warehouseId: m.warehouseId,
      batchId,
      txnDate: m.date,
      movementType: m.type,
      qtyIn: toQtyString(applied.qtyIn),
      qtyOut: toQtyString(applied.qtyOut),
      balanceAfter: toQtyString(applied.balanceAfter),
      unitCost: toRateString(m.unitCost ?? "0"),
      refType: m.refType,
      refId: m.refId ?? null,
      refLineId: m.refLineId ?? null,
      refNumber: m.refNumber ?? null,
      reason: m.reason ?? null,
      createdBy: m.userId,
    })
    .returning({ id: schema.stockLedger.id });
  await tx
    .update(schema.stockBalances)
    .set({ qty: toQtyString(applied.balanceAfter), lastLedgerId: row!.id, updatedAt: sql`now()` })
    .where(eq(schema.stockBalances.id, balance!.id));
  return { ledgerId: row!.id, balanceAfter: toQtyString(applied.balanceAfter), warning: applied.warning };
}

/**
 * Weighted moving average over all warehouses: stock on hand at the old
 * average plus the receipt at its cost. Negative stock counts as zero.
 */
async function updateAverageCost(tx: Tx, businessId: string, productId: string, inQty: string, unitCost: string): Promise<void> {
  const [row] = await tx
    .select({
      avgCost: schema.products.avgCost,
      onHand: sql<string>`coalesce((select sum(qty) from stock_balances sb where sb.business_id = ${businessId} and sb.product_id = ${productId}), 0)`,
    })
    .from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.businessId, businessId)))
    .for("update");
  if (!row) return;
  const onHand = dec(row.onHand).gt(0) ? dec(row.onHand) : dec(0);
  const total = onHand.plus(inQty);
  const next = total.isZero() ? dec(unitCost) : onHand.times(row.avgCost).plus(dec(inQty).times(unitCost)).dividedBy(total);
  await tx
    .update(schema.products)
    .set({ avgCost: toRateString(roundRate(next)) })
    .where(eq(schema.products.id, productId));
}

/** Total stock of products across warehouses (base unit). */
export async function stockTotals(tx: Tx, businessId: string, productIds: string[]): Promise<Map<string, string>> {
  if (!productIds.length) return new Map();
  const rows = await tx
    .select({ productId: schema.stockBalances.productId, qty: sql<string>`sum(${schema.stockBalances.qty})::text` })
    .from(schema.stockBalances)
    .where(and(eq(schema.stockBalances.businessId, businessId), inArray(schema.stockBalances.productId, productIds)))
    .groupBy(schema.stockBalances.productId);
  return new Map(rows.map((r) => [r.productId, r.qty]));
}
