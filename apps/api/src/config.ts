import path from "node:path";
import { z } from "zod";
import { defaultWebSourceMapsDir } from "./lib/errorLog.js";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(3000),
  /** Connection as the application role (digitalbahi_app): row-level security applies. */
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  /** 32 random bytes, base64: encrypts bank account numbers and other sensitive fields at rest. */
  DATA_ENCRYPTION_KEY: z.string().optional(),
  /** Changing it (as the rename from "vyapaar" did) only makes open sessions refresh their access token once. */
  JWT_ISSUER: z.string().default("digitalbahi"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CORS_ORIGINS: z.string().default(""),
  COOKIE_SECURE: bool.optional(),
  /** Development only: include OTP codes in API responses instead of sending an SMS. */
  OTP_DEV_ECHO: bool.default(false),
  /** Where OTPs are delivered: an SMS/WhatsApp gateway adapter that accepts {mobile, code, purpose}. */
  OTP_WEBHOOK_URL: z.url().optional(),
  OTP_WEBHOOK_TOKEN: z.string().optional(),
  /**
   * WhatsApp and email to customers: "live" sends through each business's
   * WhatsApp Business account and the mail server; "log" records messages
   * without sending (development, demos, tests).
   */
  MESSAGING_DRIVER: z.enum(["live", "log"]).optional(),
  /** The platform's mail server for businesses without their own SMTP (smtp://user:pass@host:587 or smtps://…). */
  SMTP_URL: z.string().optional(),
  /** Sender address for the platform's mail server, e.g. bills@digitalbahi.in. */
  MAIL_FROM: z.string().optional(),
  WHATSAPP_API_BASE: z.url().default("https://graph.facebook.com/v21.0"),
  /** Days a new SaaS business stays in trial. */
  TRIAL_DAYS: z.coerce.number().int().min(0).max(365).default(14),
  /** How often the API looks for automatic backups that are due (0 = never, e.g. on extra instances). */
  BACKUP_SCHEDULER_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
  /** How often the outbox worker looks for waiting events (purchase history after each bill); 0 = never. */
  OUTBOX_WORKER_SECONDS: z.coerce.number().int().min(0).max(3600).default(5),
  /** How often the API looks for businesses due for their nightly analytics run; 0 = never. */
  NIGHTLY_SCHEDULER_SECONDS: z.coerce.number().int().min(0).max(86400).default(600),
  /** How often the API looks for daily reminder checks that are due (each rule has its own hour); 0 = never. */
  REMINDER_SCHEDULER_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),
  /** The nightly run starts after this hour (0–23) in each business's time zone. */
  NIGHTLY_ANALYTICS_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  RATE_LIMIT_MAX: z.coerce.number().int().default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().default(20),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Where the error log files go (errors-YYYY-MM-DD.log / .jsonl); "off" writes none. */
  LOG_DIR: z.string().default("logs"),
  /** Days of error log files kept. */
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Time zone of the times in the readable error log. */
  LOG_TIME_ZONE: z.string().default("Asia/Kolkata"),
  /** The built web app's source maps (kept off the public site), to show browser errors at their source line. */
  WEB_SOURCEMAPS_DIR: z.string().optional(),
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
  dataEncryptionKey?: string;
  otpWebhook?: { url: string; token?: string };
  messaging: { driver: "live" | "log"; smtpUrl?: string; mailFrom?: string; whatsappApiBase: string };
  trialDays: number;
  backupSchedulerSeconds: number;
  outboxWorkerSeconds: number;
  reminderSchedulerSeconds: number;
  nightlyAnalytics: { schedulerSeconds: number; hour: number };
  rateLimit: { max: number; authMax: number };
  logLevel: string;
  errorLog: { dir: string | null; retentionDays: number; timeZone: string; webSourceMapsDir: string | null };
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
    if (!e.OTP_WEBHOOK_URL) throw new Error("OTP_WEBHOOK_URL is required in production (OTPs are never logged there)");
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
    ...(e.DATA_ENCRYPTION_KEY ? { dataEncryptionKey: e.DATA_ENCRYPTION_KEY } : {}),
    ...(e.OTP_WEBHOOK_URL ? { otpWebhook: { url: e.OTP_WEBHOOK_URL, ...(e.OTP_WEBHOOK_TOKEN ? { token: e.OTP_WEBHOOK_TOKEN } : {}) } } : {}),
    messaging: {
      driver: e.MESSAGING_DRIVER ?? (e.NODE_ENV === "production" ? "live" : "log"),
      ...(e.SMTP_URL ? { smtpUrl: e.SMTP_URL } : {}),
      ...(e.MAIL_FROM ? { mailFrom: e.MAIL_FROM } : {}),
      whatsappApiBase: e.WHATSAPP_API_BASE.replace(/\/+$/, ""),
    },
    trialDays: e.TRIAL_DAYS,
    backupSchedulerSeconds: e.BACKUP_SCHEDULER_SECONDS,
    outboxWorkerSeconds: e.OUTBOX_WORKER_SECONDS,
    reminderSchedulerSeconds: e.REMINDER_SCHEDULER_SECONDS,
    nightlyAnalytics: { schedulerSeconds: e.NIGHTLY_SCHEDULER_SECONDS, hour: e.NIGHTLY_ANALYTICS_HOUR },
    rateLimit: { max: e.RATE_LIMIT_MAX, authMax: e.AUTH_RATE_LIMIT_MAX },
    logLevel: e.LOG_LEVEL,
    errorLog: {
      dir: e.LOG_DIR === "off" || e.LOG_DIR === "" ? null : path.resolve(e.LOG_DIR),
      retentionDays: e.LOG_RETENTION_DAYS,
      timeZone: e.LOG_TIME_ZONE,
      webSourceMapsDir: e.WEB_SOURCEMAPS_DIR ? path.resolve(e.WEB_SOURCEMAPS_DIR) : defaultWebSourceMapsDir(),
    },
    docsEnabled: e.DOCS_ENABLED ?? e.NODE_ENV !== "production",
  };
}
