import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, sql } from "drizzle-orm";

/** True when the GST return period of `date` is locked or filed: documents dated in it can no longer change. */
export async function periodLocked(tx: Tx, businessId: string, date: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.gstReturnPeriods.id })
    .from(schema.gstReturnPeriods)
    .where(
      and(
        eq(schema.gstReturnPeriods.businessId, businessId),
        eq(schema.gstReturnPeriods.period, date.slice(0, 7)),
        sql`${schema.gstReturnPeriods.status} in ('locked', 'filed')`,
      ),
    );
  return Boolean(row);
}
