/**
 * Builds the PDF files the PDF flow uploads, the way billing software prints
 * them: a supplier's tax invoice (seller's name and GSTIN on top, bill number
 * and date above the table, a wrapped item name, totals and amount in words
 * below) and a company price list. Chromium prints them to real PDFs.
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

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, html] of [
  ["supplier-bill.pdf", bill],
  ["price-list.pdf", priceList],
]) {
  await page.setContent(html);
  await page.pdf({ path: join(HERE, name), format: "A4", margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } });
  console.log("written", name);
}
await browser.close();
