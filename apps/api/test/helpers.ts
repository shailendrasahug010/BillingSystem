import { randomBytes } from "node:crypto";
import { createDb, runMigrations, seedReferenceData, setupAppRole } from "@vyapaar/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createFieldCipher } from "../src/lib/crypto.js";
import { MemoryOtpSender } from "../src/lib/otp.js";
import { ErrorLog } from "../src/lib/errorLog.js";
import type { ApiModule } from "../src/modules/types.js";
import { createTokenService } from "../src/lib/security.js";
import { LogMessenger } from "../src/services/messaging/transport.js";

export const ADMIN_URL = process.env.DATABASE_URL;
export const hasDatabase = Boolean(ADMIN_URL);
export const TEST_TODAY = "2026-09-24";

const APP_ROLE = "vyapaar_app_test";
const APP_PASSWORD = "vyapaar_app_test";

function withDatabase(url: string, database: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

async function ensureRole(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`create role ${APP_ROLE} login password '${APP_PASSWORD}' nosuperuser nobypassrls`);
  } catch (e) {
    // Another test file created it first (roles are cluster-wide).
    if (!["42710", "23505"].includes((e as { code?: string }).code ?? "")) throw e;
  } finally {
    await client.end();
  }
}

export interface TestApp {
  app: FastifyInstance;
  otp: MemoryOtpSender;
  /** Moves the API clock forward (token expiry, OTP expiry, rotation grace). */
  advance(ms: number): void;
  /** Messages "sent" (recorded, not delivered). */
  messenger: LogMessenger;
  /** Superuser/owner access to the test database, for assertions that bypass RLS. */
  owner: pg.Pool;
  close(): Promise<void>;
}

/**
 * A fresh database per test file: migrations applied as the owner, the API
 * connected as a non-owner role so row-level security is really enforced.
 */
/** Options for tests that need them: folders for the error log and web source maps, routes of their own. */
export async function createTestApp(options: { logDir?: string; webSourceMapsDir?: string; extraModules?: ApiModule[] } = {}): Promise<TestApp> {
  if (!ADMIN_URL) throw new Error("DATABASE_URL is required for API tests");
  const dbName = `vyapaar_api_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const ownerUrl = withDatabase(ADMIN_URL, dbName);
  await runMigrations(ownerUrl);
  const seed = createDb(ownerUrl, { max: 1 });
  await seedReferenceData(seed.db);
  await seed.pool.end();
  await ensureRole(ADMIN_URL);
  await setupAppRole(ownerUrl, APP_ROLE);

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: withDatabase(ADMIN_URL, dbName, { name: APP_ROLE, password: APP_PASSWORD }),
    RATE_LIMIT_MAX: "100000",
    AUTH_RATE_LIMIT_MAX: "100000",
    LOG_LEVEL: "silent",
    DOCS_ENABLED: "false",
  });
  const { db, pool } = createDb(config.databaseUrl, { max: 8 });
  const otp = new MemoryOtpSender();
  const messenger = new LogMessenger();
  let offsetMs = 0;
  const app = await buildApp({
    config,
    db,
    tokens: await createTokenService(config),
    otp,
    clock: { now: () => new Date(Date.now() + offsetMs), today: () => TEST_TODAY },
    cipher: createFieldCipher(undefined, "test"),
    messenger,
    errors: new ErrorLog({ ...config.errorLog, dir: options.logDir ?? null, webSourceMapsDir: options.webSourceMapsDir ?? null }),
  }, { extraModules: options.extraModules ?? [] });
  await app.ready();
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });

  return {
    app,
    otp,
    messenger,
    owner,
    advance(ms) {
      offsetMs += ms;
    },
    async close() {
      await app.close();
      await pool.end();
      await owner.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`drop database if exists ${dbName} with (force)`);
      await c.end();
    },
  };
}

/** Small typed wrapper around app.inject for JSON APIs. */
export async function call<T = any>(
  app: FastifyInstance,
  method: InjectOptions["method"],
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string>; cookies?: Record<string, string> } = {},
): Promise<{
  status: number;
  body: T;
  headers: Record<string, unknown>;
  cookies: Array<{ name: string; value: string; httpOnly?: boolean; sameSite?: string; path?: string; maxAge?: number }>;
}> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.cookies ? { cookies: options.cookies } : {}),
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  const text = res.body;
  return {
    status: res.statusCode,
    body: (text ? JSON.parse(text) : null) as T,
    headers: res.headers as Record<string, unknown>,
    cookies: res.cookies.map((c) => ({ ...c })),
  };
}

let mobileSeq = 0;
/** A unique valid Indian mobile number per call (per test file and worker). */
export function nextMobile(): string {
  mobileSeq += 1;
  const base = (process.pid % 1000) * 10_000 + mobileSeq;
  return `9${String(base).padStart(9, "0")}`;
}

export interface Session {
  token: string;
  refreshCookie: string;
  userId: string;
  businessId: string;
  mobile: string;
  password: string;
}

/** Self-service signup through the public API (OTP + signup), as a new tenant owner. */
export async function signup(
  t: TestApp,
  opts: { name?: string; legalName?: string; stateCode?: string; gstin?: string; email?: string } = {},
): Promise<Session> {
  const mobile = nextMobile();
  const password = "Str0ng-pass!";
  const otpRes = await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "signup" } });
  if (otpRes.status !== 202) throw new Error(`otp failed: ${JSON.stringify(otpRes.body)}`);
  const res = await call(t.app, "POST", "/auth/signup", {
    body: {
      name: opts.name ?? "Owner",
      mobile,
      password,
      otp: t.otp.last(mobile),
      ...(opts.email ? { email: opts.email } : {}),
      business: {
        legalName: opts.legalName ?? "Test Traders",
        stateCode: opts.stateCode ?? "23",
        ...(opts.gstin ? { gstin: opts.gstin } : {}),
      },
    },
  });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return {
    token: res.body.accessToken,
    refreshCookie: res.cookies.find((c) => c.name === "vy_rt")!.value,
    userId: res.body.user.id,
    businessId: res.body.business.id,
    mobile,
    password,
  };
}
