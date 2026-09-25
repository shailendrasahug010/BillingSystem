import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeliveryError, LiveMessenger, type Channels, type MailTransport, type Outgoing } from "../src/services/messaging/transport.js";

/** A stand-in for the Meta Graph API and a WhatsApp provider's webhook, recording what arrives. */
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

const pdf = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF");
const bill: Outgoing = {
  channel: "whatsapp",
  to: "919826011111",
  subject: null,
  text: "Namaste Sharma Kirana, invoice INV/26-27/00001 dated 24/09/2026 for ₹1,180.00.",
  attachment: { filename: "INV-26-27-00001.pdf", content: pdf, contentType: "application/pdf" },
  template: { name: "bill_with_pdf", language: "en", params: ["Sharma Kirana", "INV/26-27/00001", "₹1,180.00", "Laxmi Traders"] },
};
const noEmail: Channels["email"] = { mode: "none" };

describe("sending through Meta, a provider webhook and SMTP", () => {
  let server: Server;
  let base: string;
  const seen: Seen[] = [];
  let failMessages = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
        res.setHeader("content-type", "application/json");
        if (req.url!.endsWith("/media")) return res.end(JSON.stringify({ id: "media-4471" }));
        if (req.url!.endsWith("/messages")) {
          if (failMessages) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: { message: "(#132001) Template name does not exist in the translation" } }));
          }
          return res.end(JSON.stringify({ messages: [{ id: "wamid.HBgM" }] }));
        }
        if (req.url === "/hook") return res.end(JSON.stringify({ id: "prov-77" }));
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("uploads the PDF to Meta, then sends the template with it as the header", async () => {
    seen.length = 0;
    const m = new LiveMessenger(`${base}/v21.0`);
    const d = await m.deliver({ whatsapp: { provider: "meta", phoneNumberId: "109876543210", token: "EAAG-token" }, email: noEmail }, bill);
    expect(d).toEqual({ provider: "meta", providerMessageId: "wamid.HBgM" });
    const [upload, send] = seen;
    expect(upload!.url).toBe("/v21.0/109876543210/media");
    expect(upload!.headers.authorization).toBe("Bearer EAAG-token");
    expect(upload!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const form = upload!.body.toString("latin1");
    expect(form).toContain('name="messaging_product"');
    expect(form).toContain('filename="INV-26-27-00001.pdf"');
    expect(form).toContain("%PDF-1.7");
    expect(send!.url).toBe("/v21.0/109876543210/messages");
    expect(JSON.parse(send!.body.toString())).toEqual({
      messaging_product: "whatsapp",
      to: "919826011111",
      type: "template",
      template: {
        name: "bill_with_pdf",
        language: { code: "en" },
        components: [
          { type: "header", parameters: [{ type: "document", document: { id: "media-4471", filename: "INV-26-27-00001.pdf" } }] },
          { type: "body", parameters: bill.template!.params.map((text) => ({ type: "text", text })) },
        ],
      },
    });
  });

  it("sends a document with a caption when there is no template, and reports Meta's error", async () => {
    seen.length = 0;
    const m = new LiveMessenger(`${base}/v21.0`);
    const channels: Channels = { whatsapp: { provider: "meta", phoneNumberId: "1098", token: "t" }, email: noEmail };
    await m.deliver(channels, { ...bill, template: null });
    expect(JSON.parse(seen[1]!.body.toString())).toMatchObject({ type: "document", document: { id: "media-4471", filename: "INV-26-27-00001.pdf", caption: bill.text } });
    failMessages = true;
    await expect(m.deliver(channels, bill)).rejects.toThrow(new DeliveryError("(#132001) Template name does not exist in the translation"));
    failMessages = false;
  });

  it("signs the JSON it posts to a provider's webhook", async () => {
    seen.length = 0;
    const m = new LiveMessenger(`${base}/v21.0`);
    const d = await m.deliver({ whatsapp: { provider: "webhook", url: `${base}/hook`, secret: "shared-secret-123" }, email: noEmail }, bill);
    expect(d).toEqual({ provider: "webhook", providerMessageId: "prov-77" });
    const req = seen[0]!;
    const raw = req.body.toString();
    const expected = createHmac("sha256", "shared-secret-123").update(`${req.headers["x-digitalbahi-timestamp"]}.${raw}`).digest("hex");
    expect(req.headers["x-digitalbahi-signature"]).toBe(`sha256=${expected}`);
    const body = JSON.parse(raw);
    expect(body).toMatchObject({ channel: "whatsapp", to: "+919826011111", text: bill.text, template: bill.template, document: { filename: "INV-26-27-00001.pdf", contentType: "application/pdf" } });
    expect(Buffer.from(body.document.base64, "base64").equals(pdf)).toBe(true);
  });

  it("emails the PDF from the business's own server, replies going to the firm", async () => {
    const mails: string[] = [];
    let options: unknown;
    const stream: MailTransport = (o) => {
      options = o;
      const tr = createTransport({ streamTransport: true, buffer: true });
      return {
        sendMail: async (mail) => {
          const info = (await tr.sendMail(mail)) as unknown as { message: Buffer; messageId: string };
          mails.push(info.message.toString());
          return { messageId: info.messageId };
        },
      };
    };
    const m = new LiveMessenger(`${base}/v21.0`, stream);
    const d = await m.deliver(
      {
        whatsapp: { provider: "none" },
        email: { mode: "smtp", host: "smtp.example.in", port: 587, secure: false, user: "bills@laxmitraders.in", password: "pw", from: '"Laxmi Traders" <bills@laxmitraders.in>', replyTo: "accounts@laxmitraders.in" },
      },
      { ...bill, channel: "email", to: "sharma@example.in", subject: "Invoice INV/26-27/00001 from Laxmi Traders", template: null },
    );
    expect(d.provider).toBe("smtp");
    expect(options).toEqual({ host: "smtp.example.in", port: 587, secure: false, auth: { user: "bills@laxmitraders.in", pass: "pw" } });
    const mail = mails[0]!;
    expect(mail).toContain("To: sharma@example.in");
    expect(mail).toContain("Reply-To: accounts@laxmitraders.in");
    expect(mail).toContain("Subject: Invoice INV/26-27/00001 from Laxmi Traders");
    expect(mail).toMatch(/Content-Type: application\/pdf; name=INV-26-27-00001\.pdf/);
    expect(mail).toContain("Content-Disposition: attachment; filename=INV-26-27-00001.pdf");
    await expect(m.deliver({ whatsapp: { provider: "none" }, email: noEmail }, { ...bill, channel: "email" })).rejects.toThrow("Email is not set up");
  });
});
