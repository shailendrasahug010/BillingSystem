import { createHash, randomBytes, randomInt } from "node:crypto";
import { hash, verify, type Options } from "@node-rs/argon2";
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey, type JWTPayload } from "jose";
import type { Config } from "../config.js";

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations). Algorithm 2 = Argon2id
// (the library exposes it as a const enum, which cannot be imported as a value here).
const ARGON: Options = { algorithm: 2 as NonNullable<Options["algorithm"]>, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON);
}

export async function verifyPassword(passwordHash: string | null | undefined, password: string): Promise<boolean> {
  if (!passwordHash) {
    // Spend comparable time so a missing account is not detectable by timing.
    await hash(password, ARGON);
    return false;
  }
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 256-bit opaque token (refresh tokens); only its SHA-256 is stored. */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

/** True for a connection from this computer itself (127.0.0.0/8 or ::1, also as an IPv4-mapped IPv6 address). */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  return ip === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

export function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export interface AccessClaims {
  userId: string;
  businessId: string | null;
  /** Refresh-token family (session) id. */
  sessionId: string;
}

/** Sign-in half done: the password or the OTP was right, the code from the authenticator app is still to come. */
export interface TwoStepClaims {
  userId: string;
  /** The business asked for at sign-in, if any. */
  businessId: string | null;
  /** How the first step was done: password or otp. */
  method: string;
}

export interface TokenService {
  signAccess(claims: AccessClaims): Promise<string>;
  verifyAccess(token: string): Promise<AccessClaims>;
  accessTtlSeconds: number;
  /** A short-lived token for the second step of a sign-in; it opens nothing else. */
  signTwoStep(claims: TwoStepClaims): Promise<string>;
  verifyTwoStep(token: string): Promise<TwoStepClaims>;
  twoStepTtlSeconds: number;
}

const AUDIENCE = "digitalbahi-api";
/** A different audience: a half-done sign-in's token is never taken as an access token, nor the other way round. */
const TWO_STEP_AUDIENCE = "digitalbahi-two-step";
/** Time to open the authenticator app and type its code. */
const TWO_STEP_TTL_SECONDS = 300;

export async function createTokenService(config: Config): Promise<TokenService> {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  if (config.jwt.privateKeyPem && config.jwt.publicKeyPem) {
    privateKey = await importPKCS8(config.jwt.privateKeyPem, "EdDSA");
    publicKey = await importSPKI(config.jwt.publicKeyPem, "EdDSA");
  } else {
    // Development / tests: ephemeral keys, tokens die with the process.
    ({ privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true }));
  }
  const ttl = config.jwt.accessTtlSeconds;
  return {
    accessTtlSeconds: ttl,
    async signAccess(c) {
      return new SignJWT({ bid: c.businessId, sid: c.sessionId })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject(c.userId)
        .setIssuer(config.jwt.issuer)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ttl}s`)
        .sign(privateKey);
    },
    async verifyAccess(token) {
      const { payload } = await jwtVerify<JWTPayload & { bid?: string | null; sid?: string }>(token, publicKey, {
        issuer: config.jwt.issuer,
        audience: AUDIENCE,
        algorithms: ["EdDSA"],
      });
      if (!payload.sub || !payload.sid) throw new Error("malformed token");
      return { userId: payload.sub, businessId: payload.bid ?? null, sessionId: payload.sid };
    },
    twoStepTtlSeconds: TWO_STEP_TTL_SECONDS,
    async signTwoStep(c) {
      return new SignJWT({ bid: c.businessId, m: c.method })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject(c.userId)
        .setIssuer(config.jwt.issuer)
        .setAudience(TWO_STEP_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${TWO_STEP_TTL_SECONDS}s`)
        .sign(privateKey);
    },
    async verifyTwoStep(token) {
      const { payload } = await jwtVerify<JWTPayload & { bid?: string | null; m?: string }>(token, publicKey, {
        issuer: config.jwt.issuer,
        audience: TWO_STEP_AUDIENCE,
        algorithms: ["EdDSA"],
      });
      if (!payload.sub || !payload.m) throw new Error("malformed token");
      return { userId: payload.sub, businessId: payload.bid ?? null, method: payload.m };
    },
  };
}

/** Helper for operators: prints a new Ed25519 key pair in PEM for JWT_PRIVATE_KEY / JWT_PUBLIC_KEY. */
export async function generateJwtKeyPairPem(): Promise<{ privateKey: string; publicKey: string }> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { privateKey: await exportPKCS8(privateKey), publicKey: await exportSPKI(publicKey) };
}
