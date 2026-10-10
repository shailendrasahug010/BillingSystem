import { readFileSync } from "node:fs";
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
  /**
   * Where the Android app's pages come from (Capacitor serves them at https://localhost): allowed
   * to call the API. The app signs in with tokens, not cookies (the refresh cookie is SameSite=Strict
   * and never goes to another site). Empty: no app.
   */
  APP_ORIGINS: z.string().default("https://localhost"),
  COOKIE_SECURE: bool.optional(),
  /** Development only: include OTP codes in API responses instead of sending an SMS. */
  OTP_DEV_ECHO: bool.default(false),
  /**
   * With OTP_DEV_ECHO: show the codes only to this computer (a request from
   * 127.0.0.1 / ::1). The launcher's phone mode sets it, so that phones on
   * the Wi-Fi can use the app but nobody on it can read a sign-up or
   * password-reset code off the screen.
   */
  OTP_DEV_ECHO_LOCAL_ONLY: bool.default(false),
  /**
   * A folder on this computer (a pen drive, or a Google Drive / OneDrive
   * folder that syncs itself) where automatic backups are saved, besides or
   * instead of email. Set by the one-computer launcher; empty: email only.
   */
  BACKUP_FOLDER: z.string().optional(),
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
  /**
   * Notifications as push messages to the Android app (Firebase Cloud
   * Messaging): "fcm" sends them with the service account below; "log"
   * records them without sending (development, tests); "off" sends none.
   * Default: fcm when a service account is set, else log outside production
   * and off in production.
   */
  PUSH_DRIVER: z.enum(["fcm", "log", "off"]).optional(),
  /** The Firebase project's service account key: the JSON file's content, or base64 of it. */
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  /** Or the path of that JSON file. */
  FCM_SERVICE_ACCOUNT_FILE: z.string().optional(),
  FCM_API_BASE: z.url().default("https://fcm.googleapis.com"),
  /**
   * Online payment links (each business's own Razorpay or Cashfree account):
   * "live" makes them at the gateway; "fake" makes them in memory, charging
   * nobody (development, demos, tests). Default: live in production, else fake.
   */
  PAYMENT_GATEWAY_DRIVER: z.enum(["live", "fake"]).optional(),
  /** The gateways' addresses (a stand-in server in tests); Cashfree's replaces both its test and live ones. */
  RAZORPAY_API_BASE: z.url().optional(),
  CASHFREE_API_BASE: z.url().optional(),
  /** How often the API asks the gateways about open payment links, in case a webhook did not arrive; 0 = never. */
  PAYMENT_LINK_POLL_SECONDS: z.coerce.number().int().min(0).max(86400).default(600),
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
  /** Readable log lines (pino-pretty, a development tool) instead of JSON; development only, on unless set false. */
  LOG_PRETTY: bool.optional(),
  /** Where the error log files go (errors-YYYY-MM-DD.log / .jsonl); "off" writes none. */
  LOG_DIR: z.string().default("logs"),
  /** Days of error log files kept. */
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Time zone of the times in the readable error log. */
  LOG_TIME_ZONE: z.string().default("Asia/Kolkata"),
  /** The built web app's source maps (kept off the public site), to show browser errors at their source line. */
  WEB_SOURCEMAPS_DIR: z.string().optional(),
  DOCS_ENABLED: bool.optional(),
  /** The built web app (apps/web/dist) to serve at / when no web server sits in front (one computer: installer/). */
  WEB_DIR: z.string().optional(),
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
  otpDevEchoLocalOnly: boolean;
  backupFolder: string | null;
  dataEncryptionKey?: string;
  otpWebhook?: { url: string; token?: string };
  messaging: { driver: "live" | "log"; smtpUrl?: string; mailFrom?: string; whatsappApiBase: string };
  push: { driver: "fcm" | "log" | "off"; serviceAccount?: ServiceAccount; apiBase: string };
  gateways: { driver: "live" | "fake"; razorpayBase?: string; cashfreeBase?: string; pollSeconds: number };
  trialDays: number;
  backupSchedulerSeconds: number;
  outboxWorkerSeconds: number;
  reminderSchedulerSeconds: number;
  nightlyAnalytics: { schedulerSeconds: number; hour: number };
  rateLimit: { max: number; authMax: number };
  logLevel: string;
  logPretty: boolean;
  errorLog: { dir: string | null; retentionDays: number; timeZone: string; webSourceMapsDir: string | null };
  docsEnabled: boolean;
  webDir: string | null;
}

/** The parts of a Google service account key that sending through FCM needs. */
export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

