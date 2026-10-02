/**
 * ESC/POS for the small thermal printers salespeople carry (58 mm, 384 dots
 * wide; 80 mm, 576 dots): the commands as bytes, and a picture of the
 * receipt as raster rows. Printers' own fonts have no Devanagari, so a
 * receipt is drawn (in English or Hindi) and sent as an image; text mode is
 * kept for a test page.
 */

export type Align = "left" | "center" | "right";

/** A 1-bit picture: `width` a multiple of 8, rows packed 8 dots a byte, the leftmost dot in the high bit, 1 = black. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Dots across the paper for each width. */
export const PAPER_DOTS = { 58: 384, 80: 576 } as const;
export type PaperWidth = keyof typeof PAPER_DOTS;

const ESC = 0x1b;
const GS = 0x1d;

/** Rows sent in one raster command: small printers buffer only so much. */
const BAND = 128;

export class EscPos {
  private readonly out: number[] = [];

  private push(...bytes: number[]): this {
    for (const b of bytes) this.out.push(b & 0xff);
    return this;
  }

  /** Clears the printer's settings (ESC @). */
  init(): this {
    return this.push(ESC, 0x40);
  }

  align(a: Align): this {
    return this.push(ESC, 0x61, a === "left" ? 0 : a === "center" ? 1 : 2);
  }

  bold(on: boolean): this {
    return this.push(ESC, 0x45, on ? 1 : 0);
  }

  /** Character size: 1 to 8 times as wide and tall (GS !). */
  size(width: number, height: number): this {
    const w = Math.min(8, Math.max(1, Math.round(width))) - 1;
    const h = Math.min(8, Math.max(1, Math.round(height))) - 1;
    return this.push(GS, 0x21, (w << 4) | h);
  }

  /** Text in the printer's own font: ASCII only (anything else prints as "?"). */
  text(s: string): this {
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      this.push(c === 0x0a || (c >= 0x20 && c < 0x7f) ? c : 0x3f);
    }
    return this;
  }

  line(s = ""): this {
    return this.text(s).push(0x0a);
  }

  /** Prints what is buffered and feeds `lines` lines (ESC d). */
  feed(lines = 1): this {
    return this.push(ESC, 0x64, Math.min(255, Math.max(0, lines)));
  }

  /** Feeds the paper out and cuts it where there is a cutter (GS V B); printers without one ignore it. */
  cut(): this {
    return this.push(GS, 0x56, 0x42, 0x00);
  }

  /** A picture, in bands of rows (GS v 0). */
  raster(bitmap: Bitmap): this {
    if (bitmap.width % 8 !== 0) throw new Error("raster width must be a multiple of 8");
    const bytesPerRow = bitmap.width / 8;
    if (bitmap.data.length !== bytesPerRow * bitmap.height) throw new Error("raster data does not match its size");
    for (let top = 0; top < bitmap.height; top += BAND) {
      const rows = Math.min(BAND, bitmap.height - top);
      this.push(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8);
      const band = bitmap.data.subarray(top * bytesPerRow, (top + rows) * bytesPerRow);
      for (const b of band) this.out.push(b);
    }
    return this;
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/**
 * Packs a picture's pixels (RGBA, as a canvas gives them) into 1-bit rows:
 * a dot is black where the pixel is darker than `threshold` (0-255;
 * transparent counts as white). The width is padded to a multiple of 8.
 */
export function packBitmap(rgba: ArrayLike<number>, width: number, height: number, threshold = 160): Bitmap {
  const out = Math.ceil(width / 8) * 8;
  const bytesPerRow = out / 8;
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const alpha = rgba[i + 3]! / 255;
      // Luminance over white.
      const lum = (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * alpha + 255 * (1 - alpha);
      if (lum < threshold) data[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { width: out, height, data };
}

/** Rows that are all white at the bottom, cut off (a drawn receipt is taller than its contents). */
export function trimBitmap(bitmap: Bitmap): Bitmap {
  const bytesPerRow = bitmap.width / 8;
  let height = bitmap.height;
  while (height > 0 && bitmap.data.subarray((height - 1) * bytesPerRow, height * bytesPerRow).every((b) => b === 0)) height--;
  return { width: bitmap.width, height, data: bitmap.data.slice(0, height * bytesPerRow) };
}

/** A whole receipt: the printer cleared, the picture, paper fed out and cut. */
export function receiptBytes(bitmap: Bitmap, feedLines = 4): Uint8Array {
  return new EscPos().init().align("center").raster(bitmap).feed(feedLines).cut().bytes();
}

/** The pictures in a stream of bytes sent to a printer (to check what was printed). */
export function rasterImages(bytes: Uint8Array): Bitmap[] {
  const bands: Bitmap[] = [];
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (bytes[i] !== GS || bytes[i + 1] !== 0x76 || bytes[i + 2] !== 0x30) continue;
    const bytesPerRow = bytes[i + 4]! | (bytes[i + 5]! << 8);
    const rows = bytes[i + 6]! | (bytes[i + 7]! << 8);
    const start = i + 8;
    bands.push({ width: bytesPerRow * 8, height: rows, data: bytes.slice(start, start + bytesPerRow * rows) });
    i = start + bytesPerRow * rows - 1;
  }
  // Bands one after the other make one picture while they are as wide.
  const images: Bitmap[] = [];
  for (const b of bands) {
    const last = images[images.length - 1];
    if (last && last.width === b.width) {
      const data = new Uint8Array(last.data.length + b.data.length);
      data.set(last.data);
      data.set(b.data, last.data.length);
      images[images.length - 1] = { width: last.width, height: last.height + b.height, data };
    } else images.push(b);
  }
  return images;
}
