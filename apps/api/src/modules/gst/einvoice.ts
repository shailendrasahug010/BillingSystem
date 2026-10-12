import { EwayBillBody, EwayFileQuery, IrnBody } from "@digitalbahi/contracts";
import {
  buildEInvoice,
  buildEwayBill,
  dec,
  eInvoiceSupplyType,
  ewayBillFile,
  monthBounds,
  needsEInvoice,
  needsEwayBill,
  type EDocIssue,
  type EDocParty,
  type EDocument,
  type EwayTransport,
  type ZeroRatedType,
} from "@digitalbahi/core";
import { schema, type Tx } from "@digitalbahi/db";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { guard } from "../../lib/access.js";
import { audit } from "../../lib/audit.js";
import type { RequestCtx } from "../../lib/context.js";
import { withTenant } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { getSettings } from "../../services/settings.js";
import type { ApiModule } from "../types.js";

const IdParams = z.object({ id: z.uuid() });
const PeriodQuery = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
const inv = schema.invoices;
const notes = schema.creditDebitNotes;

type Address = { line1?: string | null; line2?: string | null; city?: string | null; stateCode?: string | null; pincode?: string | null } | null;

/** A time the portals gave (India time): "2026-09-24" or "2026-09-24T14:05". */
const istTimestamp = (v: string) => (v.length === 10 ? `${v}T00:00:00+05:30` : `${v.length === 16 ? `${v}:00` : v}+05:30`);

async function sellerOf(tx: Tx, businessId: string): Promise<EDocParty> {
  const [b] = await tx.select().from(schema.businesses).where(eq(schema.businesses.id, businessId));
  return {
    gstin: b!.gstin,
    legalName: b!.legalName,
    tradeName: b!.tradeName,
    addr1: b!.addressLine1,
    addr2: b!.addressLine2,
    place: b!.city,
    pincode: b!.pincode,
    stateCode: b!.stateCode,
    phone: b!.phone,
    email: b!.email,
  };
}

function buyerOf(row: { partyName: string; partyGstin: string | null; partyStateCode: string | null; placeOfSupply: string; billingAddress: unknown }, contact?: { mobile: string | null; email: string | null }): EDocParty {
  const a = row.billingAddress as Address;
  return {
    gstin: row.partyGstin,
    legalName: row.partyName,
    addr1: a?.line1 ?? null,
    addr2: a?.line2 ?? null,
    place: a?.city ?? null,
    pincode: a?.pincode ?? null,
    stateCode: row.partyStateCode ?? a?.stateCode ?? row.placeOfSupply,
    phone: contact?.mobile ?? null,
    email: contact?.email ?? null,
  };
}

type LineRow = typeof schema.invoiceItems.$inferSelect | typeof schema.creditDebitNoteItems.$inferSelect;

async function linesOf(tx: Tx, rows: LineRow[]) {
  const batchIds = rows.map((r) => r.batchId).filter((x): x is string => Boolean(x));
  const batches = batchIds.length ? await tx.select({ id: schema.batches.id, number: schema.batches.batchNumber, expiry: schema.batches.expiryDate }).from(schema.batches).where(inArray(schema.batches.id, batchIds)) : [];
  return rows.map((l) => {
    const b = batches.find((x) => x.id === l.batchId);
    return {
      name: l.productName,
      hsnCode: l.hsnCode,
      qty: l.qtyBase,
      freeQty: dec(l.freeQty).times(l.conversionFactor).toFixed(3),
      uqc: l.uqc,
      discount: dec(l.discountAmount).plus(l.documentDiscountShare).toFixed(2),
      taxable: l.taxableValue,
      gstRate: l.gstRate,
      cgst: l.cgstAmount,
      sgst: l.sgstAmount,
      igst: l.igstAmount,
      cessRate: l.cessRate,
      cess: l.cessAmount,
      batch: b ? { number: b.number, expiry: b.expiry } : null,
    };
  });
}

type InvoiceRow = typeof inv.$inferSelect;
type NoteRow = typeof notes.$inferSelect;
export type EDoc = { kind: "invoice"; row: InvoiceRow; doc: EDocument } | { kind: "credit_note" | "debit_note"; row: NoteRow; doc: EDocument; zeroRatedType: ZeroRatedType | null };

