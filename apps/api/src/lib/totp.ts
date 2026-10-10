import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Codes from an authenticator app (Google Authenticator, Microsoft
 * Authenticator, Authy…): TOTP as in RFC 6238, the way every such app reads a
 * QR code by default (HMAC-SHA1, 6 digits, a new code every 30 seconds).
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Recovery codes made at a time; each one works once. */
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Upper or lower case, with or without spaces and padding (people copy secrets by hand). */
export function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of text.toUpperCase().replace(/[\s=-]/g, "")) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error("Not base32");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** A new secret: 160 random bits (the size RFC 4226 recommends), in base32 as the apps take it. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one counter value (RFC 4226). */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The 30-second step a moment falls in. */
export const totpStep = (at: Date): number => Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);

/** The app's code at a moment (for tests and for checking). */
export function totpCode(secret: string, at: Date): string {
  return hotp(base32Decode(secret), totpStep(at));
}

/**
 * The step of the code typed, if it is the code of now or of one step either
 * side (a phone's clock a little off, or a code typed as it changed); null if
 * not. Steps up to `lastStep` do not count: a code that was accepted once is
 * refused after that.
 */
export function matchTotp(secret: string, code: string, at: Date, lastStep: number | null): number | null {
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) return null;
  const key = base32Decode(secret);
  const now = totpStep(at);
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

/**
 * What the app reads from the QR code: the account it shows ("Digital Bahi:
 * 9876543210") and the secret.
 */
export function otpauthUri(input: { secret: string; issuer: string; account: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  const label = `${issuer}:${encodeURIComponent(input.account)}`;
  return `otpauth://totp/${label}?secret=${input.secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

/** Letters and digits that cannot be mistaken for each other when copied from paper (no 0/o, 1/l/i). */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Codes that sign in once each in place of the app's code (a lost phone): "k7m2p-x9q4r". */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let code = "";
    for (let i = 0; i < 10; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** What is stored for a recovery code: its SHA-256, however it was typed (case, spaces and dashes ignored). */
export function recoveryCodeHash(code: string): string {
  return createHash("sha256").update(code.toLowerCase().replace(/[^a-z0-9]/g, "")).digest("hex");
}
