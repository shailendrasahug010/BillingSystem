import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  amountInWords,
  DEFAULT_ROLES,
  expandGrants,
  financialYearOf,
  formatDocumentNumber,
  hasPermission,
  normalizeIndianMobile,
  panFromGstin,
  requiredHsnDigits,
  validateDocumentNumber,
  validateGstin,
  validateHsn,
  validateIfsc,
  validatePan,
  validatePincode,
  validateSeriesPattern,
} from "../src/index.js";

describe("GSTIN", () => {
  it("accepts a valid GSTIN and verifies the check character", () => {
    expect(validateGstin("27AAPFU0939F1ZV")).toEqual([]);
    expect(validateGstin(" 27aapfu0939f1zv ")).toEqual([]);
    expect(panFromGstin("27AAPFU0939F1ZV")).toBe("AAPFU0939F");
  });

  it("reports precise issues", () => {
    expect(validateGstin("")).toEqual(["required"]);
    expect(validateGstin("27AAPFU0939F1Z")).toEqual(["invalid_format"]);
    expect(validateGstin("27AAPFU0939F1ZX")).toEqual(["invalid_checksum"]);
    expect(validateGstin("27AAPFU0939F1ZV", { expectedStateCode: "23" })).toEqual(["state_mismatch"]);
  });
});

describe("other identifiers", () => {
  it("normalises Indian mobile numbers", () => {
    expect(normalizeIndianMobile("+91 98765-43210")).toBe("9876543210");
    expect(normalizeIndianMobile("09876543210")).toBe("9876543210");
    expect(normalizeIndianMobile("919876543210")).toBe("9876543210");
    expect(normalizeIndianMobile("12345")).toBeNull();
    expect(normalizeIndianMobile("5876543210")).toBeNull();
  });

  it("validates PAN, pincode, IFSC and HSN", () => {
    expect(validatePan("AAPFU0939F")).toEqual([]);
    expect(validatePan("AAPF0939F")).toEqual(["invalid_format"]);
    expect(validatePincode("462001")).toEqual([]);
    expect(validatePincode("062001")).toEqual(["invalid_format"]);
    expect(validateIfsc("SBIN0001234")).toEqual([]);
    expect(validateIfsc("SBIN1001234")).toEqual(["invalid_format"]);
    expect(validateHsn("1905")).toEqual([]);
    expect(validateHsn("190590")).toEqual([]);
    expect(validateHsn("19059")).toEqual(["invalid_format"]);
  });

  it("reads HSN digit requirements from configuration", () => {
    const rules = [
      { maxTurnover: 50_000_000, digits: 4 as const },
      { maxTurnover: null, digits: 6 as const },
    ];
    expect(requiredHsnDigits(20_000_000, rules)).toBe(4);
    expect(requiredHsnDigits(80_000_000, rules)).toBe(6);
  });
});

describe("financial year and numbering", () => {
  it("computes the April-March financial year", () => {
    expect(financialYearOf("2026-03-31").label).toBe("2025-26");
    expect(financialYearOf("2026-04-01")).toEqual({
      startYear: 2026,
      label: "2026-27",
      startDate: "2026-04-01",
      endDate: "2027-03-31",
    });
    expect(financialYearOf("2026-09-24", 1).label).toBe("2026");
  });

  it("formats series patterns", () => {
    expect(formatDocumentNumber("INV/{FY}/{SEQ:5}", { seq: 42, date: "2026-09-24" })).toBe("INV/2026-27/00042");
    expect(formatDocumentNumber("{DEVICE}/{FY2}/{SEQ:4}", { seq: 7, date: "2027-01-05", deviceCode: "A1" })).toBe(
      "A1/2627/0007",
    );
    expect(formatDocumentNumber("SO-{YY}{MM}-{SEQ}", { seq: 1234, date: "2026-09-24" })).toBe("SO-2609-1234");
  });

  it("enforces the GST invoice number limits", () => {
    expect(validateDocumentNumber("INV/2026-27/00042")).toEqual(["too_long"]); // 17 chars
    expect(validateDocumentNumber("INV/26-27/00042")).toEqual([]);
    expect(validateDocumentNumber("INV 42")).toEqual(["invalid_characters"]);
    expect(validateSeriesPattern("INV/{FY}/{SEQ:5}", { date: "2026-09-24" })).toEqual(["too_long"]);
    expect(validateSeriesPattern("INV/{FYS}/{SEQ:5}", { date: "2026-09-24" })).toEqual([]);
  });
});

describe("amount in words", () => {
  it("uses the Indian numbering system in English", () => {
    expect(amountInWords("2987")).toBe("Rupees Two Thousand Nine Hundred Eighty Seven Only");
    expect(amountInWords("123456.78")).toBe(
      "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only",
    );
    expect(amountInWords("1250000000")).toBe("Rupees One Hundred Twenty Five Crore Only");
  });

  it("supports Hindi", () => {
    expect(amountInWords("123456.78", "hi")).toBe("एक लाख तेईस हज़ार चार सौ छप्पन रुपये और अठहत्तर पैसे मात्र");
    expect(amountInWords("2987", "hi")).toBe("दो हज़ार नौ सौ सत्तासी रुपये मात्र");
  });
});

describe("permissions", () => {
  it("supports module and global wildcards", () => {
    expect(hasPermission(["invoice.*"], "invoice.cancel")).toBe(true);
    expect(hasPermission(["*"], "backup.restore")).toBe(true);
    expect(hasPermission(["invoice.view"], "invoice.cancel")).toBe(false);
  });

  it("keeps purchase cost hidden from the default sales role", () => {
    const sales = DEFAULT_ROLES.find((r) => r.key === "sales")!;
    expect(hasPermission(sales.grants, "invoice.create")).toBe(true);
    expect(hasPermission(sales.grants, "product.view_cost")).toBe(false);
    expect(hasPermission(sales.grants, "report.view_profit")).toBe(false);
  });

  it("only grants permissions that exist in the catalogue", () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const role of DEFAULT_ROLES) {
      for (const grant of role.grants) {
        if (grant === "*" || grant.endsWith(".*")) continue;
        expect(known.has(grant), `${role.key}: ${grant}`).toBe(true);
      }
      expect(expandGrants(role.grants).length).toBeGreaterThan(0);
    }
  });
});
