import { createSign } from "node:crypto";
import type { ServiceAccount } from "../config.js";

/**
 * Push messages to phones (Phase 5.2): Firebase Cloud Messaging's HTTP v1 API,
 * signed in with the Firebase project's service account. The Android app
 * registers its FCM token (POST /push/tokens); each new notification goes to
 * the phones of the people it is for, written in each phone's language
 * (services/push-delivery.ts, run by the outbox worker).
 */

export interface PushMessage {
  /** The phone's FCM registration token. */
  token: string;
  title: string;
  body: string | null;
  /** A later push with the same tag replaces this one on the phone (today's low-stock reminder replaces yesterday's). */
  tag: string;
  /** Warnings come up on the screen (high priority, the "alerts" channel); the rest go to the shade quietly ("updates"). */
  urgent: boolean;
  /** For the app when the push is opened: the notification, its business and what to open. Values are strings. */
  data: Record<string, string>;
}

export type PushOutcome = { ok: true; id: string } | { ok: false; error: string; /** FCM says the token no longer works: delete it. */ invalidToken: boolean };

export interface PushSender {
  readonly driver: "fcm" | "log" | "off";
  send(message: PushMessage): Promise<PushOutcome>;
}

/** Records pushes without sending them (development, tests). */
export class LogPush implements PushSender {
  readonly driver = "log" as const;
  readonly sent: PushMessage[] = [];
  /** Tests: tokens FCM would call unregistered. */
  readonly unregistered = new Set<string>();
  constructor(private readonly log?: (msg: string) => void) {}
  async send(message: PushMessage): Promise<PushOutcome> {
    if (this.unregistered.has(message.token)) return { ok: false, error: "UNREGISTERED", invalidToken: true };
    this.sent.push(message);
    this.log?.(`push to …${message.token.slice(-6)}: ${message.title}`);
    return { ok: true, id: `log-${this.sent.length}` };
  }
}

/** Push turned off: tokens are kept, nothing is sent. */
export class OffPush implements PushSender {
  readonly driver = "off" as const;
  async send(): Promise<PushOutcome> {
    return { ok: false, error: "push is off on this server", invalidToken: false };
  }
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** FCM error codes that mean the token is gone (the app was uninstalled, or the token belongs to another project). */
const GONE = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);

const base64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Sends through FCM's HTTP v1 API with an OAuth access token from the service account (kept until shortly before it expires). */
export class FcmPush implements PushSender {
  readonly driver = "fcm" as const;
  private access: { token: string; until: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly apiBase = "https://fcm.googleapis.com",
    private readonly now: () => number = Date.now,
  ) {}

  /** A JWT signed with the service account's key, exchanged at Google for an access token. */
  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > this.now()) return this.access.token;
    const iat = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({ iss: this.account.clientEmail, scope: SCOPE, aud: this.account.tokenUri, iat, exp: iat + 3600 }));
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(this.account.privateKey);
    const res = await fetch(this.account.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${base64url(signature)}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !json.access_token) throw new Error(`Google sign-in for FCM failed: ${json.error_description ?? json.error ?? res.status}`);
    this.access = { token: json.access_token, until: this.now() + Math.max(60, (json.expires_in ?? 3600) - 120) * 1000 };
    return json.access_token;
  }

  async send(message: PushMessage): Promise<PushOutcome> {
    const body = JSON.stringify({
      message: {
        token: message.token,
        notification: { title: message.title, ...(message.body ? { body: message.body } : {}) },
        data: message.data,
        android: { priority: message.urgent ? "high" : "normal", notification: { tag: message.tag, channel_id: message.urgent ? "alerts" : "updates" } },
      },
    });
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.accessToken();
      } catch (e) {
        return { ok: false, error: (e as Error).message, invalidToken: false };
      }
      let res: Response;
      try {
        res = await fetch(`${this.apiBase}/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        return { ok: false, error: (e as Error).message, invalidToken: false };
      }
      const json = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string; status?: string; details?: Array<{ errorCode?: string }> } };
      if (res.ok) return { ok: true, id: json.name ?? "" };
      // The access token was revoked or expired early: sign in again, once.
      if (res.status === 401 && attempt === 0) {
        this.access = null;
        continue;
      }
      const code = json.error?.details?.find((d) => d.errorCode)?.errorCode ?? json.error?.status ?? String(res.status);
      const error = `${code}: ${json.error?.message ?? res.statusText}`.slice(0, 300);
      const invalidToken = GONE.has(code) || (code === "INVALID_ARGUMENT" && /registration token/i.test(json.error?.message ?? ""));
      return { ok: false, error, invalidToken };
    }
  }
}

/** The sender the configuration asks for. */
export function pushSender(config: { driver: "fcm" | "log" | "off"; serviceAccount?: ServiceAccount; apiBase: string }, log?: (msg: string) => void): PushSender {
  if (config.driver === "fcm" && config.serviceAccount) return new FcmPush(config.serviceAccount, config.apiBase);
  if (config.driver === "log") return new LogPush(log);
  return new OffPush();
}
