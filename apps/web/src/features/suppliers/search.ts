import { normalizeSearchText } from "@vyapaar/core";
import { SUPPLIERS, type Supplier } from "../../data/db";

/** Local supplier search: name, company, code, city, GSTIN or mobile. */
export function searchSuppliers(query: string, limit = 8): Supplier[] {
  const q = normalizeSearchText(query);
  if (!q) return SUPPLIERS.slice(0, limit);
  const digits = query.replace(/\D/g, "");
  return SUPPLIERS.map((s) => {
    const hay = normalizeSearchText(`${s.companyName ?? ""} ${s.name} ${s.city ?? ""} ${s.code}`);
    let score = 0;
    if (s.gstin && s.gstin.toLowerCase() === query.trim().toLowerCase()) score = 1000;
    else if (digits.length >= 4 && (s.mobile ?? "").includes(digits)) score = 800;
    else if (s.code.toLowerCase() === q) score = 700;
    else if (normalizeSearchText(s.name).startsWith(q) || normalizeSearchText(s.companyName ?? "").startsWith(q)) score = 300;
    else if (hay.includes(q)) score = 100;
    return { s, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((x) => x.s);
}

/** The name the business calls the supplier by (the legal name, when different, is printed on purchase records). */
export const supplierLabel = (s: Supplier) => s.name;
