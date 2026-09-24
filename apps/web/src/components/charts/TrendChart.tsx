import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

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

  const path = (values: number[]) => values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
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
          i % labelEvery === 0 || i === n - 1 ? (
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
        {series[0] && <path d={area(series[0].values)} fill={series[0].color} fillOpacity={0.1} />}
        {series.map((s) => (
          <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
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
          className="pointer-events-none absolute top-2 z-10 w-[178px] rounded-lg border border-line bg-surface px-3 py-2 shadow-pop"
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
