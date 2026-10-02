import { createHmac } from "node:crypto";
import { createTransport } from "nodemailer";

/** One message on its way out. */
export interface Outgoing {
  channel: "whatsapp" | "email" | "sms";
  /** WhatsApp and SMS: international digits (91XXXXXXXXXX). Email: the address. */
  to: string;
  subject: string | null;
  text: string;
  attachment: { filename: string; content: Buffer; contentType: string } | null;
  /** WhatsApp template (needed outside the 24-hour window after the customer last wrote); for SMS, `name` is the DLT template id. */
  template: { name: string; language: string; params: string[] } | null;
}

/** A business's channels with their secrets decrypted, ready to send. */
export interface Channels {
  whatsapp:
    | { provider: "none" }
    | { provider: "meta"; phoneNumberId: string; token: string }
    | { provider: "webhook"; url: string; secret: string };
  email:
    | { mode: "none" }
    | { mode: "smtp"; host: string; port: number; secure: boolean; user: string | null; password: string | null; from: string; replyTo: string | null }
    | { mode: "platform"; smtpUrl: string; from: string; replyTo: string | null };
  /** The business's SMS gateway: signed JSON posted to its address. */
  sms: { provider: "none" } | { provider: "webhook"; url: string; secret: string; senderId: string | null };
}

export interface Delivery {
  provider: string;
  providerMessageId: string | null;
}

export class DeliveryError extends Error {}

export interface Messenger {
  readonly driver: "live" | "log";
  deliver(channels: Channels, message: Outgoing): Promise<Delivery>;
}

/** Records messages without sending them (development, demos, tests). */
export class LogMessenger implements Messenger {
  readonly driver = "log" as const;
  readonly sent: Outgoing[] = [];
  private failure: string | null = null;
  constructor(private readonly log?: (msg: string) => void) {}
  /** Tests: the next delivery fails with this reason. */
  failNext(reason: string): void {
    this.failure = reason;
  }
  async deliver(_channels: Channels, message: Outgoing): Promise<Delivery> {
    if (this.failure) {
      const reason = this.failure;
      this.failure = null;
      throw new DeliveryError(reason);
    }
    this.sent.push(message);
    this.log?.(`${message.channel} to ${message.to.slice(0, 4)}…: ${message.subject ?? message.text.slice(0, 60)}${message.attachment ? ` + ${message.attachment.filename}` : ""}`);
    return { provider: "log", providerMessageId: `log-${this.sent.length}` };
  }
}

interface Mail {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}
type SmtpOptions = string | { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } };
/** Makes an SMTP transport (tests pass nodemailer's stream transport instead). */
export type MailTransport = (options: SmtpOptions) => { sendMail(mail: Mail): Promise<{ messageId?: string }> };

/**
 * Sends for real: WhatsApp through the Meta Cloud API (the PDF is uploaded as
 * media, then sent in an approved template with a document header, or as a
 * document with a caption inside the 24-hour window) or through a provider's
 * webhook (signed JSON with the PDF inline), and email over SMTP.
 */
export class LiveMessenger implements Messenger {
  readonly driver = "live" as const;
  constructor(
    private readonly whatsappApiBase: string,
    private readonly mailTransport: MailTransport = (o) => createTransport(o as Parameters<typeof createTransport>[0]),
  ) {}

  async deliver(channels: Channels, message: Outgoing): Promise<Delivery> {
    if (message.channel === "whatsapp") {
      const w = channels.whatsapp;
      if (w.provider === "meta") return this.meta(w, message);
      if (w.provider === "webhook") return this.webhook(w, message);
      throw new DeliveryError("WhatsApp is not set up");
    }
    if (message.channel === "sms") {
      if (channels.sms.provider === "webhook") return this.sms(channels.sms, message);
      throw new DeliveryError("SMS is not set up");
    }
    return this.email(channels.email, message);
  }

