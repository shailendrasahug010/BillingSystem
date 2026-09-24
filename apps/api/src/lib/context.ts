import type { Database } from "@vyapaar/db";
import type { Config } from "../config.js";
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
