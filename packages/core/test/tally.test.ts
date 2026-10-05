import { describe, expect, it } from "vitest";
import { decodeTallyFile, documentEntries, paymentEntries, parseTallyMasters, parseXml, tallyImportXml, tallyNumber, tallyUnit } from "../src/index.js";

/** As TallyPrime writes "Export → Masters" (trimmed): groups, ledgers, a stock group and items. */
const MASTERS = `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY><IMPORTDATA>
  <REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>Sharma &amp; Sons</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
  <REQUESTDATA>
   <TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="Indore Debtors" RESERVEDNAME=""><PARENT>Sundry Debtors</PARENT></GROUP></TALLYMESSAGE>
   <TALLYMESSAGE xmlns:UDF="TallyUDF">
    <LEDGER NAME="Gupta Stores" RESERVEDNAME="">
     <ADDRESS.LIST TYPE="String"><ADDRESS>12, MG Road</ADDRESS><ADDRESS>Indore</ADDRESS></ADDRESS.LIST>
     <PARENT>Indore Debtors</PARENT>
     <LEDSTATENAME>Madhya Pradesh</LEDSTATENAME>
     <PINCODE>452001</PINCODE>
     <PARTYGSTIN>23AAACM1234M1ZR</PARTYGSTIN>
     <LEDGERMOBILE>+91 98260 11111</LEDGERMOBILE>
     <OPENINGBALANCE>-1500.00</OPENINGBALANCE>
     <LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>Gupta Stores</NAME></NAME.LIST></LANGUAGENAME.LIST>
    </LEDGER>
   </TALLYMESSAGE>
   <TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Advance Kirana"><PARENT>Sundry Debtors</PARENT><LEDGERPHONE>0731-2345</LEDGERPHONE><OPENINGBALANCE>200.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
   <TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Parle Agro Pvt Ltd"><PARENT>Sundry Creditors</PARENT><STATENAME>Maharashtra</STATENAME><OPENINGBALANCE>25000.50</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
   <TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Sales @ 18%"><PARENT>Sales Accounts</PARENT></LEDGER></TALLYMESSAGE>
   <TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKGROUP NAME="Biscuits"><PARENT/><GSTDETAILS.LIST><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE> 18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST></STOCKGROUP></TALLYMESSAGE>
   <TALLYMESSAGE xmlns:UDF="TallyUDF">
    <STOCKITEM NAME="Parle-G 100g">
     <PARENT>Biscuits</PARENT>
     <BASEUNITS>Nos</BASEUNITS>
     <GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>1905</HSNCODE><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD><GSTRATE> 9</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE> 18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
     <GSTDETAILS.LIST><APPLICABLEFROM>20250922</APPLICABLEFROM><HSNCODE>1905</HSNCODE><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE> 5</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>
     <OPENINGBALANCE> 100 Nos</OPENINGBALANCE>
     <OPENINGVALUE>-800.00</OPENINGVALUE>
     <OPENINGRATE>8.00/Nos</OPENINGRATE>
     <MRPDETAILS.LIST><MRPRATEDETAILS.LIST><MRPRATE>12.00/Nos</MRPRATE></MRPRATEDETAILS.LIST></MRPDETAILS.LIST>
     <FULLPRICELIST.LIST><PRICELEVEL>Retail</PRICELEVEL><PRICELEVELLIST.LIST><RATE>10.00/Nos</RATE></PRICELEVELLIST.LIST></FULLPRICELIST.LIST>
    </STOCKITEM>
   </TALLYMESSAGE>
   <TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="Marie Gold"><PARENT>Biscuits</PARENT><BASEUNITS>Pkt</BASEUNITS><OPENINGBALANCE> 24 Pkt</OPENINGBALANCE><OPENINGVALUE>-480.00</OPENINGVALUE></STOCKITEM></TALLYMESSAGE>
   <TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="Rice &#4;"><BASEUNITS>Kgs</BASEUNITS><GSTDETAILS.LIST><TAXABILITY>Exempt</TAXABILITY></GSTDETAILS.LIST></STOCKITEM></TALLYMESSAGE>
  </REQUESTDATA>
 </IMPORTDATA></BODY>
</ENVELOPE>`;