  /**
   * SMS through the business's gateway (an adapter for its SMS provider):
   * JSON {channel, to, text, senderId, templateId} signed like the WhatsApp
   * webhook. In India the text must match the DLT template registered under
   * templateId; the gateway answers {id} or {error}.
   */
  private async sms(s: { url: string; secret: string; senderId: string | null }, m: Outgoing): Promise<Delivery> {
    const raw = JSON.stringify({ channel: "sms", to: `+${m.to}`, text: m.text, senderId: s.senderId, templateId: m.template?.name ?? null });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", s.secret).update(`${timestamp}.${raw}`).digest("hex");
    const res = await fetch(s.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-digitalbahi-timestamp": timestamp, "x-digitalbahi-signature": `sha256=${signature}` },
      body: raw,
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (!res.ok) throw new DeliveryError(body?.error ?? `SMS gateway responded ${res.status}`);
    return { provider: "sms_webhook", providerMessageId: body?.id ?? null };
  }

  private async meta(w: { phoneNumberId: string; token: string }, m: Outgoing): Promise<Delivery> {
    const base = `${this.whatsappApiBase}/${encodeURIComponent(w.phoneNumberId)}`;
    const auth = { authorization: `Bearer ${w.token}` };
    let mediaId: string | null = null;
    if (m.attachment) {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", m.attachment.contentType);
      form.append("file", new Blob([new Uint8Array(m.attachment.content)], { type: m.attachment.contentType }), m.attachment.filename);
      const up = await fetch(`${base}/media`, { method: "POST", headers: auth, body: form, signal: AbortSignal.timeout(30_000) });
      const body = (await up.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
      if (!up.ok || !body?.id) throw new DeliveryError(body?.error?.message ?? `WhatsApp media upload failed (${up.status})`);
      mediaId = body.id;
    }
    const document = mediaId && m.attachment ? { id: mediaId, filename: m.attachment.filename } : null;
    const payload = m.template
      ? {
          messaging_product: "whatsapp",
          to: m.to,
          type: "template",
          template: {
            name: m.template.name,
            language: { code: m.template.language },
            components: [
              ...(document ? [{ type: "header", parameters: [{ type: "document", document }] }] : []),
              { type: "body", parameters: m.template.params.map((text) => ({ type: "text", text })) },
            ],
          },
        }
      : document
        ? { messaging_product: "whatsapp", to: m.to, type: "document", document: { ...document, caption: m.text } }
        : { messaging_product: "whatsapp", to: m.to, type: "text", text: { body: m.text } };
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as { messages?: Array<{ id: string }>; error?: { message?: string } } | null;
    if (!res.ok) throw new DeliveryError(body?.error?.message ?? `WhatsApp responded ${res.status}`);
    return { provider: "meta", providerMessageId: body?.messages?.[0]?.id ?? null };
  }

  private async webhook(w: { url: string; secret: string }, m: Outgoing): Promise<Delivery> {
    const raw = JSON.stringify({
      channel: "whatsapp",
      to: `+${m.to}`,
      text: m.text,
      template: m.template,
      document: m.attachment ? { filename: m.attachment.filename, contentType: m.attachment.contentType, base64: m.attachment.content.toString("base64") } : null,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", w.secret).update(`${timestamp}.${raw}`).digest("hex");
    const res = await fetch(w.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-digitalbahi-timestamp": timestamp, "x-digitalbahi-signature": `sha256=${signature}` },
      body: raw,
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (!res.ok) throw new DeliveryError(body?.error ?? `WhatsApp provider responded ${res.status}`);
    return { provider: "webhook", providerMessageId: body?.id ?? null };
  }

  private async email(e: Channels["email"], m: Outgoing): Promise<Delivery> {
    if (e.mode === "none") throw new DeliveryError("Email is not set up");
    const transport =
      e.mode === "platform"
        ? this.mailTransport(e.smtpUrl)
        : this.mailTransport({ host: e.host, port: e.port, secure: e.secure, ...(e.user ? { auth: { user: e.user, pass: e.password ?? "" } } : {}) });
    try {
      const info = await transport.sendMail({
        from: e.from,
        to: m.to,
        ...(e.replyTo ? { replyTo: e.replyTo } : {}),
        subject: m.subject ?? "",
        text: m.text,
        ...(m.attachment ? { attachments: [{ filename: m.attachment.filename, content: m.attachment.content, contentType: m.attachment.contentType }] } : {}),
      });
      return { provider: "smtp", providerMessageId: info.messageId ?? null };
    } catch (err) {
      throw new DeliveryError((err as Error).message);
    }
  }
}
