/**
 * Delivery of one-time passwords. Production plugs in an SMS / WhatsApp
 * provider behind this interface; development logs the code; tests capture it.
 */
export interface OtpSender {
  send(mobile: string, code: string, purpose: string): Promise<void>;
}

export class ConsoleOtpSender implements OtpSender {
  constructor(private readonly log: (msg: string) => void) {}
  async send(mobile: string, code: string, purpose: string): Promise<void> {
    this.log(`OTP for ${mobile.slice(0, 2)}XXXXXX${mobile.slice(-2)} (${purpose}): ${code}`);
  }
}

export class MemoryOtpSender implements OtpSender {
  readonly sent = new Map<string, string>();
  async send(mobile: string, code: string): Promise<void> {
    this.sent.set(mobile, code);
  }
  last(mobile: string): string | undefined {
    return this.sent.get(mobile);
  }
}

/**
 * Posts {mobile, code, purpose} to an SMS / WhatsApp gateway adapter. The
 * adapter owns templates and DLT registration; the API never logs the code.
 */
export class WebhookOtpSender implements OtpSender {
  constructor(private readonly target: { url: string; token?: string }) {}
  async send(mobile: string, code: string, purpose: string): Promise<void> {
    const res = await fetch(this.target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.target.token ? { authorization: `Bearer ${this.target.token}` } : {}),
      },
      body: JSON.stringify({ mobile: `+91${mobile}`, code, purpose }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OTP gateway responded ${res.status}`);
  }
}
