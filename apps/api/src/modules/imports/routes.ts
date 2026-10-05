import { ImportBody, TallyImportBody } from "@digitalbahi/contracts";
import { GST_STATES, normalizeGstin, normalizeIndianMobile, resolveTax, stateCodeFromGstin, validateGstin, validatePincode, type TaxCategory } from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, eq, isNull } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { guard, requirePermission } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { ApiError } from "../../lib/errors.js";
import { nextMasterCodes } from "../../services/numbering.js";
import { listTaxCategories } from "../catalog/masters.js";
import type { ApiModule } from "../types.js";

type Rows = z.output<typeof ImportBody>["rows"];
interface RowError {
  row: number;
  column: string;
  code: string;
  params?: Record<string, string>;
}

const CODE = /^[A-Za-z0-9/_-]{1,20}$/;
const HSN = /^(?:\d{4}|\d{6}|\d{8})$/;
const CHUNK = 500;

/** Names not yet on file, once each whatever their case (the first spelling wins). */
function newNames(names: string[], known: Map<string, string>): string[] {
  const out = new Map<string, string>();
  for (const n of names) if (n && !known.has(n.toUpperCase()) && !out.has(n.toUpperCase())) out.set(n.toUpperCase(), n);
  return [...out.values()];
}

/** Cell text as the user typed it, trimmed; "" for missing. */
const cell = (row: Rows[number], key: string) => (row[key] ?? "").trim();
/** "₹1,200.50" -> "1200.50"; null when not a number with at most `decimals` places. */
function amount(raw: string, decimals: number, allowNegative = false): string | null {
  const v = raw.replace(/[₹,\s]/g, "");
  const re = new RegExp(`^${allowNegative ? "-?" : ""}\\d{1,12}(\\.\\d{1,${decimals}})?$`);
  return re.test(v) ? v : null;
}
const yes = (raw: string) => /^(y|yes|true|1|haan|हाँ)$/i.test(raw);

async function inChunks<T>(items: T[], fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += CHUNK) await fn(items.slice(i, i + CHUNK));
}

async function defaultWarehouse(tx: Tx, businessId: string): Promise<string> {
  const [wh] = await tx
    .select({ id: schema.warehouses.id })
    .from(schema.warehouses)
    .where(and(eq(schema.warehouses.businessId, businessId), eq(schema.warehouses.isDefault, true), isNull(schema.warehouses.deletedAt)));
  if (!wh) throw new ApiError(409, "NO_DEFAULT_WAREHOUSE");
  return wh.id;
}

// ---------------------------------------------------------------- products