/** The service account from FCM_SERVICE_ACCOUNT (JSON or base64 JSON) or FCM_SERVICE_ACCOUNT_FILE; undefined when neither is set. */
function serviceAccount(e: { FCM_SERVICE_ACCOUNT?: string | undefined; FCM_SERVICE_ACCOUNT_FILE?: string | undefined }): ServiceAccount | undefined {
  let raw = e.FCM_SERVICE_ACCOUNT?.trim();
  if (!raw && e.FCM_SERVICE_ACCOUNT_FILE) raw = readFileSync(path.resolve(e.FCM_SERVICE_ACCOUNT_FILE), "utf8");
  if (!raw) return undefined;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("FCM_SERVICE_ACCOUNT is not a service account key (JSON, or base64 of it)");
  }
  const text = (k: string) => (typeof key[k] === "string" && key[k] ? (key[k] as string) : null);
  const projectId = text("project_id");
  const clientEmail = text("client_email");
  const privateKey = text("private_key");
  if (!projectId || !clientEmail || !privateKey) throw new Error("FCM_SERVICE_ACCOUNT lacks project_id, client_email or private_key");
  return { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, "\n"), tokenUri: text("token_uri") ?? "https://oauth2.googleapis.com/token" };
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
  const account = serviceAccount(e);
  const pushDriver = e.PUSH_DRIVER ?? (account ? "fcm" : e.NODE_ENV === "production" ? "off" : "log");
  if (pushDriver === "fcm" && !account) throw new Error("PUSH_DRIVER=fcm needs FCM_SERVICE_ACCOUNT or FCM_SERVICE_ACCOUNT_FILE");
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
    corsOrigins: [...new Set([...e.CORS_ORIGINS.split(","), ...e.APP_ORIGINS.split(",")].map((s) => s.trim()).filter(Boolean))],
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === "production",
    otpDevEcho: e.OTP_DEV_ECHO,
    otpDevEchoLocalOnly: e.OTP_DEV_ECHO_LOCAL_ONLY,
    backupFolder: e.BACKUP_FOLDER?.trim() ? path.resolve(e.BACKUP_FOLDER.trim()) : null,
    ...(e.DATA_ENCRYPTION_KEY ? { dataEncryptionKey: e.DATA_ENCRYPTION_KEY } : {}),
    ...(e.OTP_WEBHOOK_URL ? { otpWebhook: { url: e.OTP_WEBHOOK_URL, ...(e.OTP_WEBHOOK_TOKEN ? { token: e.OTP_WEBHOOK_TOKEN } : {}) } } : {}),
    messaging: {
      driver: e.MESSAGING_DRIVER ?? (e.NODE_ENV === "production" ? "live" : "log"),
      ...(e.SMTP_URL ? { smtpUrl: e.SMTP_URL } : {}),
      ...(e.MAIL_FROM ? { mailFrom: e.MAIL_FROM } : {}),
      whatsappApiBase: e.WHATSAPP_API_BASE.replace(/\/+$/, ""),
    },
    push: { driver: pushDriver, ...(account ? { serviceAccount: account } : {}), apiBase: e.FCM_API_BASE.replace(/\/+$/, "") },
    gateways: {
      driver: e.PAYMENT_GATEWAY_DRIVER ?? (e.NODE_ENV === "production" ? "live" : "fake"),
      ...(e.RAZORPAY_API_BASE ? { razorpayBase: e.RAZORPAY_API_BASE.replace(/\/+$/, "") } : {}),
      ...(e.CASHFREE_API_BASE ? { cashfreeBase: e.CASHFREE_API_BASE.replace(/\/+$/, "") } : {}),
      pollSeconds: e.PAYMENT_LINK_POLL_SECONDS,
    },
    trialDays: e.TRIAL_DAYS,
    backupSchedulerSeconds: e.BACKUP_SCHEDULER_SECONDS,
    outboxWorkerSeconds: e.OUTBOX_WORKER_SECONDS,
    reminderSchedulerSeconds: e.REMINDER_SCHEDULER_SECONDS,
    nightlyAnalytics: { schedulerSeconds: e.NIGHTLY_SCHEDULER_SECONDS, hour: e.NIGHTLY_ANALYTICS_HOUR },
    rateLimit: { max: e.RATE_LIMIT_MAX, authMax: e.AUTH_RATE_LIMIT_MAX },
    logLevel: e.LOG_LEVEL,
    logPretty: e.NODE_ENV === "development" && (e.LOG_PRETTY ?? true),
    errorLog: {
      dir: e.LOG_DIR === "off" || e.LOG_DIR === "" ? null : path.resolve(e.LOG_DIR),
      retentionDays: e.LOG_RETENTION_DAYS,
      timeZone: e.LOG_TIME_ZONE,
      webSourceMapsDir: e.WEB_SOURCEMAPS_DIR ? path.resolve(e.WEB_SOURCEMAPS_DIR) : defaultWebSourceMapsDir(),
    },
    docsEnabled: e.DOCS_ENABLED ?? e.NODE_ENV !== "production",
    webDir: e.WEB_DIR ? path.resolve(e.WEB_DIR) : null,
  };
}
