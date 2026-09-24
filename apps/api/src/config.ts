import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(3000),
  /** Connection as the application role (vyapaar_app): row-level security applies. */
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_ISSUER: z.string().default("vyapaar"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CORS_ORIGINS: z.string().default(""),
  COOKIE_SECURE: bool.optional(),
  /** Development only: include OTP codes in API responses instead of sending an SMS. */
  OTP_DEV_ECHO: bool.default(false),
  RATE_LIMIT_MAX: z.coerce.number().int().default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().default(20),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DOCS_ENABLED: bool.optional(),
});

export interface Config {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  databasePoolMax: number;
  jwt: { privateKeyPem?: string; publicKeyPem?: string; issuer: string; accessTtlSeconds: number; refreshTtlDays: number };
  corsOrigins: string[];
  cookieSecure: boolean;
  otpDevEcho: boolean;
  rateLimit: { max: number; authMax: number };
  logLevel: string;
  docsEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === "production") {
    if (!e.JWT_PRIVATE_KEY || !e.JWT_PUBLIC_KEY) throw new Error("JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production");
    if (e.OTP_DEV_ECHO) throw new Error("OTP_DEV_ECHO must not be enabled in production");
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    jwt: {
      ...(e.JWT_PRIVATE_KEY ? { privateKeyPem: e.JWT_PRIVATE_KEY.replace(/\\n/g, "\n") } : {}),
      ...(e.JWT_PUBLIC_KEY ? { publicKeyPem: e.JWT_PUBLIC_KEY.replace(/\\n/g, "\n") } : {}),
      issuer: e.JWT_ISSUER,
      accessTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    },
    corsOrigins: e.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === "production",
    otpDevEcho: e.OTP_DEV_ECHO,
    rateLimit: { max: e.RATE_LIMIT_MAX, authMax: e.AUTH_RATE_LIMIT_MAX },
    logLevel: e.LOG_LEVEL,
    docsEnabled: e.DOCS_ENABLED ?? e.NODE_ENV !== "production",
  };
}