/** Invoices as e-invoice / e-way bill documents. */
export async function invoiceDocs(tx: Tx, ctx: RequestCtx, ids: string[]): Promise<Array<Extract<EDoc, { kind: "invoice" }>>> {
  if (!ids.length) return [];
  const seller = await sellerOf(tx, ctx.businessId);
  const rows = await tx.select().from(inv).where(and(eq(inv.businessId, ctx.businessId), inArray(inv.id, ids))).orderBy(asc(inv.invoiceDate), asc(inv.invoiceNumber));
  const items = await tx.select().from(schema.invoiceItems).where(inArray(schema.invoiceItems.invoiceId, rows.map((r) => r.id))).orderBy(asc(schema.invoiceItems.lineNo));
  const contacts = await tx.select({ id: schema.customers.id, mobile: schema.customers.mobile, email: schema.customers.email }).from(schema.customers).where(inArray(schema.customers.id, rows.map((r) => r.customerId)));
  const out = [];
  for (const r of rows) {
    const lines = await linesOf(tx, items.filter((i) => i.invoiceId === r.id));
    // TCS collected on the bill is no part of the GST value: it goes in "other charges".
    const tcs = dec(r.tcsAmount).gt(0) ? [{ label: "TCS", taxable: r.tcsAmount, gstRate: "0", total: r.tcsAmount }] : [];
    const charges = [...((r.charges ?? []) as Array<{ label: string; taxable: string; gstRate: string; total: string }>), ...tcs];
    out.push({
      kind: "invoice" as const,
      row: r,
      doc: {
        kind: "invoice" as const,
        number: r.invoiceNumber ?? "",
        date: r.invoiceDate,
        seller,
        buyer: buyerOf(r, contacts.find((c) => c.id === r.customerId)),
        placeOfSupply: r.placeOfSupply,
        supplyType: r.supplyType,
        zeroRatedType: r.zeroRatedType as ZeroRatedType | null,
        lines,
        charges,
        roundOff: r.roundOff,
        grandTotal: r.grandTotal,
        shippingBill: r.shippingBillNumber ? { number: r.shippingBillNumber, date: r.shippingBillDate, portCode: r.portCode } : null,
      },
    });
  }
  return out;
}

/** Credit and debit notes to customers as e-invoice documents (CRN / DBN, with the invoice they are against). */
async function noteDocs(tx: Tx, ctx: RequestCtx, ids: string[]): Promise<Array<Extract<EDoc, { kind: "credit_note" | "debit_note" }>>> {
  if (!ids.length) return [];
  const seller = await sellerOf(tx, ctx.businessId);
  const rows = await tx
    .select({ n: notes, original: { number: inv.invoiceNumber, date: inv.invoiceDate, zeroRatedType: inv.zeroRatedType } })
    .from(notes)
    .leftJoin(inv, eq(inv.id, notes.invoiceId))
    .where(and(eq(notes.businessId, ctx.businessId), inArray(notes.id, ids), eq(notes.partyType, "customer")))
    .orderBy(asc(notes.noteDate), asc(notes.noteNumber));
  const items = await tx.select().from(schema.creditDebitNoteItems).where(inArray(schema.creditDebitNoteItems.noteId, rows.map((r) => r.n.id))).orderBy(asc(schema.creditDebitNoteItems.lineNo));
  const out = [];
  for (const { n, original } of rows) {
    const zeroRatedType = (original?.zeroRatedType ?? null) as ZeroRatedType | null;
    const kind = n.noteType === "credit" ? ("credit_note" as const) : ("debit_note" as const);
    out.push({
      kind,
      row: n,
      zeroRatedType,
      doc: {
        kind,
        number: n.noteNumber ?? "",
        date: n.noteDate,
        seller,
        buyer: buyerOf(n),
        placeOfSupply: n.placeOfSupply,
        supplyType: n.supplyType,
        zeroRatedType,
        lines: await linesOf(tx, items.filter((i) => i.noteId === n.id)),
        roundOff: n.roundOff,
        grandTotal: n.grandTotal,
        original: original?.number ? { number: original.number, date: original.date! } : null,
      },
    });
  }
  return out;
}