async function importProducts(tx: Tx, ctx: RequestCtx, today: string, rows: Rows, dryRun: boolean) {
  const errors: RowError[] = [];
  const businessId = ctx.businessId;
  const units = await tx.select().from(schema.units).where(eq(schema.units.businessId, businessId));
  const unitBy = new Map<string, string>();
  for (const u of units) {
    unitBy.set(u.symbol.toUpperCase(), u.id);
    unitBy.set(u.name.toUpperCase(), u.id);
  }
  // GST: "18", "18%", "GST 18%", "nil", "exempt" -> tax category.
  const cats = (await listTaxCategories(tx, businessId)) as unknown as TaxCategory[];
  const taxBy = new Map<string, string>();
  for (const c of cats) {
    taxBy.set(c.name.toUpperCase(), c.id);
    if (c.kind === "nil_rated") ["NIL", "0", "NIL RATED"].forEach((k) => taxBy.set(k, c.id));
    if (c.kind === "exempt") taxBy.set("EXEMPT", c.id);
    if (c.kind === "taxable") {
      try {
        const rate = resolveTax(c, { date: today }).gstRate.toNumber();
        if (!taxBy.has(String(rate))) taxBy.set(String(rate), c.id);
      } catch {
        /* category without a rule for today */
      }
    }
  }
  const brands = await tx.select({ id: schema.brands.id, name: schema.brands.name }).from(schema.brands).where(and(eq(schema.brands.businessId, businessId), isNull(schema.brands.deletedAt)));
  const brandBy = new Map(brands.map((b) => [b.name.toUpperCase(), b.id]));
  const categories = await tx
    .select({ id: schema.productCategories.id, name: schema.productCategories.name })
    .from(schema.productCategories)
    .where(and(eq(schema.productCategories.businessId, businessId), isNull(schema.productCategories.deletedAt)));
  const categoryBy = new Map(categories.map((c) => [c.name.toUpperCase(), c.id]));
  const existing = await tx.select({ code: schema.products.code }).from(schema.products).where(and(eq(schema.products.businessId, businessId), isNull(schema.products.deletedAt)));
  const takenCodes = new Set(existing.map((p) => p.code.toUpperCase()));
  const existingBarcodes = new Set((await tx.select({ b: schema.productBarcodes.barcode }).from(schema.productBarcodes).where(eq(schema.productBarcodes.businessId, businessId))).map((x) => x.b));

  const fileCodes = new Set<string>();
  const fileBarcodes = new Set<string>();
  const valid = rows.map((row, i) => {
    const n = i + 1;
    const err = (column: string, code: string, params?: Record<string, string>) => errors.push({ row: n, column, code, ...(params ? { params } : {}) });
    const name = cell(row, "name");
    if (!name) err("name", "IMPORT_REQUIRED");
    else if (name.length > 200) err("name", "IMPORT_TOO_LONG");
    const code = cell(row, "code").toUpperCase();
    if (code) {
      if (!CODE.test(code)) err("code", "IMPORT_INVALID");
      else if (takenCodes.has(code) || fileCodes.has(code)) err("code", "DUPLICATE_CODE");
      fileCodes.add(code);
    }
    const hsn = cell(row, "hsn").replace(/\s/g, "");
    if (hsn && !HSN.test(hsn)) err("hsn", "IMPORT_INVALID");
    const gstRaw = cell(row, "gst").toUpperCase().replace(/%$/, "").replace(/^GST\s*/, "").trim();
    const taxCategoryId = taxBy.get(cell(row, "gst").toUpperCase()) ?? taxBy.get(gstRaw) ?? taxBy.get(String(Number(gstRaw)));
    if (!cell(row, "gst")) err("gst", "IMPORT_REQUIRED");
    else if (!taxCategoryId) err("gst", "IMPORT_UNKNOWN_GST", { value: cell(row, "gst") });
    const unitId = unitBy.get((cell(row, "unit") || "PCS").toUpperCase());
    if (!unitId) err("unit", "IMPORT_UNKNOWN_UNIT", { value: cell(row, "unit") });
    const caseUnitRaw = cell(row, "case_unit");
    const caseUnitId = caseUnitRaw ? unitBy.get(caseUnitRaw.toUpperCase()) : undefined;
    const caseSize = cell(row, "case_size") ? amount(cell(row, "case_size"), 3) : null;
    if (caseUnitRaw && !caseUnitId) err("case_unit", "IMPORT_UNKNOWN_UNIT", { value: caseUnitRaw });
    if (caseUnitId && (!caseSize || Number(caseSize) <= 0)) err("case_size", "IMPORT_INVALID");
    if (caseUnitId && caseUnitId === unitId) err("case_unit", "ALT_UNIT_IS_BASE_UNIT");
    const num = (column: string, decimals: number) => {
      const raw = cell(row, column);
      if (!raw) return null;
      const v = amount(raw, decimals);
      if (v === null) err(column, "IMPORT_INVALID");
      return v;
    };
    const mrp = num("mrp", 4);
    const sellingPrice = num("selling_price", 4);
    const purchasePrice = num("purchase_price", 4);
    const minStock = num("min_stock", 3);
    const openingStock = num("opening_stock", 3);
    const barcodes = cell(row, "barcode")
      .split(/[;|]/)
      .map((b) => b.trim())
      .filter(Boolean);
    for (const b of barcodes) {
      if (b.length < 4 || b.length > 64) err("barcode", "IMPORT_INVALID");
      else if (existingBarcodes.has(b) || fileBarcodes.has(b)) err("barcode", "DUPLICATE_BARCODE", { value: b });
      fileBarcodes.add(b);
    }
    return {
      name,
      nameLocal: cell(row, "name_hindi") || null,
      code,
      hsn: hsn || null,
      taxCategoryId,
      unitId,
      caseUnitId,
      caseSize,
      brand: cell(row, "brand"),
      category: cell(row, "category"),
      packSize: cell(row, "pack_size") || null,
      mrp,
      sellingPrice,
      purchasePrice,
      pricesIncludeTax: yes(cell(row, "prices_include_tax")),
      minStock,
      openingStock,
      barcodes,
    };
  });
  const newBrands = newNames(valid.map((v) => v.brand), brandBy);
  const newCategories = newNames(valid.map((v) => v.category), categoryBy);
  const summary = { total: rows.length, newBrands: newBrands.length, newCategories: newCategories.length, withOpeningStock: valid.filter((v) => v.openingStock && Number(v.openingStock) > 0).length };
  if (errors.length || dryRun) return { ...summary, created: 0, errors };

  const audited = { createdBy: ctx.userId, updatedBy: ctx.userId };
  for (const b of newBrands) {
    const id = uuidv7();
    await tx.insert(schema.brands).values({ id, businessId, name: b, ...audited });
    brandBy.set(b.toUpperCase(), id);
  }
  for (const c of newCategories) {
    const id = uuidv7();
    await tx.insert(schema.productCategories).values({ id, businessId, name: c, ...audited });
    categoryBy.set(c.toUpperCase(), id);
  }
  const autoCodes = await nextMasterCodes(tx, businessId, "product", today, valid.filter((v) => !v.code).length, new Set([...takenCodes, ...fileCodes]));
  let next = 0;
  const products = valid.map((v) => ({ ...v, id: uuidv7(), code: v.code || autoCodes[next++]! }));

  await inChunks(products, (chunk) =>
    tx.insert(schema.products).values(
      chunk.map((p) => ({
        id: p.id,
        businessId,
        code: p.code,
        name: p.name,
        nameLocal: p.nameLocal,
        aliases: [],
        hsnCode: p.hsn,
        taxCategoryId: p.taxCategoryId!,
        brandId: p.brand ? brandBy.get(p.brand.toUpperCase())! : null,
        categoryId: p.category ? categoryBy.get(p.category.toUpperCase())! : null,
        baseUnitId: p.unitId!,
        packSize: p.packSize,
        purchasePrice: p.purchasePrice ?? "0",
        sellingPrice: p.sellingPrice ?? "0",
        mrp: p.mrp,
        pricesIncludeTax: p.pricesIncludeTax,
        minStock: p.minStock,
        // Opening stock enters at the purchase price.
        avgCost: p.openingStock && Number(p.openingStock) > 0 ? (p.purchasePrice ?? "0") : "0",
        ...audited,
      })),
    ),
  );
  const barcodeRows = products.flatMap((p) => p.barcodes.map((barcode) => ({ id: uuidv7(), businessId, productId: p.id, barcode, ...audited })));
  if (barcodeRows.length) await inChunks(barcodeRows, (chunk) => tx.insert(schema.productBarcodes).values(chunk));
  const unitRows = products
    .filter((p) => p.caseUnitId)
    .map((p) => ({ id: uuidv7(), businessId, productId: p.id, unitId: p.caseUnitId!, conversionFactor: p.caseSize!, isDefaultSale: false, isDefaultPurchase: true, ...audited }));
  if (unitRows.length) await inChunks(unitRows, (chunk) => tx.insert(schema.productUnits).values(chunk));

  // Opening stock: new products have no balance yet, so ledger and balance rows are written directly.
  const stocked = products.filter((p) => p.openingStock && Number(p.openingStock) > 0);
  if (stocked.length) {
    const warehouseId = await defaultWarehouse(tx, businessId);
    await inChunks(stocked, async (chunk) => {
      const ledger = await tx
        .insert(schema.stockLedger)
        .values(
          chunk.map((p) => ({
            businessId,
            productId: p.id,
            warehouseId,
            txnDate: today,
            movementType: "opening" as const,
            qtyIn: p.openingStock!,
            qtyOut: "0",
            balanceAfter: p.openingStock!,
            unitCost: p.purchasePrice ?? "0",
            refType: "opening",
            refId: p.id,
            refNumber: p.code,
            reason: "Opening stock (import)",
            createdBy: ctx.userId,
          })),
        )
        .returning({ id: schema.stockLedger.id, productId: schema.stockLedger.productId });
      const ledgerOf = new Map(ledger.map((l) => [l.productId, l.id]));
      await tx.insert(schema.stockBalances).values(chunk.map((p) => ({ id: uuidv7(), businessId, productId: p.id, warehouseId, batchId: null, qty: p.openingStock!, lastLedgerId: ledgerOf.get(p.id)! })));
    });
  }
  await audit(tx, ctx, { action: "product.imported", entityType: "product", changes: { rows: products.length, newBrands: newBrands.length, newCategories: newCategories.length } });
  return { ...summary, created: products.length, errors };
}

