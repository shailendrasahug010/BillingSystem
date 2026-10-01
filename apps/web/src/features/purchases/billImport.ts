import type { BillFileBill, BillFileLine } from "@digitalbahi/core";
import { WORKSPACE } from "../../data/db";
import type { Product } from "../../data/types";

export type MatchedBy = "supplier_item" | "barcode" | "code" | "name";

/** POST /purchases/import/match. */
export interface MatchResponse {
  supplier: { id: string; name: string; code: string; gstin: string | null; matchedBy: "id" | "gstin" | "name" } | null;
  supplierCandidates: Array<{ id: string; name: string; code: string; gstin: string | null; city: string | null }>;
  duplicate: { id: string; purchaseNumber: string | null } | null;
  lines: Array<{ productId: string | null; unitId: string | null; matchedBy: MatchedBy | null; candidates: Array<{ productId: string; name: string; code: string; score: number }> }>;
}

/** One line of the supplier's bill with what it matched. */
export interface ImportedItem {
  key: string;
  file: BillFileLine;
  productId: string | null;
  /** The unit this supplier bills the item in, remembered from an earlier bill. */
  unitId: string | null;
  matchedBy: MatchedBy | null;
  candidates: MatchResponse["lines"][number]["candidates"];
}

/** A supplier's bill read from their file, opened in purchase entry for review. */
export interface PurchaseDraft {
  id: string;
  fileName: string;
  billNumber: string;
  billDate: string | null;
  supplierId: string | null;
  /** What the file says about the supplier, shown when it did not match one of ours. */
  supplierHint: string | null;
  supplierCandidates: MatchResponse["supplierCandidates"];
  duplicate: MatchResponse["duplicate"];
  items: ImportedItem[];
  /** Read from a photo or a scanned PDF. */
  scanned?: boolean;
}

/** Lines the purchase entry screen keeps (a subset of its own line state). */
export interface DraftLine {
  productId: string;
  unitId: string;
  qty: string;
  freeQty: string;
  rate: string;
  discountPercent: string;
  gstRate: string;
  batchNumber: string;
  expiryDate: string;
  mfgDate: string;
  mrp: string;
  supplierItem: { code?: string; name?: string };
  fileRow: number;
}

export function draftFromMatch(fileName: string, bill: BillFileBill, match: MatchResponse, scanned = false): PurchaseDraft {
  return {
    id: crypto.randomUUID(),
    fileName,
    ...(scanned ? { scanned } : {}),
    billNumber: bill.billNumber ?? "",
    billDate: bill.billDate,
    supplierId: match.supplier?.id ?? null,
    supplierHint: match.supplier ? null : [bill.supplierName, bill.supplierGstin].filter(Boolean).join(" · ") || null,
    supplierCandidates: match.supplierCandidates,
    duplicate: match.duplicate,
    items: bill.lines.map((file, i) => {
      const m = match.lines[i];
      return { key: crypto.randomUUID(), file, productId: m?.productId ?? null, unitId: m?.unitId ?? null, matchedBy: m?.matchedBy ?? null, candidates: m?.candidates ?? [] };
    }),
  };
}

/** Unit words bills use for the same thing. */
const UNIT_WORDS = [
  ["PCS", "PC", "PCE", "NOS", "NO", "NUM", "EA", "EACH", "PIECE", "PIECES", "UNIT", "UNITS"],
  // A "case" on FMCG bills is the carton.
  ["CTN", "CARTON", "CARTONS", "CTNS", "CASE", "CS", "CSE", "CASES"],
  ["BOX", "BX", "BOXES"],
  ["KG", "KGS", "KILO", "KILOGRAM"],
  ["LTR", "L", "LT", "LITRE", "LITER", "LTRS"],
  ["DZN", "DOZ", "DOZEN"],
  ["PAC", "PKT", "PACKET", "PKTS", "PACK"],
  ["BTL", "BOTTLE", "BOTTLES"],
  ["GM", "G", "GMS", "GRAM"],
  ["MTR", "M", "METER", "METRE"],
  ["STRIP", "STRIPS", "STP"],
  ["BAG", "BAGS"],
];

export function sameUnit(a: string, b: string): boolean {
  return unitRank(a, b) < Infinity;
}

/** 0 for the same symbol, then by how usual the symbol is for the word ("PIECE" is PCS before NOS). */
function unitRank(symbol: string, written: string): number {
  const x = symbol.trim().toUpperCase();
  const y = written.trim().toUpperCase();
  if (x === y) return 0;
  const group = UNIT_WORDS.find((g) => g.includes(x) && g.includes(y));
  return group ? 1 + group.indexOf(x) : Infinity;
}

/** The unit a word on a bill means, among these units. */
export function unitNamed<T extends { symbol: string }>(units: readonly T[], written: string): T | undefined {
  let best: T | undefined;
  let rank = Infinity;
  for (const u of units) {
    const r = unitRank(u.symbol, written);
    if (r < rank) [best, rank] = [u, r];
  }
  return best;
}

/**
 * The unit a bill line is in: remembered for this supplier, else the unit
 * written on the bill, else (no unit on the bill) the pack whose usual cost
 * is nearest the billed rate, else the stock unit.
 */
