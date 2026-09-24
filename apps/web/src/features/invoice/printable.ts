import { dec } from "@vyapaar/core";
import { BUSINESS, customerById, invoiceTotals, productById, WORKSPACE } from "../../data/db";
import type { Invoice } from "../../data/types";

/** Everything the printed invoice shows, independent of where it came from. */
export interface PrintableInvoice {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  placeOfSupply: string;
  intraState: boolean;
  billOfSupply: boolean;
  reverseCharge: boolean;
  status: "paid" | "partial" | "unpaid" | "cancelled";
  customerId: string;
  buyer: { businessName: string; name: string; address: string; pincode: string; stateCode: string; gstin: string | null };
  lines: Array<{
    name: string;
    nameLocal: string;
    batch: string | null;
    hsn: string;
    qty: number;
    unit: string;
    rate: number;
    discountPercent: number;
    taxable: number;
    gstRate: number;
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
  }>;
  hsnSummary: Array<{ hsn: string; gstRate: number; taxable: number; cgst: number; sgst: number; igst: number }>;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  cessTotal: number;
  roundOff: number;
  grandTotal: number;
  paid: number;
  balance: number;
}

function summarise(lines: PrintableInvoice["lines"]): PrintableInvoice["hsnSummary"] {
  const map = new Map<string, PrintableInvoice["hsnSummary"][number]>();
  for (const l of lines) {
    const key = `${l.hsn}|${l.gstRate}`;
    const row = map.get(key) ?? { hsn: l.hsn, gstRate: l.gstRate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    row.taxable += l.taxable;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.igst += l.igst;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.gstRate - b.gstRate);
}

/** Demo data: totals recomputed from the sample catalogue. */
export function printableFromDemo(invoice: Invoice): PrintableInvoice {
  const customer = customerById.get(invoice.customerId)!;
  const totals = invoiceTotals(invoice.lines, invoice.date, customer);
  const lines = invoice.lines.map((l, i) => {
    const p = productById.get(l.productId)!;
    const r = totals.lines[i]!;
    return {
      name: p.name,
      nameLocal: p.nameHi,
      batch: p.batch ? `${p.batch.number} · ${p.batch.expiry}` : null,
      hsn: p.hsn,
      qty: l.qty,
      unit: p.unit,
      rate: l.rate,
      discountPercent: l.discountPercent,
      taxable: r.taxable.toNumber(),
      gstRate: r.gstRate.toNumber(),
      cgst: r.cgst.toNumber(),
      sgst: r.sgst.toNumber(),
      igst: r.igst.toNumber(),
      total: r.total.toNumber(),
    };
  });
  const balance = invoice.total - invoice.paid;
  return {
    id: invoice.id,
    number: invoice.number,
    date: invoice.date,
    dueDate: invoice.dueDate,
    placeOfSupply: customer.stateCode,
    intraState: customer.stateCode === BUSINESS.stateCode,
    billOfSupply: false,
    reverseCharge: false,
    status: balance <= 0.5 ? "paid" : invoice.paid > 0 ? "partial" : "unpaid",
    customerId: customer.id,
    buyer: { businessName: customer.businessName, name: customer.name, address: customer.address, pincode: customer.pincode, stateCode: customer.stateCode, gstin: customer.gstin },
    lines,
    hsnSummary: summarise(lines),
    taxableTotal: totals.taxableTotal.toNumber(),
    cgstTotal: totals.cgstTotal.toNumber(),
    sgstTotal: totals.sgstTotal.toNumber(),
    igstTotal: totals.igstTotal.toNumber(),
    cessTotal: totals.cessTotal.toNumber(),
    roundOff: totals.roundOff.toNumber(),
    grandTotal: totals.grandTotal.toNumber(),
    paid: invoice.paid,
    balance,
  };
}

/** API invoice detail (GET /invoices/:id): the stored tax snapshot, never recomputed. */
export interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  documentKind: "tax_invoice" | "bill_of_supply";
  customerId: string;
  partyName: string;
  partyGstin: string | null;
  partyStateCode: string | null;
  billingAddress: { line1: string | null; line2: string | null; city: string | null; stateCode: string; pincode: string | null } | null;
  placeOfSupply: string;
  supplyType: "intra_state" | "inter_state";
  isReverseCharge: boolean;
  status: "posted" | "cancelled" | "draft";
  paymentStatus: "unpaid" | "partial" | "paid";
  taxableTotal: string;
  cgstTotal: string;
  sgstTotal: string;
  igstTotal: string;
  cessTotal: string;
  roundOff: string;
  grandTotal: string;
  amountPaid: string;
  balanceDue: string;
  items: Array<{
    productId: string;
    productName: string;
    hsnCode: string | null;
    unitId: string;
    qty: string;
    rate: string;
    discountPercent: string;
    taxableValue: string;
    gstRate: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    lineTotal: string;
  }>;
}

export function printableFromApi(inv: ApiInvoice): PrintableInvoice {
  const num = (v: string | null | undefined) => dec(v ?? 0).toNumber();
  const lines = inv.items.map((i) => {
    const product = productById.get(i.productId);
    return {
      name: i.productName,
      nameLocal: product?.nameHi ?? i.productName,
      batch: null,
      hsn: i.hsnCode ?? "",
      qty: num(i.qty),
      unit: WORKSPACE.units.get(i.unitId) ?? product?.unit ?? "",
      rate: num(i.rate),
      discountPercent: num(i.discountPercent),
      taxable: num(i.taxableValue),
      gstRate: num(i.gstRate),
      cgst: num(i.cgstAmount),
      sgst: num(i.sgstAmount),
      igst: num(i.igstAmount),
      total: num(i.lineTotal),
    };
  });
  const a = inv.billingAddress;
  return {
    id: inv.id,
    number: inv.invoiceNumber,
    date: inv.invoiceDate,
    dueDate: inv.dueDate ?? inv.invoiceDate,
    placeOfSupply: inv.placeOfSupply,
    intraState: inv.supplyType === "intra_state",
    billOfSupply: inv.documentKind === "bill_of_supply",
    reverseCharge: inv.isReverseCharge,
    status: inv.status === "cancelled" ? "cancelled" : inv.paymentStatus,
    customerId: inv.customerId,
    buyer: {
      businessName: inv.partyName,
      name: customerById.get(inv.customerId)?.name ?? "",
      address: [a?.line1, a?.line2, a?.city].filter(Boolean).join(", "),
      pincode: a?.pincode ?? "",
      stateCode: inv.partyStateCode ?? inv.placeOfSupply,
      gstin: inv.partyGstin,
    },
    lines,
    hsnSummary: summarise(lines),
    taxableTotal: num(inv.taxableTotal),
    cgstTotal: num(inv.cgstTotal),
    sgstTotal: num(inv.sgstTotal),
    igstTotal: num(inv.igstTotal),
    cessTotal: num(inv.cessTotal),
    roundOff: num(inv.roundOff),
    grandTotal: num(inv.grandTotal),
    paid: num(inv.amountPaid),
    balance: num(inv.balanceDue),
  };
}