// ---------------------------------------------------------------- customers

async function importCustomers(tx: Tx, ctx: RequestCtx, today: string, rows: Rows, dryRun: boolean) {
  const errors: RowError[] = [];
  const businessId = ctx.businessId;
  const [business] = await tx.select({ stateCode: schema.businesses.stateCode }).from(schema.businesses).where(eq(schema.businesses.id, businessId));
  const levels = await tx.select({ id: schema.priceLevels.id, name: schema.priceLevels.name }).from(schema.priceLevels).where(eq(schema.priceLevels.businessId, businessId));
  const levelBy = new Map(levels.map((l) => [l.name.toUpperCase(), l.id]));
  // Older sheets name the first lists Retail / Wholesale / Distributor, or just "A", "B", "C".
  for (const [alias, name] of [["RETAIL", "PRICE A"], ["WHOLESALE", "PRICE B"], ["DISTRIBUTOR", "PRICE C"], ["A", "PRICE A"], ["B", "PRICE B"], ["C", "PRICE C"]] as const) {
    const id = levelBy.get(name);
    if (id && !levelBy.has(alias)) levelBy.set(alias, id);
  }
  const routes = await tx.select({ id: schema.salesRoutes.id, name: schema.salesRoutes.name }).from(schema.salesRoutes).where(eq(schema.salesRoutes.businessId, businessId));
  const routeBy = new Map(routes.map((r) => [r.name.toUpperCase(), r.id]));
  const existing = await tx
    .select({ code: schema.customers.code, mobile: schema.customers.mobile, gstin: schema.customers.gstin })
    .from(schema.customers)
    .where(and(eq(schema.customers.businessId, businessId), isNull(schema.customers.deletedAt)));
  const takenCodes = new Set(existing.map((c) => c.code.toUpperCase()));
  const takenMobiles = new Set(existing.map((c) => c.mobile).filter(Boolean) as string[]);
  const takenGstins = new Set(existing.map((c) => c.gstin).filter(Boolean) as string[]);
  const stateBy = new Map<string, string>();
  for (const s of GST_STATES) {
    stateBy.set(s.code, s.code);
    stateBy.set(s.name.toUpperCase(), s.code);
    stateBy.set(s.nameHi, s.code);
  }

  const fileCodes = new Set<string>();
  const fileMobiles = new Set<string>();
  const fileGstins = new Set<string>();
  const valid = rows.map((row, i) => {
    const n = i + 1;
    const err = (column: string, code: string, params?: Record<string, string>) => errors.push({ row: n, column, code, ...(params ? { params } : {}) });
    const businessName = cell(row, "name");
    if (!businessName) err("name", "IMPORT_REQUIRED");
    else if (businessName.length > 150) err("name", "IMPORT_TOO_LONG");
    const code = cell(row, "code").toUpperCase();
    if (code) {
      if (!CODE.test(code)) err("code", "IMPORT_INVALID");
      else if (takenCodes.has(code) || fileCodes.has(code)) err("code", "DUPLICATE_CODE");
      fileCodes.add(code);
    }
    let mobile: string | null = null;
    if (cell(row, "mobile")) {
      mobile = normalizeIndianMobile(cell(row, "mobile"));
      if (!mobile) err("mobile", "INVALID_MOBILE");
      else if (takenMobiles.has(mobile) || fileMobiles.has(mobile)) err("mobile", "IMPORT_DUPLICATE_PARTY", { value: mobile });
      if (mobile) fileMobiles.add(mobile);
    }
    const gstin = cell(row, "gstin") ? normalizeGstin(cell(row, "gstin")) : null;
    if (gstin) {
      const issues = validateGstin(gstin);
      if (issues.length) err("gstin", "INVALID_GSTIN", { issue: issues[0]! });
      else if (takenGstins.has(gstin) || fileGstins.has(gstin)) err("gstin", "IMPORT_DUPLICATE_PARTY", { value: gstin });
      fileGstins.add(gstin);
    }
    const stateRaw = cell(row, "state");
    let stateCode = stateRaw ? (stateBy.get(stateRaw.padStart(2, "0")) ?? stateBy.get(stateRaw.toUpperCase()) ?? stateBy.get(stateRaw)) : undefined;
    if (stateRaw && !stateCode) err("state", "INVALID_STATE_CODE");
    if (gstin && !validateGstin(gstin).length) {
      const fromGstin = stateCodeFromGstin(gstin);
      if (stateCode && stateCode !== fromGstin) err("gstin", "GSTIN_STATE_MISMATCH", { gstinState: fromGstin });
      stateCode ??= fromGstin;
    }
    stateCode ??= business!.stateCode;
    const pincode = cell(row, "pincode");
    if (pincode && validatePincode(pincode).length) err("pincode", "IMPORT_INVALID");
    const money = (column: string, allowNegative = false) => {
      const raw = cell(row, column);
      if (!raw) return null;
      const v = amount(raw, 2, allowNegative);
      if (v === null) err(column, "IMPORT_INVALID");
      return v;
    };
    const creditLimit = money("credit_limit");
    const opening = money("opening_balance", true);
    const daysRaw = cell(row, "credit_days");
    const creditDays = daysRaw ? Number(daysRaw) : 0;
    if (daysRaw && (!Number.isInteger(creditDays) || creditDays < 0 || creditDays > 365)) err("credit_days", "IMPORT_INVALID");
    const levelRaw = cell(row, "price_level");
    const priceLevelId = levelRaw ? levelBy.get(levelRaw.toUpperCase()) : null;
    if (levelRaw && !priceLevelId) err("price_level", "IMPORT_UNKNOWN_PRICE_LEVEL", { value: levelRaw });
    const email = cell(row, "email");
    if (email && !z.email().safeParse(email).success) err("email", "IMPORT_INVALID");
    return {
      code,
      businessName,
      name: cell(row, "contact_person") || businessName,
      mobile,
      gstin,
      stateCode: stateCode!,
      city: cell(row, "city") || null,
      addressLine1: cell(row, "address") || null,
      pincode: pincode || null,
      email: email ? email.toLowerCase() : null,
      creditLimit,
      creditDays,
      opening,
      priceLevelId: priceLevelId ?? null,
      route: cell(row, "route"),
    };
  });
  const newRoutes = newNames(valid.map((v) => v.route), routeBy);
  const summary = { total: rows.length, newRoutes: newRoutes.length, withOpeningBalance: valid.filter((v) => v.opening && Number(v.opening) !== 0).length };
  if (errors.length || dryRun) return { ...summary, created: 0, errors };

  const audited = { createdBy: ctx.userId, updatedBy: ctx.userId };
  for (const r of newRoutes) {
    const id = uuidv7();
    await tx.insert(schema.salesRoutes).values({ id, businessId, name: r, ...audited });
    routeBy.set(r.toUpperCase(), id);
  }
  const autoCodes = await nextMasterCodes(tx, businessId, "customer", today, valid.filter((v) => !v.code).length, new Set([...takenCodes, ...fileCodes]));
  let next = 0;
  const customers = valid.map((v) => ({ ...v, id: uuidv7(), code: v.code || autoCodes[next++]! }));
  await inChunks(customers, (chunk) =>
    tx.insert(schema.customers).values(
      chunk.map((c) => {
        const opening = Number(c.opening ?? 0);
        return {
          id: c.id,
          businessId,
          code: c.code,
          name: c.name,
          businessName: c.businessName,
          customerType: c.gstin ? ("b2b" as const) : ("b2c" as const),
          gstRegistration: c.gstin ? ("regular" as const) : ("consumer" as const),
          mobile: c.mobile,
          email: c.email,
          addressLine1: c.addressLine1,
          city: c.city,
          stateCode: c.stateCode,
          pincode: c.pincode,
          gstin: c.gstin,
          pan: c.gstin ? c.gstin.slice(2, 12) : null,
          creditLimit: c.creditLimit,
          creditDays: c.creditDays,
          priceLevelId: c.priceLevelId,
          routeId: c.route ? routeBy.get(c.route.toUpperCase())! : null,
          openingBalance: Math.abs(opening).toFixed(2),
          openingBalanceSide: opening < 0 ? ("credit" as const) : ("debit" as const),
          openingBalanceDate: today,
          // Receivable: an opening debit is owed to us, a negative (credit) opening is an advance.
          balance: opening.toFixed(2),
          ...audited,
        };
      }),
    ),
  );
  const openings = customers.filter((c) => c.opening && Number(c.opening) !== 0);
  if (openings.length) {
    await inChunks(openings, (chunk) =>
      tx.insert(schema.partyLedgerEntries).values(
        chunk.map((c) => {
          const v = Number(c.opening);
          return {
            businessId,
            partyType: "customer" as const,
            customerId: c.id,
            entryDate: today,
            docType: "opening",
            docId: c.id,
            docNumber: c.code,
            debit: v > 0 ? v.toFixed(2) : "0",
            credit: v < 0 ? (-v).toFixed(2) : "0",
            narration: "Opening balance (import)",
            createdBy: ctx.userId,
          };
        }),
      ),
    );
  }
  await audit(tx, ctx, { action: "customer.imported", entityType: "customer", changes: { rows: customers.length, newRoutes: newRoutes.length } });
  return { ...summary, created: customers.length, errors };
}

