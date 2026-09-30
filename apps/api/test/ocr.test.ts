import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageSize, pageLines } from "../src/services/ocr.js";
import { call, createTestApp, hasDatabase, nextMobile, signup, type Session, type TestApp } from "./helpers.js";

const bill = readFileSync(new URL("./fixtures/bill-photo.png", import.meta.url));

describe("reading a page image", () => {
  it("knows a PNG's and a JPEG's size from the header alone", () => {
    expect(imageSize(bill)).toEqual({ type: "png", width: 1800, height: 660 });
    // SOI, an APP0 segment, then a baseline frame of 640 x 480.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01]);
    expect(imageSize(jpeg)).toEqual({ type: "jpeg", width: 640, height: 480 });
    expect(imageSize(Buffer.from("%PDF-1.7 not an image"))).toBeNull();
  });

  it("keeps words a single space apart in one cell and drops scraps of table rules", () => {
    const word = (text: string, x0: number, x1: number, confidence = 95) => ({ text, confidence, bbox: { x0, y0: 90, x1, y1: 110 } });
    const lines = pageLines([
      {
        text: "1    Glucose Biscuit 100g | 1905   120 PCS  ——  8.50\n",
        words: [word("1", 10, 20), word("Glucose", 60, 150), word("Biscuit", 160, 240), word("100g", 250, 300), word("|", 310, 312, 40), word("1905", 330, 380), word("120", 450, 490), word("PCS", 500, 540), word("——", 560, 600, 30), word("8.50", 620, 670)],
        baseline: { x0: 10, y0: 108, x1: 670, y1: 112 },
        rowAttributes: { rowHeight: 20, descenders: 5, ascenders: 5 },
      },
      { text: "— —\n", words: [word("—", 10, 40), word("—", 50, 80)], baseline: { x0: 10, y0: 130, x1: 80, y1: 130 }, rowAttributes: { rowHeight: 20, descenders: 5, ascenders: 5 } },
    ]);
    expect(lines).toEqual([
      {
        y: 110,
        height: 25,
        cells: [
          { text: "1", x0: 10, x1: 20 },
          { text: "Glucose Biscuit 100g", x0: 60, x1: 300 },
          { text: "1905", x0: 330, x1: 380 },
          { text: "120 PCS", x0: 450, x1: 540 },
          { text: "8.50", x0: 620, x1: 670 },
        ],
      },
    ]);
  });
});

describe.skipIf(!hasDatabase)("POST /imports/read-page", () => {
  let t: TestApp;
  let owner: Session;
  let hr: string;

  const read = (body: Buffer, token = owner.token) => call(t.app, "POST", "/imports/read-page", { token, body, headers: { "content-type": "application/octet-stream" } });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signup(t, { legalName: "Photo Traders", stateCode: "23" });
    const roles = Object.fromEntries((await call(t.app, "GET", "/roles", { token: owner.token })).body.data.map((r: { key: string; id: string }) => [r.key, r.id]));
    const mobile = nextMobile();
    await call(t.app, "POST", "/members", { token: owner.token, body: { name: "HR person", mobile, roleId: roles.hr } });
    await call(t.app, "POST", "/auth/otp", { body: { mobile, purpose: "login" } });
    hr = (await call(t.app, "POST", "/auth/login/otp", { body: { mobile, otp: t.otp.last(mobile) } })).body.accessToken;
  });
  afterAll(async () => {
    await t?.close();
  });

  it("reads the lines of a photographed bill into cells", async () => {
    const res = await read(bill);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ width: 1800, height: 660 });
    const texts = res.body.lines.map((l: { cells: Array<{ text: string }> }) => l.cells.map((c) => c.text));
    expect(texts).toContainEqual(["Sr", "Item Description", "HSN", "Qty", "Rate", "GST%", "Amount"]);
    expect(texts).toContainEqual(["1", "Glucose Biscuit 100g", "1905", "120", "8.50", "5", "1020.00"]);
    expect(texts).toContainEqual(["2", "Salted Crackers 75g", "1905", "48", "9.20", "18", "441.60"]);
    expect(texts).toContainEqual(["3", "Cream Biscuit 60g", "1905", "24", "25.00", "18", "600.00"]);
    // Lines come top to bottom, with the height of their letters.
    const ys = res.body.lines.map((l: { y: number }) => l.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    const row = res.body.lines.find((l: { cells: Array<{ text: string }> }) => l.cells[0]?.text === "1");
    expect(row.height).toBeGreaterThan(20);
    expect(row.height).toBeLessThan(50);
  }, 30_000);

  it("refuses what is not a PNG or JPEG, a page too large to read, and people who cannot import", async () => {
    expect((await read(Buffer.from("%PDF-1.7 not an image"))).body.error.code).toBe("OCR_IMAGE_UNSUPPORTED");
    const huge = Buffer.from(bill);
    huge.writeUInt32BE(20000, 16);
    const tooLarge = await read(huge);
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.error).toMatchObject({ code: "OCR_IMAGE_TOO_LARGE", params: { max: 6000 } });
    expect((await read(bill, hr)).status).toBe(403);
    expect((await call(t.app, "POST", "/imports/read-page", { body: bill, headers: { "content-type": "application/octet-stream" } })).status).toBe(401);
  });
});
