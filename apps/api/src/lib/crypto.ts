import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Field-level encryption (AES-256-GCM) for sensitive values stored at rest:
 * bank account numbers, employee PAN/Aadhaar. Format: v1.<iv>.<tag>.<data> (base64url).
 */
export interface FieldCipher {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

export function createFieldCipher(keyBase64: string | undefined, env: string): FieldCipher {
  let key: Buffer;
  if (keyBase64) {
    key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  } else {
    if (env === "production") throw new Error("DATA_ENCRYPTION_KEY is required in production");
    // Development / tests only: a fixed, well-known key. Never protects real data.
    key = createHash("sha256").update("vyapaar-development-only-key").digest();
  }
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
    },
    decrypt(sealed) {
      const [version, iv, tag, data] = sealed.split(".");
      if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported ciphertext");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}