const errorsIn = (issues: EDocIssue[]) => issues.some((i) => i.level === "error");

/** The dispatch trip an invoice travels on (the latest one not cancelled): its vehicle, transporter and LR. */
async function tripsOf(tx: Tx, invoiceIds: string[]) {
  if (!invoiceIds.length) return new Map<string, { id: string; number: string | null; vehicleNumber: string | null; transporterName: string | null; transporterGstin: string | null; lrNumber: string | null; lrDate: string | null }>();
  const rows = await tx
    .select({
      invoiceId: schema.dispatchOrders.invoiceId,
      id: schema.dispatches.id,
      number: schema.dispatches.dispatchNumber,
      vehicleNumber: schema.dispatches.vehicleNumber,
      transporterName: schema.dispatches.transporterName,
      transporterGstin: schema.dispatches.transporterGstin,
      lrNumber: schema.dispatches.lrNumber,
      lrDate: schema.dispatches.lrDate,
    })
    .from(schema.dispatchOrders)
    .innerJoin(schema.dispatches, eq(schema.dispatches.id, schema.dispatchOrders.dispatchId))
    .where(and(inArray(schema.dispatchOrders.invoiceId, invoiceIds), sql`${schema.dispatches.status} <> 'cancelled'`))
    .orderBy(desc(schema.dispatches.dispatchDate));
  const out = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.invoiceId && !out.has(r.invoiceId)) out.set(r.invoiceId, r);
  return out;
}

/** The e-way bill file for these invoices; the transport given, else each one's dispatch trip. */
async function ewayFile(tx: Tx, ctx: RequestCtx, ids: string[], given: Omit<EwayTransport, "docNo" | "docDate">) {
  const docs = await invoiceDocs(tx, ctx, ids);
  if (docs.length !== new Set(ids).size) throw notFound("invoice");
  const trips = await tripsOf(tx, ids);
  const bills = [];
  for (const d of docs) {
    if (d.row.status !== "posted") throw conflict("INVOICE_NOT_POSTED", { status: d.row.status });
    const trip = trips.get(d.row.id);
    const transport: EwayTransport = {
      distanceKm: given.distanceKm ?? 0,
      vehicleNo: given.vehicleNo || trip?.vehicleNumber || null,
      transporterId: given.transporterId || trip?.transporterGstin || null,
      transporterName: given.transporterName || trip?.transporterName || null,
      docNo: trip?.lrNumber ?? null,
      docDate: trip?.lrDate ?? null,
    };
    const { bill, issues } = buildEwayBill(d.doc, transport);
    if (errorsIn(issues)) throw badRequest("EWAY_BILL_HAS_ERRORS", { number: d.doc.number, issue: issues.find((i) => i.level === "error")!.code });
    bills.push(bill);
  }
  return ewayBillFile(bills);
}

/**
 * E-invoices and e-way bills without a GSP: the documents are downloaded in
 * the portals' JSON formats, uploaded there with the business's own login,
 * and the IRN / e-way bill numbers the portals return are recorded here and
 * printed on the documents.
 */
