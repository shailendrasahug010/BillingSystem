import type { Tx } from "@vyapaar/db";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { badRequest } from "../lib/errors.js";

interface OwnedTable {
  id: PgColumn;
  businessId: PgColumn;
  deletedAt?: PgColumn;
}

/**
 * Foreign-key checks in PostgreSQL ignore row-level security, so an id from
 * another tenant would satisfy a plain FK. Every id a client sends is checked
 * here against the current business before it is stored.
 */
export async function assertOwned(
  tx: Tx,
  table: PgTable & OwnedTable,
  businessId: string,
  id: string | null | undefined,
  field: string,
): Promise<void> {
  if (!id) return;
  const where: SQL[] = [eq(table.id, id), eq(table.businessId, businessId)];
  if (table.deletedAt) where.push(isNull(table.deletedAt));
  const rows = await tx.select({ id: table.id }).from(table).where(and(...where)).limit(1);
  if (!rows.length) throw badRequest("REFERENCE_NOT_FOUND", {}, field);
}
