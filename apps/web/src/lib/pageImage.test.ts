import { describe, expect, it } from "vitest";
import { fitScale, preparePage, printHeight } from "./pageImage";

describe("a page made ready to read", () => {
  it("stays within the pixels and the side the reader takes", () => {
    expect(fitScale(1000, 800, 2)).toBe(2);
    // A 12 MP phone photo is drawn at most at about its own size.
    expect(fitScale(4032, 3024, 3)).toBeCloseTo(Math.sqrt(12_000_000 / (4032 * 3024)), 6);
    // A long strip (a receipt) keeps its long side at 5000 pixels.
    expect(Math.round(4000 * fitScale(1000, 4000, 3))).toBe(5000);
  });

  it("measures the print from the letter-sized shapes, leaving out rules and specks", () => {
    const W = 800;
    const H = 400;
    const grey = new Uint8ClampedArray(W * H).fill(255);
    const ink = (x0: number, y0: number, w: number, h: number) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) grey[y * W + x] = 0;
    };
    // Four lines of 15 "letters" 18 px tall, a rule, and specks.
    for (let line = 0; line < 4; line++) for (let k = 0; k < 15; k++) ink(20 + 40 * k, 30 + 60 * line, 12, 18);
    ink(10, 280, 700, 2);
    for (let k = 0; k < 40; k++) ink(15 * k + 5, 350, 2, 2);
    expect(printHeight(grey, W, H)).toBe(18);
    expect(printHeight(new Uint8ClampedArray(W * H).fill(255), W, H)).toBeNull();
  });

  it("evens out the lighting, keeps the letters and erases the table rules", () => {
    const W = 600;
    const H = 400;
    // Paper that darkens from left (230) to right (150), as in a shadow.
    const grey = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grey[y * W + x] = 230 - (80 * x) / W;
    const ink = (x0: number, y0: number, w: number, h: number) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) grey[y * W + x] = Math.round(grey[y * W + x]! * 0.25);
    };
    ink(20, 100, 560, 2); // a rule across the table
    ink(300, 20, 2, 360); // a rule down it
    ink(100, 150, 3, 14); // a letter's stroke on the bright side
    ink(500, 150, 3, 14); // and on the shaded side
    preparePage(grey, W, H);
    const at = (x: number, y: number) => grey[y * W + x]!;
    // Paper is white on both sides, the letters black on both sides.
    expect(at(50, 300)).toBe(255);
    expect(at(550, 300)).toBe(255);
    expect(at(101, 157)).toBeLessThan(40);
    expect(at(501, 157)).toBeLessThan(40);
    // The rules are gone.
    expect(at(200, 100)).toBe(255);
    expect(at(200, 101)).toBe(255);
    expect(at(300, 250)).toBe(255);
    expect(at(301, 250)).toBe(255);
  });
});
