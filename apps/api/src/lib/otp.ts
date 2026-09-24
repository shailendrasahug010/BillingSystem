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
