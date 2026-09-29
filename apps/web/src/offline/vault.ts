import { api } from "../lib/api";
import { idbGet, idbPut } from "./idb";

/**
 * The copy of the business on this device (saved workspace, work waiting to
 * sync) is encrypted with AES-GCM under a random 256-bit key per person on
 * this device. That key is never stored as it is, only wrapped (AES-KW):
 *
 *  - with the person's device key from the server (GET /me/device-key, handed
 *    only to a signed-in session), so an online start opens the copy by itself;
 *  - with a key made from their Digital Bahi password (PBKDF2-SHA-256, 310,000
 *    rounds, its own salt), so a start without the server asks for the password.
 *
 * A lost phone or a copied browser profile shows nothing without one of the
 * two. The open key lives only in this page's memory and is dropped on sign-out.
 */
export interface Sealed {
  v: 1;
  iv: Uint8Array;
  data: ArrayBuffer;
}

interface VaultRecord {
  userId: string;
  byServer: ArrayBuffer;
  byPassword?: { salt: Uint8Array; iterations: number; wrapped: ArrayBuffer };
}

const ITERATIONS = 310_000;
const recordKey = (userId: string) => `vault:${userId}`;
const encoder = new TextEncoder();
let open: { userId: string; key: CryptoKey } | null = null;

const available = () => typeof crypto !== "undefined" && Boolean(crypto.subtle);

/** The copy of this person (any person, without an id) can be read and written now. */
export const vaultOpen = (userId?: string) => Boolean(open && (!userId || open.userId === userId));

async function serverKek(): Promise<CryptoKey> {
  const { key } = await api.get<{ key: string }>("/me/device-key");
  const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-KW", false, ["wrapKey", "unwrapKey"]);
}

async function passwordKek(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

const unwrap = (wrapped: ArrayBuffer, kek: CryptoKey) => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", "AES-GCM", true, ["encrypt", "decrypt"]);

/**
 * Online: opens this person's copy with their device key from the server,
 * making the lock the first time. False when it cannot (no server, no storage).
 */
export async function unlockOnline(userId: string): Promise<boolean> {
  if (!available()) return false;
  let kek: CryptoKey;
  try {
    kek = await serverKek();
  } catch {
    return vaultOpen(userId);
  }
  const record = await idbGet<VaultRecord>("kv", recordKey(userId));
  if (record) {
    try {
      open = { userId, key: await unwrap(record.byServer, kek) };
      return true;
    } catch {
      // The server's key no longer opens it (another server, a restored database): start a new lock.
    }
  }
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const byServer = await crypto.subtle.wrapKey("raw", key, kek, "AES-KW");
  if (!(await idbPut("kv", { userId, byServer } satisfies VaultRecord, recordKey(userId)))) return false;
  open = { userId, key };
  return true;
}

/** Whether this person's copy can be opened here with their password. */
export async function passwordOpens(userId: string): Promise<boolean> {
  return Boolean((await idbGet<VaultRecord>("kv", recordKey(userId)))?.byPassword);
}

/** Without the server: opens this person's copy with their password. */
export async function unlockWithPassword(userId: string, password: string): Promise<"ok" | "wrong" | "none"> {
  if (!available()) return "none";
  const record = await idbGet<VaultRecord>("kv", recordKey(userId));
  if (!record?.byPassword) return "none";
  try {
    const kek = await passwordKek(password, record.byPassword.salt, record.byPassword.iterations);
    open = { userId, key: await unwrap(record.byPassword.wrapped, kek) };
    return "ok";
  } catch {
    return "wrong";
  }
}

/**
 * The person has just typed their password to the server (sign-in, sign-up,
 * a new password): from now on it also opens their copy without internet.
 */
export async function rememberPassword(userId: string, password: string): Promise<boolean> {
  if (!open || open.userId !== userId) return false;
  const record = await idbGet<VaultRecord>("kv", recordKey(userId));
  if (!record) return false;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await passwordKek(password, salt, ITERATIONS);
  const wrapped = await crypto.subtle.wrapKey("raw", open.key, kek, "AES-KW");
  return idbPut("kv", { ...record, byPassword: { salt, iterations: ITERATIONS, wrapped } } satisfies VaultRecord, recordKey(userId));
}

/** Signed out: the copy cannot be read again until the next sign-in (or the password). */
export function lockVault(): void {
  open = null;
}

/** Encrypts a value for the record it is stored under (a sealed value moved to another record will not open). */
export async function seal(value: unknown, label: string): Promise<Sealed | null> {
  if (!open) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(label) }, open.key, encoder.encode(JSON.stringify(value)));
  return { v: 1, iv, data };
}

export async function unseal<T>(sealed: Sealed, label: string): Promise<T | undefined> {
  if (!open) return undefined;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv as BufferSource, additionalData: encoder.encode(label) }, open.key, sealed.data);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return undefined;
  }
}

export const isSealed = (v: unknown): v is Sealed => typeof v === "object" && v !== null && (v as Sealed).v === 1 && (v as Sealed).iv instanceof Uint8Array;
