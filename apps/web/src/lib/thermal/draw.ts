import { packBitmap, qrMatrix, trimBitmap, type Bitmap } from "@digitalbahi/core";

/**
 * A receipt for a thermal printer, drawn line by line in the app's own
 * fonts (Hindi included, which printers' fonts lack) on a canvas as wide as
 * the paper's dots, then turned into black and white dots.
 */
export type ReceiptItem =
  | { t: "text"; text: string; align?: "left" | "center" | "right"; scale?: number; bold?: boolean }
  /** Text on the left (wrapping), an amount on the right of its first line. */
  | { t: "pair"; left: string; right: string; scale?: number; bold?: boolean }
  | { t: "rule" }
  | { t: "space"; px?: number }
  | { t: "qr"; text: string };

const FAMILY = '"IBM Plex Sans", "IBM Plex Sans Devanagari", sans-serif';
const MARGIN = 6;

/** Splits text into lines that fit `max` pixels (at spaces; a word too long for a line is broken). */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= max) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      line = "";
      // A word wider than the line goes by characters (grapheme by grapheme).
      let piece = "";
      for (const ch of Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word), (s) => s.segment)) {
        if (ctx.measureText(piece + ch).width > max && piece) {
          out.push(piece);
          piece = ch;
        } else piece += ch;
      }
      line = piece;
    }
    out.push(line);
  }
  return out;
}

/** The receipt drawn on a canvas `width` dots wide, black on white. */
export async function drawReceipt(items: ReceiptItem[], width: number): Promise<HTMLCanvasElement> {
  const base = width >= 576 ? 24 : 21;
  // The fonts are the app's own (also offline); make sure they are in before drawing.
  await Promise.all([400, 600].map((w) => document.fonts?.load(`${w} ${base}px ${FAMILY}`, "Aअ₹").catch(() => undefined)));
  const measure = document.createElement("canvas").getContext("2d")!;
  const font = (scale = 1, bold = false) => `${bold ? 600 : 400} ${Math.round(base * scale)}px ${FAMILY}`;
  const lineHeight = (scale = 1) => Math.round(base * scale * 1.38);
  const inner = width - 2 * MARGIN;
  const ops: Array<(ctx: CanvasRenderingContext2D) => void> = [];
  let y = MARGIN;

  for (const item of items) {
    if (item.t === "space") {
      y += item.px ?? Math.round(base / 2);
    } else if (item.t === "rule") {
      const at = y + Math.round(base * 0.35);
      ops.push((ctx) => {
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(MARGIN, at);
        ctx.lineTo(width - MARGIN, at);
        ctx.stroke();
        ctx.setLineDash([]);
      });
      y += Math.round(base * 0.8);
    } else if (item.t === "text") {
      const f = font(item.scale, item.bold);
      measure.font = f;
      for (const line of wrap(measure, item.text, inner)) {
        const at = y;
        const x = item.align === "center" ? width / 2 : item.align === "right" ? width - MARGIN : MARGIN;
        ops.push((ctx) => {
          ctx.font = f;
          ctx.textAlign = item.align ?? "left";
          ctx.fillText(line, x, at);
        });
        y += lineHeight(item.scale);
      }
    } else if (item.t === "pair") {
      const f = font(item.scale, item.bold);
      measure.font = f;
      const rightWidth = measure.measureText(item.right).width;
      const lines = wrap(measure, item.left, Math.max(inner / 3, inner - rightWidth - 12));
      lines.forEach((line, i) => {
        const at = y;
        ops.push((ctx) => {
          ctx.font = f;
          ctx.textAlign = "left";
          ctx.fillText(line, MARGIN, at);
          if (i === 0) {
            ctx.textAlign = "right";
            ctx.fillText(item.right, width - MARGIN, at);
          }
        });
        y += lineHeight(item.scale);
      });
    } else {
      const matrix = qrMatrix(item.text, "M");
      const n = matrix.length;
      const module = Math.max(2, Math.floor(Math.min(inner * 0.62, 260) / n));
      const size = module * n;
      const left = Math.round((width - size) / 2);
      const top = y + 4;
      ops.push((ctx) => {
        matrix.forEach((row, r) => row.forEach((dark, c) => dark && ctx.fillRect(left + c * module, top + r * module, module, module)));
      });
      y += size + 12;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = y + MARGIN;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.textBaseline = "top";
  for (const op of ops) op(ctx);
  return canvas;
}

/** The canvas as the printer's dots. */
export function canvasBitmap(canvas: HTMLCanvasElement): Bitmap {
  const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  return trimBitmap(packBitmap(data, canvas.width, canvas.height));
}
