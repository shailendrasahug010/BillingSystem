import type { Database } from "@digitalbahi/db";
import type { Config } from "../config.js";
import type { Messenger } from "../services/messaging/transport.js";
import type { FieldCipher } from "./crypto.js";
import type { ErrorLog } from "./errorLog.js";
import type { OtpSender } from "./otp.js";
import type { TokenService } from "./security.js";

export interface Clock {
  now(): Date;
  /** Business calendar date (YYYY-MM-DD) in the given IANA time zone. */
  today(timeZone?: string): string;
}

export interface AppDeps {
  config: Config;
  db: Database;
  tokens: TokenService;
  otp: OtpSender;
  clock: Clock;
  cipher: FieldCipher;
  /** WhatsApp and email to customers and suppliers. */
  messenger: Messenger;
  /** Failures written to the error log files (see errorLog.ts). */
  errors: ErrorLog;
}

/** Who is calling and in which business. Present on every tenant route. */
export interface RequestCtx {
  userId: string;
  userName: string;
  businessId: string;
  sessionId: string;
  roleKey: string;
  grants: string[];
  isOwner: boolean;
  timeZone: string;
  requestId: string;
  ip: string;
  userAgent: string | null;
}

export interface AuthUser {
  userId: string;
  sessionId: string;
  businessId: string | null;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    user: AuthUser | null;
    ctx: RequestCtx;
  }
}
