import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, matchTotp, newRecoveryCodes, newTotpSecret, otpauthUri, recoveryCodeHash, totpCode, totpStep } from "../src/lib/totp.js";

const RFC_KEY = new TextEncoder().encode("12345678901234567890");

describe("codes from an authenticator app", () => {
  it("match the RFC 4226 and RFC 6238 test values", () => {
    expect(Array.from({ length: 10 }, (_, i) => hotp(RFC_KEY, i))).toEqual(["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]);
    const at = (seconds: number) => hotp(RFC_KEY, Math.floor(seconds / 30), 8);
    expect([59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000].map(at)).toEqual(["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"]);
  });

  it("reads and writes base32 as the apps do", () => {
    expect(base32Encode(RFC_KEY)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(new TextDecoder().decode(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"))).toBe("12345678901234567890");
    for (let n = 1; n <= 21; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
    expect(() => base32Decode("NOT*BASE32")).toThrow();
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("takes the code of now or one step either side, once", () => {
    const secret = newTotpSecret();
    const now = new Date("2026-10-10T10:00:10Z");
    const step = totpStep(now);
    const code = totpCode(secret, now);
    expect(matchTotp(secret, code, now, null)).toBe(step);
    expect(matchTotp(secret, code, new Date(now.getTime() + 30_000), null)).toBe(step);
    expect(matchTotp(secret, code, new Date(now.getTime() - 30_000), null)).toBe(step);
    expect(matchTotp(secret, code, new Date(now.getTime() + 60_000), null)).toBeNull();
    // Used once already.
    expect(matchTotp(secret, code, now, step)).toBeNull();
    expect(matchTotp(secret, totpCode(secret, new Date(now.getTime() + 30_000)), now, step)).toBe(step + 1);
    expect(matchTotp(secret, "12345", now, null)).toBeNull();
    expect(matchTotp(secret, "abcdef", now, null)).toBeNull();
  });

  it("names the account in the QR code's text", () => {
    expect(otpauthUri({ secret: "ABC", issuer: "Digital Bahi", account: "9876543210" })).toBe(
      "otpauth://totp/Digital%20Bahi:9876543210?secret=ABC&issuer=Digital%20Bahi&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("makes recovery codes that are easy to copy and are kept only as hashes", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    expect(recoveryCodeHash(codes[0]!)).toMatch(/^[0-9a-f]{64}$/);
    expect(recoveryCodeHash(` ${codes[0]!.toUpperCase().replace("-", " ")} `)).toBe(recoveryCodeHash(codes[0]!));
  });
});
