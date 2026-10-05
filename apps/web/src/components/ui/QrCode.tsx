import { qrMatrix } from "@digitalbahi/core";

/** A QR code as crisp SVG, black on white whatever the theme (cameras read it). */
export function QrCode({ text, size = 180, label }: { text: string; size?: number; label: string }) {
  const m = qrMatrix(text);
  const quiet = 2;
  const n = m.length + quiet * 2;
  const path = m.flatMap((row, r) => row.flatMap((dark, c) => (dark ? [`M${c + quiet} ${r + quiet}h1v1h-1z`] : []))).join("");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges" className="rounded-lg">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
