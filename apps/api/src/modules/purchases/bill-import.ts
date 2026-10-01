import { PurchaseImportMatchBody } from "@digitalbahi/contracts";
import { compactName, normalizeGstin, normalizeSearchText, supplierItemKeys } from "@digitalbahi/core";
import { schema } from "@digitalbahi/db";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { guard } from "../../lib/access.js";
import { withTenant } from "../../lib/db.js";
import type { ApiModule } from "../types.js";

type MatchedBy = "supplier_item" | "barcode" | "code" | "name";

/** True when the two names share a word of three or more letters ("SURF EXL 1KG" / "Surf Excel 1 kg"). */
function sharesWord(a: string, b: string): boolean {
  const words = new Set(normalizeSearchText(a).split(" ").filter((w) => w.length >= 3));
  return normalizeSearchText(b)
    .split(" ")
    .some((w) => words.has(w));
}

/**
 * Importing a supplier's bill: the device reads the file (CSV / Excel) and
 * sends its lines here to be matched. Nothing is saved; the bill is then
 * shown in purchase entry for review, and the matches the user keeps are
 * remembered for this supplier when the bill is saved.
 */
export const purchaseImportModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Supplier by id, GSTIN or exact name (else up to five similar names).
   * Each line: what this supplier's item was matched to before, then barcode,
   * our product code / SKU, then the exact name, local name or alias ignoring
   * case, spaces and punctuation; else up to three similar product names.
   */
  r.post("/purchases/import/match", { preHandler: guard(deps, "purchase.create"), schema: { tags: ["purchases"], body: PurchaseImportMatchBody } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    return withTenant(deps.db, ctx, async (tx) => {
      const s = schema.suppliers;
      const live = and(eq(s.businessId, ctx.businessId), isNull(s.deletedAt));
      const cols = { id: s.id, code: s.code, name: s.name, gstin: s.gstin, city: s.city, stateCode: s.stateCode, gstRegistration: s.gstRegistration };
      type SupplierRow = { id: string; code: string; name: string; gstin: string | null; city: string | null; stateCode: string; gstRegistration: string };
      let supplier: SupplierRow | undefined;
      let supplierMatchedBy: "id" | "gstin" | "name" | null = null;
      let supplierCandidates: SupplierRow[] = [];
      if (body.supplierId) {
        [supplier] = await tx.select(cols).from(s).where(and(live, eq(s.id, body.supplierId)));
        if (supplier) supplierMatchedBy = "id";
      }
      if (!supplier && body.supplierGstin) {
        [supplier] = await tx.select(cols).from(s).where(and(live, eq(s.gstin, normalizeGstin(body.supplierGstin)))).limit(1);
        if (supplier) supplierMatchedBy = "gstin";
      }
      if (!supplier && body.supplierName) {
        const q = body.supplierName;
        const similar = await tx
          .select(cols)
          .from(s)
          .where(and(live, sql`(${s.name} % ${q} or lower(${s.name}) = lower(${q}) or lower(${s.companyName}) = lower(${q}))`))
          .orderBy(desc(sql`similarity(${s.name}, ${q})`))
          .limit(5);
        supplier = similar.find((x) => compactName(x.name) === compactName(q));
        if (supplier) supplierMatchedBy = "name";
        else supplierCandidates = similar;
      }

      let duplicate: { id: string; purchaseNumber: string | null } | null = null;
      if (supplier && body.billNumber) {
        const p = schema.purchases;
        [duplicate = null] = await tx
          .select({ id: p.id, purchaseNumber: p.purchaseNumber })
          .from(p)
          .where(and(eq(p.businessId, ctx.businessId), eq(p.supplierId, supplier.id), ne(p.status, "cancelled"), sql`upper(${p.supplierInvoiceNumber}) = upper(${body.billNumber})`))
          .limit(1);
      }

      const p = schema.products;
      const catalog = await tx
        .select({ id: p.id, name: p.name, nameLocal: p.nameLocal, aliases: p.aliases, code: p.code, sku: p.sku })
        .from(p)
        .where(and(eq(p.businessId, ctx.businessId), isNull(p.deletedAt), eq(p.isActive, true)));
      const productName = new Map(catalog.map((x) => [x.id, x.name]));
      const byCode = new Map<string, string>();
      // A name shared by two products is ambiguous: offered as a choice, never matched on its own.
      const byName = new Map<string, string | null>();
      for (const x of catalog) {
        byCode.set(x.code.toUpperCase(), x.id);
        if (x.sku && !byCode.has(x.sku.toUpperCase())) byCode.set(x.sku.toUpperCase(), x.id);
        for (const n of new Set([x.name, x.nameLocal, ...(x.aliases ?? [])].filter((v): v is string => Boolean(v)).map(compactName))) {
          if (!n) continue;
          byName.set(n, byName.has(n) && byName.get(n) !== x.id ? null : x.id);
        }
      }
      const barcodes = [...new Set(body.lines.map((l) => l.barcode).filter((b): b is string => Boolean(b)))];
      const byBarcode = new Map(
        barcodes.length
          ? (
              await tx
                .select({ barcode: schema.productBarcodes.barcode, productId: schema.productBarcodes.productId })
                .from(schema.productBarcodes)
                .where(and(eq(schema.productBarcodes.businessId, ctx.businessId), inArray(schema.productBarcodes.barcode, barcodes)))
            ).map((b) => [b.barcode, b.productId])
          : [],
      );
      const lineKeys = body.lines.map((l) => supplierItemKeys({ code: l.itemCode, name: l.itemName }));
      const allKeys = [...new Set(lineKeys.flat())];
      const remembered = new Map<string, { productId: string; unitId: string | null }>();
      if (supplier && allKeys.length) {
        const si = schema.supplierItems;
        const rows = await tx
          .select({ itemKey: si.itemKey, productId: si.productId, unitId: si.unitId })
          .from(si)
          .where(and(eq(si.businessId, ctx.businessId), eq(si.supplierId, supplier.id), inArray(si.itemKey, allKeys)));
        for (const row of rows) if (productName.has(row.productId)) remembered.set(row.itemKey, { productId: row.productId, unitId: row.unitId });
      }

      const lines = body.lines.map((l, i) => {
        const memory = lineKeys[i]!.map((k) => remembered.get(k)).find(Boolean);
        if (memory) return { productId: memory.productId, unitId: memory.unitId, matchedBy: "supplier_item" as MatchedBy };
        const viaBarcode = l.barcode ? byBarcode.get(l.barcode) : undefined;
        if (viaBarcode && productName.has(viaBarcode)) return { productId: viaBarcode, unitId: null, matchedBy: "barcode" as MatchedBy };
        const viaCode = l.itemCode ? byCode.get(l.itemCode.toUpperCase()) : undefined;
        // A supplier's own code can equal an unrelated code of ours: only trust it when the names agree too.
        if (viaCode && sharesWord(l.itemName, productName.get(viaCode)!)) return { productId: viaCode, unitId: null, matchedBy: "code" as MatchedBy };
        const viaName = byName.get(compactName(l.itemName));
        if (viaName) return { productId: viaName, unitId: null, matchedBy: "name" as MatchedBy };
        return { productId: null, unitId: null, matchedBy: null };
      });

      const unmatched = lines.flatMap((l, i) => (l.productId ? [] : [i]));
      const candidates = new Map<number, Array<{ productId: string; name: string; code: string; score: number }>>();
      if (unmatched.length) {
        const names = unmatched.map((i) => body.lines[i]!.itemName);
        const res = await tx.execute<{ idx: string; id: string; name: string; code: string; score: number }>(sql`
          select l.idx, c.id, c.name, c.code, c.score
          from unnest(${sql.param(names)}::text[]) with ordinality as l(q, idx)
          cross join lateral (
            select p.id, p.name, p.code, round(similarity(p.name, l.q)::numeric, 2)::float8 as score
            from products p
            where p.business_id = ${ctx.businessId} and p.deleted_at is null and p.is_active and p.name % l.q
            order by similarity(p.name, l.q) desc, p.name
            limit 3
          ) c
          order by l.idx, c.score desc`);
        for (const row of res.rows) {
          const line = unmatched[Number(row.idx) - 1]!;
          candidates.set(line, [...(candidates.get(line) ?? []), { productId: row.id, name: row.name, code: row.code, score: Number(row.score) }]);
        }
      }

      return {
        supplier: supplier ? { ...supplier, matchedBy: supplierMatchedBy } : null,
        supplierCandidates,
        duplicate,
        lines: lines.map((l, i) => ({ ...l, candidates: l.productId ? [] : (candidates.get(i) ?? []) })),
      };
    });
  });
};
