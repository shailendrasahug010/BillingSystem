import { amountInWords, findState, upiPayLink, UPI_ID } from "@digitalbahi/core";
import { createTranslator, formatAmount, formatCurrency, formatDate, type LocaleCode } from "@digitalbahi/i18n";
import { BUSINESS } from "../../data/db";
import type { PrintableInvoice } from "../../features/invoice/printable";
import type { PrintablePayment } from "../../features/payments/ReceiptDocument";
import type { ReceiptItem } from "./draw";

/** A quantity as people write it: 12, 2.5, 0.25. */
const qty = (v: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(v);

/** The firm at the top of every receipt: name, address, phone, GSTIN. */
function firmHeader(): ReceiptItem[] {
  const address = [BUSINESS.address, BUSINESS.city].filter(Boolean).join(", ");
  const contact = [BUSINESS.phone, BUSINESS.email].filter(Boolean).join(" · ");
  return [
    { t: "text", text: BUSINESS.name, align: "center", scale: 1.35, bold: true },
    ...(address ? [{ t: "text" as const, text: address, align: "center" as const, scale: 0.85 }] : []),
    ...(contact ? [{ t: "text" as const, text: contact, align: "center" as const, scale: 0.85 }] : []),
    ...(BUSINESS.gstin ? [{ t: "text" as const, text: `GSTIN ${BUSINESS.gstin}`, align: "center" as const, scale: 0.85 }] : []),
  ];
}

/** A UPI QR code for what is still owed, when the firm has a UPI ID. */
function payByUpi(amount: number, note: string, locale: LocaleCode): ReceiptItem[] {
  const upi = BUSINESS.bank?.upi?.trim();
  if (!upi || !UPI_ID.test(upi) || amount < 1) return [];
  const { t } = createTranslator(locale);
  return [
    { t: "space" },
    { t: "qr", text: upiPayLink({ upiId: upi, name: BUSINESS.name, amount, note }) },
    { t: "text", text: t("thermal.scanToPay", { amount: formatCurrency(amount, locale) }), align: "center", scale: 0.85 },
    { t: "text", text: upi, align: "center", scale: 0.85 },
  ];
}

/** A bill (or credit / debit note) as a thermal receipt, in the language chosen for printing. */
export function invoiceReceipt(inv: PrintableInvoice, locale: LocaleCode): ReceiptItem[] {
  const { t } = createTranslator(locale);
  const m = (v: number) => formatCurrency(v, locale);
  const n = (v: number) => formatAmount(v, locale);
  const isNote = inv.kind === "credit_note" || inv.kind === "debit_note";
  const title = isNote ? t(inv.kind === "credit_note" ? "notes.creditNote" : "notes.debitNote") : inv.billOfSupply ? t("invoice.billOfSupply") : t("invoice.taxInvoice");
  const pos = findState(inv.placeOfSupply);
  const sgst = pos?.component === "UTGST" ? "UTGST" : "SGST";
  const items: ReceiptItem[] = [
    ...firmHeader(),
    { t: "rule" },
    { t: "text", text: title.toUpperCase(), align: "center", bold: true },
    ...(inv.status === "cancelled" ? [{ t: "text" as const, text: t("status.document.cancelled").toUpperCase(), align: "center" as const, bold: true }] : []),
    { t: "pair", left: inv.number, right: formatDate(inv.date), bold: true },
    ...(inv.against ? [{ t: "text" as const, text: `${t("notes.against")} ${inv.against.number} · ${formatDate(inv.against.date)}`, scale: 0.85 }] : []),
    { t: "text", text: `${t("invoice.print.billTo")}: ${inv.buyer.businessName}`, bold: true },
    ...(inv.buyer.gstin ? [{ t: "text" as const, text: `GSTIN ${inv.buyer.gstin}`, scale: 0.85 }] : []),
    ...(!inv.intraState && pos ? [{ t: "text" as const, text: `${t("invoice.placeOfSupply")}: ${locale === "hi" ? pos.nameHi : pos.name} (${pos.code})`, scale: 0.85 }] : []),
    { t: "rule" },
  ];
  for (const l of inv.lines) {
    items.push({ t: "text", text: locale === "hi" && l.nameLocal ? l.nameLocal : l.name, bold: true, scale: 0.95 });
    const detail = [`${qty(l.qty)} ${l.unit} × ${n(l.rate)}`, l.discountPercent ? `-${l.discountPercent}%` : null, l.hsn ? `${t("invoice.hsn")} ${l.hsn}` : null, inv.billOfSupply ? null : `${l.gstRate}%`].filter(Boolean).join(" · ");
    items.push({ t: "pair", left: detail, right: n(l.taxable), scale: 0.85 });
    if (l.batch) items.push({ t: "text", text: `${t("invoice.batch")} ${l.batch}`, scale: 0.8 });
  }
  items.push({ t: "rule" }, { t: "pair", left: t("invoice.taxableValue"), right: m(inv.taxableTotal), scale: 0.9 });
  if (!inv.billOfSupply) {
    if (inv.intraState) items.push({ t: "pair", left: "CGST", right: m(inv.cgstTotal), scale: 0.9 }, { t: "pair", left: sgst, right: m(inv.sgstTotal), scale: 0.9 });
    else items.push({ t: "pair", left: "IGST", right: m(inv.igstTotal), scale: 0.9 });
  }
  if (inv.cessTotal > 0) items.push({ t: "pair", left: t("invoice.cess"), right: m(inv.cessTotal), scale: 0.9 });
  if (Math.abs(inv.roundOff) >= 0.005) items.push({ t: "pair", left: t("invoice.roundOff"), right: m(inv.roundOff), scale: 0.9 });
  items.push({ t: "pair", left: t("invoice.grandTotal"), right: m(inv.grandTotal), bold: true, scale: 1.2 });
  items.push({ t: "text", text: amountInWords(inv.grandTotal, locale), scale: 0.8 });
  if (inv.reverseCharge) items.push({ t: "text", text: t("invoice.print.rcmNotIncluded"), scale: 0.8 });
  if (!isNote && inv.status !== "cancelled" && inv.paid > 0) items.push({ t: "pair", left: t("invoice.print.paid"), right: m(inv.paid), scale: 0.9 });
  if (!isNote && inv.status !== "cancelled" && inv.balance > 0.5) items.push({ t: "pair", left: t("invoice.balance"), right: m(inv.balance), bold: true });
  items.push({ t: "rule" });
  if (!isNote && inv.status !== "cancelled") items.push(...payByUpi(inv.balance, inv.number, locale));
  items.push({ t: "text", text: t("thermal.thanks"), align: "center" }, { t: "text", text: t("invoice.print.computerGenerated"), align: "center", scale: 0.75 });
  return items;
}

/** Money received (or paid out) as a thermal receipt. */
export function paymentReceipt(p: PrintablePayment, locale: LocaleCode): ReceiptItem[] {
  const { t } = createTranslator(locale);
  const m = (v: string | number) => formatCurrency(v, locale);
  const bills = p.allocations.filter((a) => !a.reversedAt);
  const mode = [t(`paymentMethod.${p.method}`), p.referenceNumber, p.chequeDate ? formatDate(p.chequeDate) : null, p.chequeBank].filter(Boolean).join(" · ");
  return [
    ...firmHeader(),
    { t: "rule" },
    { t: "text", text: (p.direction === "in" ? t("receipt.title") : t("receipt.voucher")).toUpperCase(), align: "center", bold: true },
    ...(p.status === "cancelled" ? [{ t: "text" as const, text: t("status.document.cancelled").toUpperCase(), align: "center" as const, bold: true }] : []),
    { t: "pair", left: p.paymentNumber, right: formatDate(p.paymentDate) },
    { t: "text", text: `${p.direction === "in" ? t("receipt.receivedFrom") : t("receipt.paidTo")}: ${p.partyName}`, bold: true },
    { t: "rule" },
    { t: "pair", left: t("receipt.amount"), right: m(p.amount), bold: true, scale: 1.2 },
    { t: "text", text: amountInWords(p.amount, locale), scale: 0.8 },
    { t: "pair", left: t("receipt.mode"), right: mode, scale: 0.9 },
    ...bills.map((a) => ({ t: "pair" as const, left: `${t("receipt.against")} ${a.documentNumber ?? "—"}`, right: m(a.amount), scale: 0.9 })),
    ...(Number(p.unallocatedAmount) > 0 ? [{ t: "pair" as const, left: t("receipt.onAccount"), right: m(p.unallocatedAmount), scale: 0.9 }] : []),
    ...(p.notes ? [{ t: "text" as const, text: p.notes, scale: 0.85 }] : []),
    ...(p.method === "cheque" && p.direction === "in" ? [{ t: "text" as const, text: t("receipt.chequeNote"), scale: 0.8 }] : []),
    { t: "rule" },
    { t: "space", px: 36 },
    { t: "text", text: t("invoice.print.signatory"), align: "right", scale: 0.85 },
    { t: "text", text: t("receipt.computerGenerated"), align: "center", scale: 0.75 },
  ];
}

/** A page to check the printer: the firm, both languages, a QR code. */
export function testReceipt(locale: LocaleCode, paper: number): ReceiptItem[] {
  const { t } = createTranslator(locale);
  return [
    ...firmHeader(),
    { t: "rule" },
    { t: "text", text: t("thermal.testTitle").toUpperCase(), align: "center", bold: true },
    { t: "text", text: t("thermal.testLine"), align: "center" },
    { t: "text", text: "Digital Bahi · डिजिटल बही", align: "center", scale: 1.1 },
    { t: "pair", left: "₹ 1,23,456.78", right: `${paper} mm` },
    { t: "qr", text: `Digital Bahi printer test · ${BUSINESS.name}` },
    { t: "rule" },
  ];
}