export function unitFor(product: Product, item: Pick<ImportedItem, "unitId" | "file">): string {
  const units = [{ unitId: product.unitId ?? "", symbol: product.unit, factor: 1 }, ...(product.packUnits ?? [])];
  if (item.unitId && units.some((u) => u.unitId === item.unitId)) return item.unitId;
  const written = item.file.unit ? unitNamed(units, item.file.unit) : undefined;
  if (written) return written.unitId;
  const rate = Number(item.file.rate ?? 0);
  if (rate > 0 && product.purchasePrice > 0 && units.length > 1) {
    const [best] = units.map((u) => ({ u, gap: Math.abs(Math.log(rate / (product.purchasePrice * u.factor))) })).sort((a, b) => a.gap - b.gap);
    if (best && best.gap < Math.log(1.5)) return best.u.unitId;
  }
  return product.unitId ?? "";
}

const trim = (n: number, d = 4) => String(Math.round(n * 10 ** d) / 10 ** d);

/** A purchase entry line from a bill line and the product picked for it. */
export function lineFromItem(item: Pick<ImportedItem, "unitId" | "file">, product: Product): DraftLine {
  const f = item.file;
  const unitId = unitFor(product, item);
  const factor = unitId === product.unitId ? 1 : (product.packUnits?.find((u) => u.unitId === unitId)?.factor ?? 1);
  return {
    productId: product.id,
    unitId,
    qty: f.qty,
    freeQty: f.freeQty ?? "",
    rate: f.rate ?? (product.purchasePrice ? trim(product.purchasePrice * factor) : ""),
    discountPercent: f.discountPercent ?? "",
    // The GST the supplier charged, as printed: it may be from before a rate change.
    gstRate: f.gstRate ?? "",
    batchNumber: product.trackBatches ? (f.batchNumber ?? "") : "",
    expiryDate: product.trackExpiry || product.trackBatches ? (f.expiryDate ?? "") : "",
    mfgDate: product.trackBatches ? (f.mfgDate ?? "") : "",
    mrp: f.mrp ?? "",
    supplierItem: { ...(f.itemCode ? { code: f.itemCode.slice(0, 60) } : {}), name: f.itemName.slice(0, 200) },
    fileRow: f.row,
  };
}

/** Headers of the sample bill file (any of the usual names also work). */
export const SAMPLE_BILL = [
  ["Bill No", "Bill Date", "Supplier GSTIN", "Item Name", "Item Code", "Barcode", "HSN", "Unit", "Qty", "Free Qty", "Rate", "Disc %", "GST %", "Batch", "Expiry", "MRP"],
  ["SG/1021", "20/09/2026", "23AAACM1234M1ZR", "SURF EXCEL EASY WASH 1KG", "HU-1102", "8901030865278", "3402", "PCS", "24", "", "115", "2", "18", "", "", "140"],
  ["SG/1021", "20/09/2026", "23AAACM1234M1ZR", "PARLE-G 100G", "PA-100", "8901719101045", "1905", "PCS", "240", "12", "8", "", "5", "B2291", "08/27", "10"],
];

/** A product we do not have yet, as the supplier's bill line describes it. */
export interface NewProductGuess {
  name: string;
  hsnCode: string | null;
  taxCategoryId: string | null;
  baseUnitId: string | null;
  /** Per bill unit, before GST. */
  purchasePrice: string | null;
  mrp: string | null;
  barcode: string | null;
  trackBatches: boolean;
  trackExpiry: boolean;
}

/** Bills print names in capitals; a product name reads better in title case. */
export function productNameFrom(itemName: string): string {
  const name = itemName.trim().replace(/\s+/g, " ");
  return /\p{Ll}/u.test(name) ? name : name.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}

/** The GST category for a rate on a bill: the taxable one at that rate, or nil-rated / exempt for 0%. */
export function taxCategoryForRate(gstRate: string | null): string | null {
  if (gstRate === null || gstRate === "") return null;
  const rate = Number(gstRate);
  const cats = WORKSPACE.taxCategories;
  if (rate === 0) return (cats.find((c) => c.kind === "nil_rated") ?? cats.find((c) => c.kind === "exempt"))?.id ?? null;
  return cats.find((c) => c.kind === "taxable" && c.rate === rate)?.id ?? null;
}

export function newProductFrom(item: ImportedItem): NewProductGuess {
  const f = item.file;
  const unit = f.unit ? unitNamed(WORKSPACE.unitList, f.unit) : undefined;
  // Without a unit on the bill, pieces (or numbers) are the usual stock unit.
  const fallback = WORKSPACE.unitList.find((u) => u.symbol === "PCS") ?? WORKSPACE.unitList.find((u) => u.symbol === "NOS") ?? WORKSPACE.unitList[0];
  return {
    name: productNameFrom(f.itemName),
    hsnCode: f.hsnCode && /^\d{4,8}$/.test(f.hsnCode) ? f.hsnCode : null,
    taxCategoryId: taxCategoryForRate(f.gstRate),
    baseUnitId: (unit ?? fallback)?.id ?? null,
    purchasePrice: f.rate,
    mrp: f.mrp,
    barcode: f.barcode && f.barcode.length >= 4 ? f.barcode : null,
    trackBatches: Boolean(f.batchNumber),
    trackExpiry: Boolean(f.expiryDate),
  };
}
