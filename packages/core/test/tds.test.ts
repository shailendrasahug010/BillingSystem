import { describe, expect, it } from "vitest";
import { partyPan, purchaseTds, taxQuarterOf, taxYearOf, tdsDueDate } from "../src/index.js";

describe("TDS on buying goods (393(1), old 194Q)", () => {
  it("is on what takes the year's purchases from the seller past ₹50 lakh, at 0.1%, to the rupee", () => {
    // Below the threshold all year: nothing.
    expect(purchaseTds({ boughtBefore: "3000000", billValue: "1500000", hasPan: true }).amount.toString()).toBe("0");
    // ₹45 lakh before, a ₹10 lakh bill: ₹5 lakh over, ₹500.
    const crossing = purchaseTds({ boughtBefore: "4500000", billValue: "1000000", hasPan: true });
    expect([crossing.base.toFixed(2), crossing.rate.toString(), crossing.amount.toString()]).toEqual(["500000.00", "0.1", "500"]);
    // Past it already: the whole bill. ₹1,23,456.78 at 0.1% = ₹123.46, rounded to ₹123.
    expect(purchaseTds({ boughtBefore: "6000000", billValue: "123456.78", hasPan: true }).amount.toString()).toBe("123");
    // Exactly at the threshold: nothing over.
    expect(purchaseTds({ boughtBefore: "4000000", billValue: "1000000", hasPan: true }).base.toFixed(2)).toBe("0.00");
  });

  it("is 5% when the seller has no PAN", () => {
    const t = purchaseTds({ boughtBefore: "5000000", billValue: "20000", hasPan: false });
    expect([t.rate.toString(), t.amount.toString()]).toEqual(["5", "1000"]);
  });

  it("follows a business's own rule (a changed threshold or rate)", () => {
    expect(purchaseTds({ boughtBefore: "0", billValue: "200000", hasPan: true }, { rate: "1", noPanRate: "5", threshold: "100000" }).amount.toString()).toBe("1000");
  });
});

describe("tax years, quarters and due dates", () => {
  it("runs the tax year April to March and its quarters by three months", () => {
    expect(taxYearOf("2026-10-12")).toEqual({ label: "2026-27", from: "2026-04-01", to: "2027-03-31" });
    expect(taxYearOf("2027-02-01").label).toBe("2026-27");
    expect(taxQuarterOf("2026-04-01")).toEqual({ quarter: 1, year: "2026-27", from: "2026-04-01", to: "2026-06-30" });
    expect(taxQuarterOf("2026-10-12")).toEqual({ quarter: 3, year: "2026-27", from: "2026-10-01", to: "2026-12-31" });
    expect(taxQuarterOf("2027-03-31")).toEqual({ quarter: 4, year: "2026-27", from: "2027-01-01", to: "2027-03-31" });
  });

  it("is paid by the 7th of the next month, March's by 30 April", () => {
    expect(tdsDueDate("2026-09")).toBe("2026-10-07");
    expect(tdsDueDate("2026-12")).toBe("2027-01-07");
    expect(tdsDueDate("2027-03")).toBe("2027-04-30");
  });

  it("takes a party's PAN as entered, else from its GSTIN", () => {
    expect(partyPan({ pan: "aaacm1234m", gstin: null })).toBe("AAACM1234M");
    expect(partyPan({ pan: null, gstin: "23AAACM1234M1ZR" })).toBe("AAACM1234M");
    expect(partyPan({ pan: "", gstin: null })).toBeNull();
    expect(partyPan({ pan: "NOTAPAN", gstin: null })).toBeNull();
  });
});