// ---------------------------------------------------------------- suppliers

/** Suppliers (from Tally's Sundry Creditors): name, GSTIN, state, contact and the payable opening balance. */
async function importSuppliers(tx: Tx, ctx: RequestCtx, today: string, rows: Rows, dryRun: boolean) {
  const errors: RowError[] = [];
  const businessId = ctx.businessId;
  const [business] = await tx.select({ stateCode: schema.businesses.stateCode }).from(schema.businesses).where(eq(schema.businesses.id, businessId));
  const existing = await tx
    .select({ code: schema.suppliers.code, gstin: schema.suppliers.gstin })
    .from(schema.suppliers)
    .where(and(eq(schema.suppliers.businessId, businessId), isNull(schema.suppliers.deletedAt)));
  const takenCodes = new Set(existing.map((c) => c.code.toUpperCase()));
  const takenGstins = new Set(existing.map((c) => c.gstin).filter(Boolean) as string[]);
  const stateBy = new Map<string, string>();
  for (const s of GST_STATES) {
    stateBy.set(s.code, s.code);
    stateBy.set(s.name.toUpperCase(), s.code);
  }
  const fileGstins = new Set<string>();
  const valid = rows.map((row, i) => {
    const err = (column: string, code: string, params?: Record<string, string>) => errors.push({ row: i + 1, column, code, ...(params ? { params } : {}) });
    const name = cell(row, "name");
    if (!name) err("name", "IMPORT_REQUIRED");
    else if (name.length > 150) err("name", "IMPORT_TOO_LONG");
    const mobile = cell(row, "mobile") ? normalizeIndianMobile(cell(row, "mobile")) : null;
    if (cell(row, "mobile") && !mobile) err("mobile", "INVALID_MOBILE");
    const gstin = cell(row, "gstin") ? normalizeGstin(cell(row, "gstin")) : null;
    if (gstin) {
      const issues = validateGstin(gstin);
      if (issues.length) err("gstin", "INVALID_GSTIN", { issue: issues[0]! });
      else if (takenGstins.has(gstin) || fileGstins.has(gstin)) err("gstin", "IMPORT_DUPLICATE_PARTY", { value: gstin });
      fileGstins.add(gstin);
    }
    const stateRaw = cell(row, "state");
    let stateCode = stateRaw ? (stateBy.get(stateRaw.padStart(2, "0")) ?? stateBy.get(stateRaw.toUpperCase())) : undefined;
    if (stateRaw && !stateCode) err("state", "INVALID_STATE_CODE");
    if (gstin && !validateGstin(gstin).length) stateCode = stateCodeFromGstin(gstin);
    stateCode ??= business!.stateCode;
    const pincode = cell(row, "pincode");
    if (pincode && validatePincode(pincode).length) err("pincode", "IMPORT_INVALID");
    const openingRaw = cell(row, "opening_balance");
    const opening = openingRaw ? amount(openingRaw, 2, true) : null;
    if (openingRaw && opening === null) err("opening_balance", "IMPORT_INVALID");
    const email = cell(row, "email");
    if (email && !z.email().safeParse(email).success) err("email", "IMPORT_INVALID");
    return { name, contact: cell(row, "contact_person"), mobile, gstin, stateCode: stateCode!, addressLine1: cell(row, "address") || null, pincode: pincode || null, email: email ? email.toLowerCase() : null, opening };
  });
  const summary = { total: rows.length, withOpeningBalance: valid.filter((v) => v.opening && Number(v.opening) !== 0).length };
  if (errors.length || dryRun) return { ...summary, created: 0, errors };

  const codes = await nextMasterCodes(tx, businessId, "supplier", today, valid.length, takenCodes);
  const suppliers = valid.map((v, i) => ({ ...v, id: uuidv7(), code: codes[i]! }));
  await inChunks(suppliers, (chunk) =>
    tx.insert(schema.suppliers).values(
      chunk.map((s) => {
        // Payable: a positive opening is owed to the supplier (credit), a negative one an advance paid.
        const opening = Number(s.opening ?? 0);
        return {
          id: s.id,
          businessId,
          code: s.code,
          name: s.name,
          companyName: s.contact || null,
          gstRegistration: s.gstin ? ("regular" as const) : ("unregistered" as const),
          mobile: s.mobile,
          email: s.email,
          gstin: s.gstin,
          pan: s.gstin ? s.gstin.slice(2, 12) : null,
          addressLine1: s.addressLine1,
          stateCode: s.stateCode,
          pincode: s.pincode,
          openingBalance: Math.abs(opening).toFixed(2),
          openingBalanceSide: opening < 0 ? ("debit" as const) : ("credit" as const),
          openingBalanceDate: today,
          balance: opening.toFixed(2),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        };
      }),
    ),
  );
  const openings = suppliers.filter((s) => s.opening && Number(s.opening) !== 0);
  if (openings.length) {
    await inChunks(openings, (chunk) =>
      tx.insert(schema.partyLedgerEntries).values(
        chunk.map((s) => {
          const v = Number(s.opening);
          return {
            businessId,
            partyType: "supplier" as const,
            supplierId: s.id,
            entryDate: today,
            docType: "opening",
            docId: s.id,
            docNumber: s.code,
            debit: v < 0 ? (-v).toFixed(2) : "0",
            credit: v > 0 ? v.toFixed(2) : "0",
            narration: "Opening balance (import)",
            createdBy: ctx.userId,
          };
        }),
      ),
    );
  }
  await audit(tx, ctx, { action: "supplier.imported", entityType: "supplier", changes: { rows: suppliers.length } });
  return { ...summary, created: suppliers.length, errors };
}