export const eInvoiceModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = <T>(ctx: RequestCtx, fn: (tx: Tx) => Promise<T>) => withTenant(deps.db, ctx, fn);

  /** The month's documents that need an IRN (B2B, SEZ and export invoices, and credit and debit notes on them), with what stops each. */
  r.get("/gst/einvoice", { preHandler: guard(deps, "gst.view"), schema: { tags: ["gst"], querystring: PeriodQuery } }, async (request) => {
    const ctx = request.ctx;
    const { start, end } = monthBounds(request.query.period);
    return tenant(ctx, async (tx) => {
      const settings = await getSettings(tx, ctx.businessId, ["einvoice.enabled"] as const);
      const invoiceIds = (
        await tx
          .select({ id: inv.id })
          .from(inv)
          .where(and(eq(inv.businessId, ctx.businessId), eq(inv.status, "posted"), sql`${inv.invoiceDate} between ${start} and ${end}`, or(isNotNull(inv.partyGstin), isNotNull(inv.zeroRatedType))))
      ).map((x) => x.id);
      const noteIds = (
        await tx
          .select({ id: notes.id })
          .from(notes)
          .leftJoin(inv, eq(inv.id, notes.invoiceId))
          .where(
            and(
              eq(notes.businessId, ctx.businessId),
              eq(notes.status, "posted"),
              eq(notes.partyType, "customer"),
              sql`${notes.noteDate} between ${start} and ${end}`,
              or(isNotNull(notes.partyGstin), isNotNull(inv.zeroRatedType)),
            ),
          )
      ).map((x) => x.id);
      const docs: EDoc[] = [...(await invoiceDocs(tx, ctx, invoiceIds)), ...(await noteDocs(tx, ctx, noteIds))];
      return {
        enabled: settings["einvoice.enabled"],
        documents: docs.map((d) => ({
          kind: d.kind,
          id: d.row.id,
          number: d.doc.number,
          date: d.doc.date,
          partyName: d.row.partyName,
          partyGstin: d.row.partyGstin,
          value: d.row.grandTotal,
          supplyType: eInvoiceSupplyType(d.doc),
          irn: d.row.irn,
          ackNumber: d.row.irnAckNumber,
          ackDate: d.row.irnAckDate,
          issues: buildEInvoice(d.doc).issues,
        })),
      };
    });
  });

  /** The IRP's bulk-upload file for the chosen invoices and notes (a JSON list of INV-01 documents). */
  r.get(
    "/einvoice/file",
    { preHandler: guard(deps, "invoice.view"), schema: { tags: ["gst"], querystring: z.object({ ids: EwayFileQuery.shape.ids }) } },
    async (request, reply) => {
      const ctx = request.ctx;
      const ids = [...new Set(request.query.ids.split(","))];
      const file = await tenant(ctx, async (tx) => {
        const docs: EDoc[] = [...(await invoiceDocs(tx, ctx, ids)), ...(await noteDocs(tx, ctx, ids))];
        if (docs.length !== ids.length) throw notFound("document");
        const out = [];
        for (const d of docs) {
          if (d.row.status !== "posted") throw conflict("INVOICE_NOT_POSTED", { status: d.row.status });
          if (!needsEInvoice({ buyerGstin: d.row.partyGstin, zeroRatedType: d.doc.zeroRatedType ?? null })) throw badRequest("EINVOICE_NOT_APPLICABLE", { number: d.doc.number });
          const { json, issues } = buildEInvoice(d.doc);
          if (errorsIn(issues)) throw badRequest("EINVOICE_HAS_ERRORS", { number: d.doc.number, issue: issues.find((i) => i.level === "error")!.code });
          out.push(json);
        }
        await audit(tx, ctx, { action: "einvoice.exported", entityType: "gst_period", entityLabel: docs.map((d) => d.doc.number).join(", ").slice(0, 200), changes: { documents: docs.length } });
        return { out, name: docs.length === 1 ? docs[0]!.doc.number : `${docs.length}-documents` };
      });
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="EINV_${file.name.replace(/[^A-Za-z0-9-]/g, "-")}.json"`);
      return JSON.stringify(file.out);
    },
  );

  const recordIrn = async (ctx: RequestCtx, kind: "invoice" | "note", id: string, body: z.output<typeof IrnBody>) =>
    tenant(ctx, async (tx) => {
      const table = kind === "invoice" ? inv : notes;
      const [row] = await tx.select().from(table).where(and(eq(table.id, id), eq(table.businessId, ctx.businessId))).for("update");
      // A note to a customer (credit or debit); suppliers' notes are theirs to register.
      if (!row || (kind === "note" && (row as NoteRow).partyType !== "customer")) throw notFound(kind === "invoice" ? "invoice" : "note");
      if (row.status !== "posted") throw conflict("INVOICE_NOT_POSTED", { status: row.status });
      const zeroRated = kind === "invoice" ? (row as InvoiceRow).zeroRatedType : null;
      if (body.irn !== null && !needsEInvoice({ buyerGstin: row.partyGstin, zeroRatedType: zeroRated as ZeroRatedType | null }) && !(kind === "note" && (row as NoteRow).invoiceId)) {
        throw badRequest("EINVOICE_NOT_APPLICABLE", { number: ("invoiceNumber" in row ? row.invoiceNumber : row.noteNumber) ?? "" });
      }
      const next =
        body.irn === null
          ? { irn: null, irnAckNumber: null, irnAckDate: null, signedQrCode: null }
          : { irn: body.irn.toLowerCase(), irnAckNumber: body.ackNumber, irnAckDate: istTimestamp(body.ackDate), signedQrCode: body.signedQrCode ?? null };
      await tx.update(table).set({ ...next, updatedBy: ctx.userId }).where(eq(table.id, row.id));
      const label = ("invoiceNumber" in row ? row.invoiceNumber : row.noteNumber) ?? undefined;
      await audit(tx, ctx, {
        action: body.irn === null ? "einvoice.irn_removed" : "einvoice.irn_recorded",
        entityType: kind === "invoice" ? "invoice" : "note",
        entityId: row.id,
        entityLabel: label,
        changes: { irn: [row.irn, next.irn], ackNumber: [row.irnAckNumber, next.irnAckNumber] },
      });
      return { id: row.id, ...next };
    });

  r.patch("/invoices/:id/irn", { preHandler: guard(deps, "invoice.update"), schema: { tags: ["invoices"], params: IdParams, body: IrnBody } }, async (request) =>
    recordIrn(request.ctx, "invoice", request.params.id, request.body),
  );
  r.patch("/notes/:id/irn", { preHandler: guard(deps, "note.create"), schema: { tags: ["notes"], params: IdParams, body: IrnBody } }, async (request) =>
    recordIrn(request.ctx, "note", request.params.id, request.body),
  );

  /** The month's invoices above the e-way bill limit (or with an e-way bill), with their trip and what stops each. */
  r.get("/ewaybills", { preHandler: guard(deps, "invoice.view"), schema: { tags: ["gst"], querystring: PeriodQuery } }, async (request) => {
    const ctx = request.ctx;
    const { start, end } = monthBounds(request.query.period);
    return tenant(ctx, async (tx) => {
      const threshold = (await getSettings(tx, ctx.businessId, ["ewaybill.threshold"] as const))["ewaybill.threshold"];
      const ids = (
        await tx
          .select({ id: inv.id })
          .from(inv)
          .where(and(eq(inv.businessId, ctx.businessId), eq(inv.status, "posted"), sql`${inv.invoiceDate} between ${start} and ${end}`, or(sql`${inv.grandTotal} > ${threshold}`, isNotNull(inv.ewayBillNumber))))
      ).map((x) => x.id);
      const docs = await invoiceDocs(tx, ctx, ids);
      const trips = await tripsOf(tx, ids);
      return {
        threshold,
        documents: docs.map((d) => {
          const trip = trips.get(d.row.id);
          return {
            id: d.row.id,
            number: d.doc.number,
            date: d.doc.date,
            partyName: d.row.partyName,
            value: d.row.grandTotal,
            due: needsEwayBill(d.row.grandTotal, threshold),
            ewayBillNumber: d.row.ewayBillNumber,
            ewayBillDate: d.row.ewayBillDate,
            validUntil: d.row.ewayBillValidUntil,
            trip: trip ? { id: trip.id, number: trip.number, vehicleNumber: trip.vehicleNumber } : null,
            issues: buildEwayBill(d.doc, { vehicleNo: trip?.vehicleNumber ?? null }).issues,
          };
        }),
      };
    });
  });

  /** The e-way bill portal's bulk-generation file for the chosen invoices. */
  r.get("/ewaybills/file", { preHandler: guard(deps, "invoice.view"), schema: { tags: ["gst"], querystring: EwayFileQuery } }, async (request, reply) => {
    const ctx = request.ctx;
    const q = request.query;
    const ids = [...new Set(q.ids.split(","))];
    const file = await tenant(ctx, async (tx) => {
      const out = await ewayFile(tx, ctx, ids, {
        ...(q.vehicleNo ? { vehicleNo: q.vehicleNo } : {}),
        ...(q.transporterId ? { transporterId: q.transporterId } : {}),
        ...(q.transporterName ? { transporterName: q.transporterName } : {}),
        ...(q.distance !== undefined ? { distanceKm: q.distance } : {}),
      });
      await audit(tx, ctx, { action: "ewaybill.exported", entityType: "invoice", entityLabel: out.billLists.map((b) => String(b.docNo)).join(", ").slice(0, 200), changes: { invoices: ids.length } });
      return out;
    });
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="EWB_${ids.length === 1 ? String(file.billLists[0]!.docNo).replace(/[^A-Za-z0-9-]/g, "-") : `${ids.length}-invoices`}.json"`);
    return JSON.stringify(file);
  });

  /** A dispatch trip's e-way bills: its invoices above the limit that have none yet, with the trip's vehicle and transporter. */
  r.get("/dispatches/:id/ewaybills", { preHandler: guard(deps, "dispatch.view"), schema: { tags: ["dispatch"], params: IdParams } }, async (request, reply) => {
    const ctx = request.ctx;
    const file = await tenant(ctx, async (tx) => {
      const [trip] = await tx.select().from(schema.dispatches).where(and(eq(schema.dispatches.id, request.params.id), eq(schema.dispatches.businessId, ctx.businessId)));
      if (!trip) throw notFound("dispatch");
      const threshold = (await getSettings(tx, ctx.businessId, ["ewaybill.threshold"] as const))["ewaybill.threshold"];
      const due = await tx
        .select({ id: inv.id })
        .from(schema.dispatchOrders)
        .innerJoin(inv, eq(inv.id, schema.dispatchOrders.invoiceId))
        .where(and(eq(schema.dispatchOrders.dispatchId, trip.id), eq(inv.status, "posted"), sql`${inv.grandTotal} > ${threshold}`, sql`${inv.ewayBillNumber} is null`));
      if (!due.length) throw conflict("NO_EWAY_BILLS_DUE");
      const out = await ewayFile(tx, ctx, due.map((d) => d.id), {});
      await audit(tx, ctx, { action: "ewaybill.exported", entityType: "dispatch", entityId: trip.id, entityLabel: trip.dispatchNumber ?? undefined, changes: { invoices: due.length } });
      return { out, name: trip.dispatchNumber ?? trip.id };
    });
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="EWB_${file.name.replace(/[^A-Za-z0-9-]/g, "-")}.json"`);
    return JSON.stringify(file.out);
  });

  /** The e-way bill number, date and validity the portal gave (null removes it). */
  r.patch("/invoices/:id/eway-bill", { preHandler: guard(deps, "invoice.update"), schema: { tags: ["invoices"], params: IdParams, body: EwayBillBody } }, async (request) => {
    const ctx = request.ctx;
    const body = request.body;
    return tenant(ctx, async (tx) => {
      const [row] = await tx.select().from(inv).where(and(eq(inv.id, request.params.id), eq(inv.businessId, ctx.businessId))).for("update");
      if (!row) throw notFound("invoice");
      if (row.status !== "posted") throw conflict("INVOICE_NOT_POSTED", { status: row.status });
      const next =
        body.number === null
          ? { ewayBillNumber: null, ewayBillDate: null, ewayBillValidUntil: null }
          : { ewayBillNumber: body.number, ewayBillDate: istTimestamp(body.date), ewayBillValidUntil: body.validUntil ? istTimestamp(body.validUntil) : null };
      if (body.number !== null && body.date.slice(0, 10) < row.invoiceDate) throw badRequest("EWAY_BILL_BEFORE_INVOICE", {}, "date");
      await tx.update(inv).set({ ...next, updatedBy: ctx.userId }).where(eq(inv.id, row.id));
      await audit(tx, ctx, {
        action: body.number === null ? "ewaybill.removed" : "ewaybill.recorded",
        entityType: "invoice",
        entityId: row.id,
        entityLabel: row.invoiceNumber ?? undefined,
        changes: { ewayBillNumber: [row.ewayBillNumber, next.ewayBillNumber] },
      });
      return { id: row.id, ...next };
    });
  });
};