describe("Tally masters", () => {
  const m = parseTallyMasters(MASTERS);

  it("reads debtors as customers, with the receivable opening balance", () => {
    expect(m.company).toBe("Sharma & Sons");
    expect(m.customers).toEqual([
      { name: "Gupta Stores", gstin: "23AAACM1234M1ZR", state: "Madhya Pradesh", mobile: "9826011111", address: "12, MG Road, Indore", pincode: "452001", opening_balance: "1500.00" },
      // A credit balance on a debtor is an advance: negative receivable. A landline is not a mobile.
      { name: "Advance Kirana", opening_balance: "-200.00" },
    ]);
  });

  it("reads creditors as suppliers, with the payable opening balance, and leaves other ledgers out", () => {
    expect(m.suppliers).toEqual([{ name: "Parle Agro Pvt Ltd", state: "Maharashtra", opening_balance: "25000.50" }]);
    expect(m.otherLedgers).toBe(1);
  });

  it("reads stock items with unit, HSN, the latest GST rate, opening stock and rates", () => {
    expect(m.products[0]).toEqual({ name: "Parle-G 100g", unit: "NOS", hsn: "1905", gst: "5", category: "Biscuits", opening_stock: "100", purchase_price: "8.00", selling_price: "10.00", mrp: "12.00" });
    // No GST on the item: its stock group's; no rate: value ÷ quantity.
    expect(m.products[1]).toEqual({ name: "Marie Gold", unit: "PAC", gst: "18", category: "Biscuits", opening_stock: "24", purchase_price: "20.00" });
    expect(m.products[2]).toEqual({ name: "Rice", unit: "KG", gst: "exempt" });
  });

  it("decodes Tally's UTF-16 files", () => {
    const text = "<ENVELOPE><LEDGER NAME=\"राम\"><PARENT>Sundry Debtors</PARENT></LEDGER></ENVELOPE>";
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      bytes[2 + i * 2] = text.charCodeAt(i) & 0xff;
      bytes[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    expect(parseTallyMasters(decodeTallyFile(bytes)).customers).toEqual([{ name: "राम" }]);
  });

  it("parses numbers and units the way Tally writes them", () => {
    expect(tallyNumber(" 1,250.50/Nos")).toBe(1250.5);
    expect(tallyNumber("")).toBeNull();
    expect(tallyUnit("Kgs.")).toBe("KG");
    expect(tallyUnit("Bundle")).toBe("BUNDLE");
  });
});

describe("Tally vouchers", () => {
  it("balances a sale with GST and round off, the party debited", () => {
    const e = documentEntries({ cgstTotal: "9.00", sgstTotal: "9.00", igstTotal: "0", cessTotal: "0", roundOff: "0.40", grandTotal: "118.00" }, "Gupta Stores", "sales", 1);
    expect(e).toEqual([
      { ledger: "Gupta Stores", amount: 118, party: true },
      { ledger: "Sales", amount: -99.6 },
      { ledger: "Output CGST", amount: -9 },
      { ledger: "Output SGST", amount: -9 },
      { ledger: "Round Off", amount: -0.4 },
    ]);
  });

  it("leaves the GST out of a reverse-charge purchase", () => {
    const e = documentEntries({ cgstTotal: "0", sgstTotal: "0", igstTotal: "180", cessTotal: "0", roundOff: "0", grandTotal: "1000", isReverseCharge: true }, "Transporter", "purchase", -1);
    expect(e).toEqual([
      { ledger: "Transporter", amount: -1000, party: true },
      { ledger: "Purchase", amount: 1000 },
    ]);
  });

  it("writes an import file Tally reads: ledgers, then balanced vouchers with debits negative", () => {
    const xml = tallyImportXml({
      company: "Sharma & Sons",
      ledgers: [{ name: "Gupta Stores", parent: "Sundry Debtors", gstin: "23AAACM1234M1ZR", stateName: "Madhya Pradesh" }],
      vouchers: [
        { type: "Receipt", date: "2026-10-05", number: "RCT/1", party: "Gupta Stores", entries: paymentEntries("50.00", "Gupta Stores", true, "in") },
        {
          type: "Sales",
          date: "2026-10-04",
          number: "INV/26-27/00001",
          party: "Gupta Stores",
          entries: documentEntries({ cgstTotal: "9", sgstTotal: "9", igstTotal: "0", cessTotal: "0", roundOff: "0", grandTotal: "118" }, "Gupta Stores", "sales", 1),
        },
      ],
    });
    const doc = parseXml(xml);
    const vouchers = doc.children[0]!.children[1]!.children[0]!.children[1]!.children.map((m) => m.children[0]!);
    expect(vouchers.map((v) => `${v.name} ${v.attrs.VCHTYPE ?? v.attrs.NAME}`)).toEqual(["LEDGER Gupta Stores", "VOUCHER Sales", "VOUCHER Receipt"]);
    expect(xml).toContain("<SVCURRENTCOMPANY>Sharma &amp; Sons</SVCURRENTCOMPANY>");
    expect(xml).toContain("<DATE>20261004</DATE>");
    expect(xml).toContain("<LEDGERNAME>Gupta Stores</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-118.00</AMOUNT>");
    expect(xml).toContain("<BILLALLOCATIONS.LIST><NAME>INV/26-27/00001</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-118.00</AMOUNT>");
    expect(xml).toContain("<LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>No</ISPARTYLEDGER><AMOUNT>-50.00</AMOUNT>");
  });

  it("refuses a voucher that does not balance", () => {
    expect(() => tallyImportXml({ ledgers: [], vouchers: [{ type: "Sales", date: "2026-10-04", number: "X", party: "A", entries: [{ ledger: "A", amount: 10, party: true }] }] })).toThrow(/does not balance/);
  });
});
