import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FcmPush, type PushMessage } from "../src/services/push.js";

/** A stand-in for Google's token endpoint and FCM's HTTP v1 API, recording what arrives and answering as told. */
interface Seen {
  url: string;
  authorization: string | undefined;
  body: string;
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const message: PushMessage = {
  token: "fcm-token-of-the-owners-phone-0001",
  title: "3 customer bills are overdue: ₹45,230.50",
  body: "Oldest: INV/26-27/00012 for Sharma Kirana.",
  tag: "customer_payment_due",
  urgent: true,
  data: { notificationId: "01a0f000-0000-7000-8000-000000000001", businessId: "01a0f000-0000-7000-8000-0000000000b1", type: "customer_payment_due" },
};

describe("push messages through Firebase Cloud Messaging", () => {
  let server: Server;
  let base: string;
  const seen: Seen[] = [];
  let tokensIssued = 0;
  /** What FCM answers next (status and body); default: accepted. */
  const answers: Array<{ status: number; body: unknown }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ url: req.url!, authorization: req.headers.authorization, body });
        res.setHeader("content-type", "application/json");
        if (req.url === "/token") {
          tokensIssued++;
          return res.end(JSON.stringify({ access_token: `ya29.access-${tokensIssued}`, expires_in: 3599, token_type: "Bearer" }));
        }
        const next = answers.shift() ?? { status: 200, body: { name: "projects/digitalbahi-test/messages/0:1700000000000000%31bd1c9631bd1c96" } };
        res.statusCode = next.status;
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const fcm = () => new FcmPush({ projectId: "digitalbahi-test", clientEmail: "fcm-sender@digitalbahi-test.iam.gserviceaccount.com", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), tokenUri: `${base}/token` }, base);

  it("signs in with the service account (a signed JWT) and sends the message, high priority on the alerts channel", async () => {
    seen.length = 0;
    const push = fcm();
    expect(await push.send(message)).toEqual({ ok: true, id: "projects/digitalbahi-test/messages/0:1700000000000000%31bd1c9631bd1c96" });
    const [signIn, send] = seen;
    const form = new URLSearchParams(signIn!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const c = JSON.parse(Buffer.from(claims!, "base64url").toString());
    expect(c).toMatchObject({ iss: "fcm-sender@digitalbahi-test.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging", aud: `${base}/token` });
    expect(c.exp - c.iat).toBe(3600);
    expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);

    expect(send!.url).toBe("/v1/projects/digitalbahi-test/messages:send");
    expect(send!.authorization).toBe(`Bearer ya29.access-${tokensIssued}`);
    expect(JSON.parse(send!.body)).toEqual({
      message: {
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: { priority: "high", notification: { tag: "customer_payment_due", channel_id: "alerts" } },
      },
    });
    // The access token is kept for the next message.
    await push.send({ ...message, urgent: false, body: null });
    expect(seen.filter((s) => s.url === "/token")).toHaveLength(1);
    expect(JSON.parse(seen.at(-1)!.body).message).toMatchObject({ notification: { title: message.title }, android: { priority: "normal", notification: { channel_id: "updates" } } });
    expect(JSON.parse(seen.at(-1)!.body).message.notification).not.toHaveProperty("body");
  });

  it("signs in again once when FCM refuses the access token", async () => {
    seen.length = 0;
    const push = fcm();
    await push.send(message);
    answers.push({ status: 401, body: { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } } });
    const before = tokensIssued;
    expect((await push.send(message)).ok).toBe(true);
    expect(tokensIssued).toBe(before + 1);
  });

  it("says when a token no longer works (app uninstalled, another project), and when a failure is FCM's", async () => {
    const push = fcm();
    answers.push({ status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } } });
    expect(await push.send(message)).toEqual({ ok: false, invalidToken: true, error: "UNREGISTERED: Requested entity was not found." });
    answers.push({ status: 400, body: { error: { code: 400, message: "The registration token is not a valid FCM registration token", status: "INVALID_ARGUMENT", details: [{ errorCode: "INVALID_ARGUMENT" }] } } });
    expect(await push.send(message)).toMatchObject({ ok: false, invalidToken: true });
    answers.push({ status: 503, body: { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE", details: [{ errorCode: "UNAVAILABLE" }] } } });
    expect(await push.send(message)).toEqual({ ok: false, invalidToken: false, error: "UNAVAILABLE: The service is currently unavailable." });
  });

  it("reports a sign-in Google refuses without sending anything", async () => {
    seen.length = 0;
    const push = new FcmPush({ projectId: "digitalbahi-test", clientEmail: "x@y", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), tokenUri: `${base}/no-such-endpoint` }, base);
    answers.push({ status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } });
    expect(await push.send(message)).toEqual({ ok: false, invalidToken: false, error: "Google sign-in for FCM failed: Invalid JWT Signature." });
    expect(seen.some((s) => s.url.includes("messages:send"))).toBe(false);
  });
});