/**
 * Masters from Tally (read from its XML by the client): customers,
 * suppliers and products together, all or nothing. Names already on file
 * are left as they are (so the same file can be sent again).
 */
async function importTally(tx: Tx, ctx: RequestCtx, today: string, body: z.output<typeof TallyImportBody>) {
  const businessId = ctx.businessId;
  const lower = (rows: { n: string | null }[]) => new Set(rows.map((r) => (r.n ?? "").trim().toUpperCase()));
  const [customers, suppliers, products] = await Promise.all([
    tx.select({ n: schema.customers.businessName }).from(schema.customers).where(and(eq(schema.customers.businessId, businessId), isNull(schema.customers.deletedAt))),
    tx.select({ n: schema.suppliers.name }).from(schema.suppliers).where(and(eq(schema.suppliers.businessId, businessId), isNull(schema.suppliers.deletedAt))),
    tx.select({ n: schema.products.name }).from(schema.products).where(and(eq(schema.products.businessId, businessId), isNull(schema.products.deletedAt))),
  ]);
  // Rows whose name is new, with where each sat in the file (errors name the file's row).
  const fresh = (rows: Rows, known: Set<string>) => {
    const at: number[] = [];
    const kept = rows.filter((r, i) => !known.has(cell(r, "name").toUpperCase()) && at.push(i) > 0);
    return { rows: kept, at };
  };
  const parts = {
    customers: fresh(body.customers, lower(customers)),
    suppliers: fresh(body.suppliers, lower(suppliers)),
    products: fresh(body.products, lower(products)),
  };
  const skipped = { customers: body.customers.length - parts.customers.rows.length, suppliers: body.suppliers.length - parts.suppliers.rows.length, products: body.products.length - parts.products.rows.length };
  type Result = { total: number; created: number; errors: RowError[] } | null;
  const inFile = <R extends Result>(r: R, at: number[]): R => (r ? { ...r, errors: r.errors.map((e) => ({ ...e, row: at[e.row - 1]! + 1 })) } : r);
  // Everything is checked first; nothing is written unless all three are clean.
  const check = async (dryRun: boolean) => ({
    customers: inFile(parts.customers.rows.length ? await importCustomers(tx, ctx, today, parts.customers.rows, dryRun) : null, parts.customers.at),
    suppliers: inFile(parts.suppliers.rows.length ? await importSuppliers(tx, ctx, today, parts.suppliers.rows, dryRun) : null, parts.suppliers.at),
    products: inFile(parts.products.rows.length ? await importProducts(tx, ctx, today, parts.products.rows, dryRun) : null, parts.products.at),
  });
  const checked = await check(true);
  const clean = Object.values(checked).every((r) => !r || r.errors.length === 0);
  if (!clean || body.dryRun) return { ...checked, skipped, imported: false };
  return { ...(await check(false)), skipped, imported: true };
}

