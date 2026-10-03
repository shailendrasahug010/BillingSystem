import { dec, toAmountString } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { eq, sql } from "drizzle-orm";

export interface PartyEntryInput {
  businessId: string;
  party: { type: "customer"; id: string } | { type: "supplier"; id: string };
  date: string;
  docType: string;
  docId?: string | null;
  docNumber?: string | null;
  /** Exactly one of debit / credit is positive. */
  debit?: string;
  credit?: string;
  narration?: string | null;
  reversesEntryId?: number | null;
  userId: string;
}

/**
 * Appends a party ledger entry and moves the cached balance in the same
 * transaction. Customer balance = receivable (debit - credit); supplier
 * balance = payable (credit - debit).
 */
export async function postPartyEntry(tx: Tx, e: PartyEntryInput): Promise<number> {
  const debit = dec(e.debit ?? 0);
  const credit = dec(e.credit ?? 0);
  const [row] = await tx
    .insert(schema.partyLedgerEntries)
    .values({
      businessId: e.businessId,
      partyType: e.party.type,
      customerId: e.party.type === "customer" ? e.party.id : null,
      supplierId: e.party.type === "supplier" ? e.party.id : null,
      entryDate: e.date,
      docType: e.docType,
      docId: e.docId ?? null,
      docNumber: e.docNumber ?? null,
      debit: toAmountString(debit),
      credit: toAmountString(credit),
      narration: e.narration ?? null,
      reversesEntryId: e.reversesEntryId ?? null,
      createdBy: e.userId,
    })
    .returning({ id: schema.partyLedgerEntries.id });
  if (e.party.type === "customer") {
    await tx
      .update(schema.customers)
      .set({ balance: sql`${schema.customers.balance} + ${toAmountString(debit.minus(credit))}` })
      .where(eq(schema.customers.id, e.party.id));
  } else {
    await tx
      .update(schema.suppliers)
      .set({ balance: sql`${schema.suppliers.balance} + ${toAmountString(credit.minus(debit))}` })
      .where(eq(schema.suppliers.id, e.party.id));
  }
  return row!.id;
}
