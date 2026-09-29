import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

/**
 * Line/area trend chart drawn in SVG. One y-axis only (both series are rupees),
 * 2px lines, a 10% area wash for the primary series, hairline grid, legend
 * above, crosshair + tooltip on hover/keyboard, and an optional table view.
 */
export interface TrendSeries {
  key: string;
  label: string;
  /** CSS colour, normally a --series-n token. */
  color: string;
  values: number[];
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Monotone cubic interpolation (as d3's curveMonotoneX): smooth, and it never overshoots the data. */
function smoothPath(points: ReadonlyArray<readonly [number, number]>): string {
  const n = points.length;
  if (n === 0) return "";
  if (n < 3) return points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  const dx = points.slice(1).map((p, i) => p[0] - points[i]![0]);
  const slope = points.slice(1).map((p, i) => (p[1] - points[i]![1]) / (dx[i] || 1));
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0]!;
    if (i === n - 1) return slope[n - 2]!;
    const a = slope[i - 1]!;
    const b = slope[i]!;
    return a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b);
  });
  let d = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const h = (x1 - x0) / 3;
    d += ` C${(x0 + h).toFixed(1)},${(y0 + h * tangent[i]!).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - h * tangent[i + 1]!).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

export function TrendChart({
  series,
  labels,
  tooltipLabels,
  formatValue,
  formatAxis,
  height = 240,
  ariaLabel,
  showTable,
  tableHeader,
}: {
  series: TrendSeries[];
  labels: string[];
  tooltipLabels?: string[];
  formatValue(v: number): string;
  formatAxis(v: number): string;
  height?: number;
  ariaLabel: string;
  showTable?: boolean;
  tableHeader: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gid = useId().replace(/:/g, "");
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { top: 12, right: 16, bottom: 26, left: 56 };
  const n = labels.length;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = useMemo(() => niceMax(Math.max(1, ...series.flatMap((s) => s.values))), [series]);
  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(innerW / 72))));

  // Smooth, but never overshooting: a monotone cubic through the points (no dip below zero).
  const path = (values: number[]) => smoothPath(values.map((v, i) => [x(i), y(v)] as const));
  const area = (values: number[]) => `${path(values)} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;

  const onMove = (clientX: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const px = clientX - rect.left;
    const idx = Math.round(((px - pad.left) / innerW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, idx)));
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === "Escape") setHover(null);
  };

  if (showTable) {
    return (
      <div className="scroll-x max-h-[260px] overflow-y-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-surface text-left text-ink-3">
            <tr>
              <th className="py-1.5 pr-4 font-medium">{tableHeader}</th>
              {series.map((s) => (
                <th key={s.key} className="py-1.5 pr-4 text-right font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="num">
            {labels.map((l, i) => (
              <tr key={l + i} className="border-t border-line">
                <td className="py-1.5 pr-4 text-ink-2">{tooltipLabels?.[i] ?? l}</td>
                {series.map((s) => (
                  <td key={s.key} className="py-1.5 pr-4 text-right text-ink">
                    {formatValue(s.values[i] ?? 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const tipX = hover !== null ? x(hover) : 0;
  const tipLeft = Math.min(Math.max(tipX + 12, 0), width - 190);

  return (
    <div ref={wrapRef} className="relative w-full select-none" onPointerLeave={() => setHover(null)}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        className="block touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-lg"
      >
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tv)} y2={y(tv)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.left - 8} y={y(tv) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)" className="num">
              {formatAxis(tv)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          // Every few labels, and the last one (without crowding the label just before it).
          (i % labelEvery === 0 && (n - 1 - i >= labelEvery * 0.75 || i === 0)) || i === n - 1 ? (
            <text
              key={l + i}
              x={x(i)}
              y={height - 6}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize={11}
              fill="var(--ink-3)"
            >
              {l}
            </text>
          ) : null,
        )}
        <defs>
          <linearGradient id={`${gid}-area`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={series[0]?.color} stopOpacity={0.26} />
            <stop offset="100%" stopColor={series[0]?.color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {series[0] && <path d={area(series[0].values)} fill={`url(#${gid}-area)`} className="chart-fade" />}
        {series.map((s) => (
          <path key={s.key} d={path(s.values)} pathLength={1} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className="chart-draw" />
        ))}
        {/* End markers */}
        {series.map((s) => (
          <circle key={`end-${s.key}`} cx={x(n - 1)} cy={y(s.values[n - 1] ?? 0)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
        ))}
        {hover !== null && (
          <g>
            <line x1={tipX} x2={tipX} y1={pad.top} y2={pad.top + innerH} stroke="var(--border-strong)" strokeWidth={1} />
            {series.map((s) => (
              <circle key={s.key} cx={tipX} cy={y(s.values[hover] ?? 0)} r={5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="glass pointer-events-none absolute top-2 z-10 w-[178px] rounded-xl border border-line/70 px-3 py-2 shadow-pop"
          style={{ left: tipLeft }}
        >
          <p className="mb-1 text-[12px] font-medium text-ink-2">{tooltipLabels?.[hover] ?? labels[hover]}</p>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-[12.5px]">
              <span className="h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
              <span className="flex-1 text-ink-3">{s.label}</span>
              <span className="num font-medium text-ink">{formatValue(s.values[hover] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <span className="h-[3px] w-3.5 rounded-full" style={{ background: i.color }} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}
