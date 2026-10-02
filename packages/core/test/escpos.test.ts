import { describe, expect, it } from "vitest";
import { EscPos, packBitmap, rasterImages, receiptBytes, trimBitmap, upiPayLink, UPI_ID, type Bitmap } from "../src/index.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

/** A white RGBA picture with the given pixels black. */
function picture(width: number, height: number, black: Array<[number, number]>) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y] of black) rgba.set([0, 0, 0, 255], (y * width + x) * 4);
  return rgba;
}

describe("ESC/POS", () => {
  it("writes the commands a thermal printer takes", () => {
    const b = new EscPos().init().align("center").bold(true).size(2, 2).line("Bill 12").bold(false).size(1, 1).feed(3).cut().bytes();
    expect(hex(b)).toBe("1b 40 1b 61 01 1b 45 01 1d 21 11 42 69 6c 6c 20 31 32 0a 1b 45 00 1d 21 00 1b 64 03 1d 56 42 00");
  });

  it("prints what its font lacks as a question mark (Hindi goes as a picture)", () => {
    expect([...new EscPos().text("₹5 दाल").bytes()].map((c) => String.fromCharCode(c)).join("")).toBe("?5 ???");
  });

  it("packs pixels into dots, the leftmost in the high bit, padding the width to 8", () => {
    const rgba = picture(10, 2, [
      [0, 0],
      [7, 0],
      [9, 1],
    ]);
    // A transparent pixel counts as white; a mid grey is black below the threshold only.
    rgba.set([0, 0, 0, 0], (1 * 10 + 0) * 4);
    rgba.set([150, 150, 150, 255], (1 * 10 + 1) * 4);
    const bmp = packBitmap(rgba, 10, 2);
    expect(bmp.width).toBe(16);
    expect([...bmp.data]).toEqual([0b10000001, 0, 0b01000000, 0b01000000]);
    expect([...packBitmap(rgba, 10, 2, 140).data][2]).toBe(0);
  });

  it("sends a tall picture in bands the printer can hold, and reads it back", () => {
    const height = 300;
    const rgba = picture(16, height, Array.from({ length: height }, (_, y) => [y % 16, y] as [number, number]));
    const bmp = packBitmap(rgba, 16, height);
    const bytes = new EscPos().raster(bmp).bytes();
    // Three bands: 128, 128 and 44 rows of 2 bytes, each after its 8-byte header.
    expect(bytes.length).toBe(3 * 8 + 2 * height);
    expect(hex(bytes.subarray(0, 8))).toBe("1d 76 30 00 02 00 80 00");
    expect(hex(bytes.subarray(8 + 256, 8 + 256 + 8))).toBe("1d 76 30 00 02 00 80 00");
    expect(hex(bytes.subarray(2 * (8 + 256), 2 * (8 + 256) + 8))).toBe("1d 76 30 00 02 00 2c 00");
    const [back] = rasterImages(receiptBytes(bmp));
    expect(back).toEqual<Bitmap>(bmp);
  });

  it("refuses a picture whose width is not whole bytes", () => {
    expect(() => new EscPos().raster({ width: 10, height: 1, data: new Uint8Array(2) })).toThrow();
  });

  it("cuts the white space under a drawn receipt", () => {
    const bmp = packBitmap(picture(8, 5, [[3, 1]]), 8, 5);
    expect(trimBitmap(bmp)).toEqual({ width: 8, height: 2, data: Uint8Array.from([0, 0b00010000]) });
  });

  it("clears the printer, prints the receipt, feeds and cuts", () => {
    const b = receiptBytes(packBitmap(picture(8, 1, [[0, 0]]), 8, 1), 4);
    expect(hex(b)).toBe("1b 40 1b 61 01 1d 76 30 00 01 00 01 00 80 1b 64 04 1d 56 42 00");
  });
});

describe("UPI", () => {
  it("makes the payment link a UPI app opens with the amount and bill", () => {
    expect(upiPayLink({ upiId: " agrawal@okhdfc ", name: "Agrawal Distributors", amount: "1252", note: "INV/26-27/00012" })).toBe(
      "upi://pay?pa=agrawal%40okhdfc&pn=Agrawal%20Distributors&am=1252.00&cu=INR&tn=INV%2F26-27%2F00012",
    );
    expect(upiPayLink({ upiId: "a@ybl", name: "A", amount: 0 })).toBe("upi://pay?pa=a%40ybl&pn=A&cu=INR");
    expect(UPI_ID.test("agrawal.dist@okhdfcbank")).toBe(true);
    expect(UPI_ID.test("not a upi id")).toBe(false);
  });
});
