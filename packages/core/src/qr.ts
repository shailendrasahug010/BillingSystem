import qrcode from "qrcode-generator";

/**
 * The dark modules of a QR code for `text`, row by row, to draw on screen
 * (SVG) or in a PDF: the e-invoice's signed QR code from the IRP.
 */
export function qrMatrix(text: string, level: "L" | "M" | "Q" | "H" = "M"): boolean[][] {
  const qr = qrcode(0, level);
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}
