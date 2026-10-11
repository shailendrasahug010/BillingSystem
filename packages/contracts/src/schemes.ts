import { z } from "zod";
import { Id, IsoDate, Money, patchOf, Percent, Qty } from "./common.js";

/** A slab: from so much (stock units, or rupees for a scheme counted by value), so much free or so much off. */
export const SchemeSlabInput = z.strictObject({
  from: Qty,
  /** Free goods: stock units of the free product. */
  freeQty: Qty.optional(),
  /** Discount: percent off the scheme's products, and/or rupees off each stock unit. */
  discountPercent: Percent.optional(),
  discountPerUnit: Money.optional(),
});

/**
 * A trade scheme. On products, brands or categories (any of them); free
 * goods of a named product (the scheme's products counted together), or of
 * each product bought (counted on its own); discounts by slab. Runs from its
 * first day to its last (none: until switched off), for every customer or
 * those of some categories or rate lists.
 */
export const SchemeBody = z.strictObject({
  name: z.string().trim().min(2).max(120),
  kind: z.enum(["free_goods", "discount"]),
  measure: z.enum(["qty", "value"]).default("qty"),
  productIds: z.array(Id).max(500).default([]),
  brandIds: z.array(Id).max(100).default([]),
  categoryIds: z.array(Id).max(100).default([]),
  slabs: z.array(SchemeSlabInput).min(1).max(10),
  repeat: z.boolean().default(true),
  freeProductId: Id.nullable().default(null),
  validFrom: IsoDate,
  validTo: IsoDate.nullable().default(null),
  customerCategoryIds: z.array(Id).max(50).default([]),
  priceLevelIds: z.array(Id).max(50).default([]),
  /** The company that pays for it (whom the claim goes to), and its own code for the scheme. */
  supplierId: Id.nullable().default(null),
  reference: z.string().trim().max(60).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type SchemeBody = z.infer<typeof SchemeBody>;

export const SchemePatch = patchOf(SchemeBody).extend({ isActive: z.boolean().optional() });

export const SchemeListQuery = z.object({
  /** running: in force today; upcoming: starts later; ended: past its last day or switched off. */
  status: z.enum(["running", "upcoming", "ended", "all"]).default("all"),
  q: z.string().trim().max(100).optional(),
});

export type SchemeStatus = "running" | "upcoming" | "ended" | "off";

export interface SchemeView {
  id: string;
  name: string;
  kind: "free_goods" | "discount";
  measure: "qty" | "value";
  productIds: string[];
  brandIds: string[];
  categoryIds: string[];
  slabs: Array<{ from: string; freeQty: string | null; discountPercent: string | null; discountPerUnit: string | null }>;
  repeat: boolean;
  freeProductId: string | null;
  validFrom: string;
  validTo: string | null;
  customerCategoryIds: string[];
  priceLevelIds: string[];
  supplierId: string | null;
  supplierName: string | null;
  reference: string | null;
  notes: string | null;
  isActive: boolean;
  status: SchemeStatus;
  /** Bills it was given on so far. */
  bills: number;
}

export const SchemeClaimQuery = z.object({
  from: IsoDate,
  to: IsoDate,
  schemeId: Id.optional(),
  supplierId: Id.optional(),
});

/**
 * What a scheme cost over a period, to claim from the company: goods given
 * free (at cost, and at the bills' rates) and discounts given, net of what
 * customers returned. Cancelled bills do not count.
 */
export interface SchemeClaimRow {
  schemeId: string;
  name: string;
  kind: "free_goods" | "discount";
  reference: string | null;
  supplierId: string | null;
  supplierName: string | null;
  bills: number;
  freeLines: number;
  /** Free goods at the stock's average cost when sold (null for those who may not see cost), and at the rates on the bills. */
  freeCost: string | null;
  freeValue: string;
  discount: string;
  /** Free goods at cost plus discounts (null without cost). */
  claim: string | null;
}

export interface SchemeClaimLine {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  customerName: string;
  schemeId: string;
  schemeName: string;
  productName: string;
  /** Stock units given free (net of returns), and the stock unit. */
  freeQty: string;
  unit: string;
  freeCost: string | null;
  freeValue: string;
  discount: string;
}

export interface SchemeClaimView {
  from: string;
  to: string;
  rows: SchemeClaimRow[];
  lines: SchemeClaimLine[];
  totals: { freeCost: string | null; freeValue: string; discount: string; claim: string | null };
}
