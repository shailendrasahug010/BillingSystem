/**
 * Builds the PDF files the PDF flow uploads, the way billing software prints
 * them: a supplier's tax invoice (seller's name and GSTIN on top, bill number
 * and date above the table, a wrapped item name, totals and amount in words
 * below), a company price list, and a big company's two-page tax invoice. Chromium prints them to real PDFs.
 *   PLAYWRIGHT_PATH=/path/to/node_modules node apps/web/e2e/fixtures/make-pdf-fixtures.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));

const css = `
  body { font: 10px/1.35 Arial, Helvetica, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 17px; margin: 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid #555; padding: 3px 5px; vertical-align: top; }
  th { background: #eee; text-align: left; }
  td.n, th.n { text-align: right; }
  .row { display: flex; justify-content: space-between; margin-top: 4px; }
  .box { border: 1px solid #555; padding: 5px; margin-top: 6px; }
  .name { width: 150px; }
`;

const bill = `<html><head><style>${css}</style></head><body>
  <h1>SHREE GANESH AGENCIES</h1>
  <div>12 Siyaganj, Indore 452007 · Ph 0731-2531234</div>
  <div>GSTIN: 23AAACM1234M1ZR · State: 23 Madhya Pradesh</div>
  <div style="text-align:center;font-weight:bold;font-size:13px;margin-top:6px">TAX INVOICE</div>
  <div class="row"><span>Invoice No. : SG/1044</span><span>Date : 24-09-2026</span></div>
  <div class="box">Bill To: Anand Distributors, Indore · GSTIN: 23AAGFG5678G1ZA</div>
  <table>
    <tr><th>Sr</th><th class="name">Particulars</th><th>HSN</th><th>Batch</th><th>Exp</th><th class="n">Qty</th><th class="n">Free</th><th class="n">MRP</th><th class="n">Rate</th><th class="n">Disc %</th><th class="n">GST %</th><th class="n">Amount</th></tr>
    <tr><td>1</td><td class="name">SURF EXCEL EASY WASH<br>1KG</td><td>3402</td><td></td><td></td><td class="n">2 CS</td><td class="n"></td><td class="n">140.00</td><td class="n">1,380.00</td><td class="n">2.5</td><td class="n">18</td><td class="n">2,691.00</td></tr>
    <tr><td>2</td><td class="name">PARLE-G BISCUIT 100G</td><td>1905</td><td>B2291</td><td>08/27</td><td class="n">240</td><td class="n">12</td><td class="n">10.00</td><td class="n">8.00</td><td class="n"></td><td class="n">5</td><td class="n">1,920.00</td></tr>
    <tr><td>3</td><td class="name">TATA SALT 1KG</td><td>2501</td><td></td><td></td><td class="n">50</td><td class="n"></td><td class="n">28.00</td><td class="n">22.00</td><td class="n"></td><td class="n">0</td><td class="n">1,100.00</td></tr>
    <tr><td>4</td><td class="name">HARPIC 500ML</td><td>3402</td><td></td><td></td><td class="n">12</td><td class="n"></td><td class="n">99.00</td><td class="n">85.00</td><td class="n"></td><td class="n">18</td><td class="n">1,020.00</td></tr>
    <tr><td></td><td class="name">Total</td><td></td><td></td><td></td><td class="n"></td><td class="n"></td><td class="n"></td><td class="n"></td><td class="n"></td><td class="n"></td><td class="n">6,731.00</td></tr>
  </table>
  <div class="row"><span>CGST 381.99 · SGST 381.99 · Round off 0.02</span><span><b>Grand Total : 7,495.00</b></span></div>
  <div>Rupees Seven Thousand Four Hundred Ninety Five Only</div>
  <div class="box">Bank: SBI Siyaganj · A/c 30012345678 · IFSC SBIN0001234 · Goods once sold will not be taken back.</div>
</body></html>`;

const priceList = `<html><head><style>${css}</style></head><body>
  <h1>Price List · September 2026</h1>
  <div>Shree Ganesh Agencies, Indore · Rates before GST</div>
  <table>
    <tr><th>Item Name</th><th>HSN Code</th><th class="n">GST %</th><th>UOM</th><th>Case Unit</th><th class="n">Case Size</th><th class="n">MRP</th><th class="n">Sale Price</th><th class="n">Purchase Rate</th></tr>
    <tr><td>Surf Excel Easy Wash 1kg</td><td>3402</td><td class="n">18</td><td>PCS</td><td>CTN</td><td class="n">12</td><td class="n">140</td><td class="n">128</td><td class="n">115</td></tr>
    <tr><td>Parle-G Biscuit 100g</td><td>1905</td><td class="n">5</td><td>PCS</td><td>BOX</td><td class="n">24</td><td class="n">10</td><td class="n">9.20</td><td class="n">8</td></tr>
    <tr><td>Tata Salt 1kg</td><td>2501</td><td class="n">0</td><td>PCS</td><td></td><td class="n"></td><td class="n">28</td><td class="n">25</td><td class="n">22</td></tr>
    <tr><td>Harpic Toilet Cleaner 500ml</td><td>3402</td><td class="n">18</td><td>PCS</td><td></td><td class="n"></td><td class="n">99</td><td class="n">90</td><td class="n">81</td></tr>
    <tr><td>Vim Bar 200g</td><td>3402</td><td class="n">18</td><td>PCS</td><td>BOX</td><td class="n">48</td><td class="n">20</td><td class="n">18</td><td class="n">16</td></tr>
  </table>
</body></html>`;

// A company's tax invoice (made-up firm and brands) laid out the way big FMCG makers print
// theirs: headings over three lines, each item's name above and below its numbers, the tax
// written as "CGST@6 + SGST@6", the table running on to page 2 without the heading, and
// "Page 1 of 2" footers.
const snacks = [
  ["MALWA Namkeen Moon Chips Tomato 11 gm 96 Pkt Rs 5 - With Party Toys", "21069099", 20, "Bag", "314.0300", 12],
  ["MALWA Namkeen Moon Chips Masala 12 gm 96 Pkt Rs 5 - With Pop Tube Toys", "21069099", 20, "Bag", "314.0300", 12],
  ["MALWA Namkeen Salted Crunchy Pipe 18 Gm 180 Pkt Rs 5", "21069099", 70, "Carton", "588.8001", 12],
  ["MALWA Namkeen Chilli Noodles 18 Gm 180 Pkt Rs 5", "21069099", 86, "Carton", "588.8001", 12],
  ["MS Namkeen Tasty 18 gm 240 pkt Rs 5", "21069099", 30, "Carton", "816.4700", 12],
  ["MS Namkeen Punjabi Tadka 18 gm 240 pkt Rs 5", "21069099", 10, "Carton", "816.4700", 12],
  ["MS Namkeen Bhavnagari Gathiya 20 gm 240 Pkt Rs 5", "21069099", 25, "Carton", "816.4700", 12],
  ["MS Namkeen Aloo Bhujia 20 gm 240 pkt Rs 5", "21069099", 50, "Carton", "816.4702", 12],
  ["MS Namkeen Mitha Falahari 20 gm 240 pkt Rs 5", "21069099", 20, "Carton", "816.4700", 12],
  ["MS Namkeen Khatta Mitha 20 gm 240 pkt Rs 5", "21069099", 15, "Carton", "816.4700", 12],
  ["MS Namkeen Ratlami Sev 20 gm 240 pkt Rs 5", "21069099", 30, "Carton", "816.4700", 12],
  ["Adhesive Tape", "39199090", 1, "Piece", "40.0000", 18],
  ["Corrugated Box Chips 280 Pkt", "48191010", 15, "Piece", "2.0000", 12],
  ["MS Popcorn Simply Salted 13 gm 280 pkt Rs 5", "21069099", 20, "Carton", "915.9200", 12],
  ["Hanger", "73012090", 150, "Piece", "0.1000", 18],
  ["MS Namkeen Puff Tomato 20 gm 210 pkt Rs 5", "21069099", 80, "Carton", "748.7701", 12],
];
const r2 = (n) => Math.round(n * 100) / 100;
const f2 = (n) => n.toFixed(2);
let net = 0;
let half = 0;
const snackRows = snacks
  .map(([name, hsn, qty, uom, rate, gst], i) => {
    const value = r2(qty * Number(rate));
    const tax = r2((value * gst) / 200);
    net += value;
    half += tax;
    return `<tr><td>${i + 1}</td><td class="desc">${name}</td><td>${hsn}</td><td class="n">${f2(qty)}</td><td>${uom}</td><td class="n">${rate}</td><td class="tax">CGST@${gst / 2} + SGST@${gst / 2}</td><td class="n">${f2(value)}</td><td class="n">${f2(tax)}</td><td class="n">${f2(tax)}</td><td class="n">0.00</td><td class="n">${f2(r2(value + 2 * tax))}</td></tr>`;
  })
  .join("");
const companyInvoice = `<html><head><style>${css}
  .inv td, .inv th { vertical-align: middle; padding: 7px 3px; font-size: 8px; }
  .inv th { text-align: center; background: none; }
  .inv td.desc { width: 105px; }
  .inv td.tax { width: 34px; text-align: center; }
  .kv td { border: none; padding: 1px 4px; }
</style></head><body>
  <div style="text-align:right">Org/Dup/Trip</div>
  <div style="text-align:center;font-weight:bold;font-size:12px">TAX INVOICE</div>
  <h1 style="text-align:center">Malwa Snacks Limited</h1>
  <div>Billing Address : Plot 12, Sector C, Sanwer Road Industrial Area, Indore - 452015, INDIA</div>
  <div class="row"><table class="kv" style="width:48%"><tr><td>Bill To Party :</td><td>0000104410</td></tr><tr><td colspan="2">Anand Distributors</td></tr><tr><td>GSTIN</td><td>: 23AAGFG5678G1ZA</td></tr></table>
  <table class="kv" style="width:48%"><tr><td>GSTIN</td><td>: 23AAACM1234M1ZR</td></tr><tr><td>Invoice No.</td><td>: 2500104410</td></tr><tr><td>Invoice Date</td><td>: 24/08/2025</td></tr><tr><td>Payment Terms</td><td>: Cash Basis</td></tr></table></div>
  <table class="inv">
    <tbody>
      <tr><th>SR.<br>No</th><th>Description</th><th>HSN<br>/SAC</th><th>Qty</th><th>UOM</th><th>Unit Price</th><th>Tax %</th><th>Net Value</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total</th></tr>
      ${snackRows}
      <tr><td></td><td colspan="6">Total Sales Value</td><td class="n">${f2(r2(net))}</td><td class="n">${f2(r2(half))}</td><td class="n">${f2(r2(half))}</td><td class="n">0.00</td><td class="n">${f2(r2(net + 2 * half))}</td></tr>
    </tbody>
  </table>
  <div class="row"><span>Grand Total</span><b>${f2(r2(net + 2 * half))}</b></div>
  <div class="box">Bank Details for Remittance : Payee Name : Malwa Snacks Ltd · IFSC : SBIN0001234</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
const footer = `<div style="font: 8px Arial; width: 100%; padding: 0 12mm; display: flex; gap: 40mm"><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span><span>Subject to Indore Jurisdiction</span></div>`;
for (const [name, html, pageFooter] of [
  ["supplier-bill.pdf", bill],
  ["price-list.pdf", priceList],
  ["company-invoice.pdf", companyInvoice, footer],
]) {
  await page.setContent(html);
  await page.pdf({
    path: join(HERE, name),
    format: "A4",
    margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
    ...(pageFooter ? { displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: pageFooter } : {}),
  });
  console.log("written", name);
}
await browser.close();
