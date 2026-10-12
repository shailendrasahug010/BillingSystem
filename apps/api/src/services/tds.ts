import { dec, partyPan, purchaseTds, taxYearOf, type DecimalInput, type PurchaseTds } from "@digitalbahi/core";
import type { Tx } from "@digitalbahi/db";
import { sql } from "drizzle-orm";
import { getSetting } from "./settings.js";

type SupplierForTds = { id: string; pan: string | null; gstin: string | null; stateCode: string; tdsExempt: boolean };

/** Foreign (96) and other territory (97) suppliers are not residents: no TDS on buying from them. */
const NOT_RESIDENT = new Set(["96", "97"]);

/**
 * What the business's TDS rule says for a supplier as of a bill date: whether it applies, the rate and
 * threshold, and what was bought from them in the tax year so far (posted bills, before GST).
 */
export async function purchaseTdsContext(tx: Tx, businessId: string, supplier: SupplierForTds, billDate: string) {
  const rule = await getSetting(tx, businessId, "tds.purchases");
  const applies = rule.enabled && !supplier.tdsExempt && !NOT_RESIDENT.has(supplier.stateCode);
  const year = taxYearOf(billDate);
  const [row] = applies
    ? (
        await tx.execute<{ v: string }>(sql`
          select coalesce(sum(taxable_total), 0)::text as v from purchases
          where business_id = ${businessId} and supplier_id = ${supplier.id} and status = 'posted'
            and supplier_invoice_date between ${year.from}::date and ${year.to}::date`)
      ).rows
    : [{ v: "0" }];
  return {
    enabled: rule.enabled,
    applies,
    exempt: supplier.tdsExempt,
    rate: String(rule.rate),
    noPanRate: String(rule.noPanRate),
    threshold: String(rule.threshold),
    hasPan: partyPan(supplier) !== null,
    taxYear: year.label,
    boughtBefore: dec(row?.v ?? 0).toFixed(2),
  };
}

/**
 * TDS to keep back on a purchase bill of this value (before GST), or null when the rule does not apply.
 * The supplier's row is locked first, so two bills entered together count each other.
 */
export async function tdsOnPurchase(tx: Tx, businessId: string, supplier: SupplierForTds, billDate: string, billValue: DecimalInput): Promise<PurchaseTds | null> {
  await tx.execute(sql`select 1 from suppliers where id = ${supplier.id} for no key update`);
  const c = await purchaseTdsContext(tx, businessId, supplier, billDate);
  if (!c.applies) return null;
  const tds = purchaseTds({ boughtBefore: c.boughtBefore, billValue, hasPan: c.hasPan }, { rate: c.rate, noPanRate: c.noPanRate, threshold: c.threshold });
  return tds.amount.gt(0) ? tds : null;
}