/**
 * Bulk import from a spreadsheet: every row is checked first, and nothing is
 * written unless all rows are valid (so a file can simply be fixed and sent
 * again). `dryRun` only checks. Errors name the row and column.
 */
export const importsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post("/products/import", { preHandler: guard(deps, "product.import"), schema: { tags: ["catalog"], body: ImportBody } }, async (request) => {
    const ctx = request.ctx;
    return withTenant(deps.db, ctx, (tx) => importProducts(tx, ctx, deps.clock.today(ctx.timeZone), request.body.rows, request.body.dryRun));
  });

  r.post("/customers/import", { preHandler: guard(deps, "customer.create"), schema: { tags: ["customers"], body: ImportBody } }, async (request) => {
    const ctx = request.ctx;
    return withTenant(deps.db, ctx, (tx) => importCustomers(tx, ctx, deps.clock.today(ctx.timeZone), request.body.rows, request.body.dryRun));
  });

  r.post("/tally/import", { preHandler: [...guard(deps, "customer.create"), requirePermission("supplier.create"), requirePermission("product.import")], schema: { tags: ["imports"], body: TallyImportBody } }, async (request) => {
    const ctx = request.ctx;
    return withTenant(deps.db, ctx, (tx) => importTally(tx, ctx, deps.clock.today(ctx.timeZone), request.body));
  });
};
