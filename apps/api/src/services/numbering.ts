import { financialYearOf, formatDocumentNumber, validateDocumentNumber } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { ApiError } from "../lib/errors.js";

const MASTER_PATTERNS = { customer: "C{SEQ:4}", supplier: "S{SEQ:4}", product: "P{SEQ:5}", employee: "E{SEQ:3}" } as const;
export type MasterKind = keyof typeof MASTER_PATTERNS;

/** Master codes are not per financial year. */
const ALL_YEARS = "ALL";

async function ensureSeries(tx: Tx, businessId: string, docType: string, financialYear: string, fallback: { name: string; pattern: string }) {
  const find = () =>
    tx
      .select()
      .from(schema.documentSeries)
      .where(
        and(
          eq(schema.documentSeries.businessId, businessId),
          eq(schema.documentSeries.docType, docType),
          eq(schema.documentSeries.financialYear, financialYear),
          eq(schema.documentSeries.isDefault, true),
          eq(schema.documentSeries.isActive, true),
          isNull(schema.documentSeries.deviceId),
        ),
      )
      .limit(1);
  const [existing] = await find();
  if (existing) return existing;
  await tx
    .insert(schema.documentSeries)
    .values({ id: uuidv7(), businessId, docType, name: fallback.name, pattern: fallback.pattern, financialYear, isDefault: true })
    .onConflictDoNothing();
  const [created] = await find();
  if (!created) throw new ApiError(409, "SERIES_NOT_AVAILABLE", { docType });
  return created;
}

/** Takes the next number of a series row; the row lock serialises concurrent writers. */
async function take(tx: Tx, seriesId: string): Promise<number> {
  const [row] = await tx
    .update(schema.documentSeries)
    .set({ nextNumber: sql`${schema.documentSeries.nextNumber} + 1` })
    .where(eq(schema.documentSeries.id, seriesId))
    .returning({ taken: sql<number>`${schema.documentSeries.nextNumber} - 1` });
  return Number(row!.taken);
}

/**
 * Next customer / supplier / product code (C0001, S0001, P00001). Codes typed
 * in by hand may already occupy a number, so those are skipped.
 */
export async function nextMasterCode(
  tx: Tx,
  businessId: string,
  kind: MasterKind,
  today: string,
  isTaken: (code: string) => Promise<boolean>,
): Promise<string> {
  const series = await ensureSeries(tx, businessId, kind, ALL_YEARS, { name: `${kind} code`, pattern: MASTER_PATTERNS[kind] });
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = formatDocumentNumber(series.pattern, { seq: await take(tx, series.id), date: today });
    if (!(await isTaken(code))) return code;
  }
  throw new ApiError(409, "CODE_SERIES_EXHAUSTED", { kind });
}

/**
 * Next gap-free document number for the financial year of `date`. A new
 * financial year gets its series automatically, copying last year's pattern.
 */
export async function nextDocumentNumber(
  tx: Tx,
  businessId: string,
  docType: string,
  date: string,
  financialYearStartMonth: number,
  /** Name and pattern for a document type the business has never numbered before. */
  fallback?: { name: string; pattern: string },
): Promise<{ number: string; seriesId: string; financialYear: string }> {
  const fy = financialYearOf(date, financialYearStartMonth).label;
  const [previous] = await tx
    .select({ name: schema.documentSeries.name, pattern: schema.documentSeries.pattern })
    .from(schema.documentSeries)
    .where(
      and(
        eq(schema.documentSeries.businessId, businessId),
        eq(schema.documentSeries.docType, docType),
        eq(schema.documentSeries.isDefault, true),
        isNull(schema.documentSeries.deviceId),
      ),
    )
    .orderBy(desc(schema.documentSeries.financialYear))
    .limit(1);
  const series = await ensureSeries(tx, businessId, docType, fy, previous ?? fallback ?? { name: docType, pattern: `${docType.slice(0, 3).toUpperCase()}/{FYS}/{SEQ:5}` });
  const number = formatDocumentNumber(series.pattern, { seq: await take(tx, series.id), date, financialYearStartMonth });
  const issues = validateDocumentNumber(number);
  if (issues.length) throw new ApiError(409, "INVALID_DOCUMENT_NUMBER", { number, issue: issues[0]! });
  return { number, seriesId: series.id, financialYear: fy };
}

/**
 * A block of master codes for a bulk import: numbers are reserved in one
 * update (then more if some codes are already taken by hand-typed ones).
 */
export async function nextMasterCodes(tx: Tx, businessId: string, kind: MasterKind, today: string, count: number, taken: ReadonlySet<string>): Promise<string[]> {
  const series = await ensureSeries(tx, businessId, kind, ALL_YEARS, { name: `${kind} code`, pattern: MASTER_PATTERNS[kind] });
  const out: string[] = [];
  while (out.length < count) {
    const want = count - out.length;
    const [row] = await tx
      .update(schema.documentSeries)
      .set({ nextNumber: sql`${schema.documentSeries.nextNumber} + ${want}` })
      .where(eq(schema.documentSeries.id, series.id))
      .returning({ first: sql<number>`${schema.documentSeries.nextNumber} - ${want}` });
    for (let seq = Number(row!.first); seq < Number(row!.first) + want; seq++) {
      const code = formatDocumentNumber(series.pattern, { seq, date: today });
      if (!taken.has(code.toUpperCase())) out.push(code);
    }
  }
  return out;
}
