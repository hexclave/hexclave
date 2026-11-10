"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "../../components/design/cn";
import type { TimeBucket } from "../lib/series";

/**
 * Charts are hand-rolled (the internal tool has no charting dependency). Colours are CSS colour
 * strings rather than Tailwind classes so a series can be coloured from a theme token
 * (`hsl(var(--chart-1))`) and still be used in inline styles and SVG attributes alike.
 */
export const CHART_COLORS = {
  primary: "hsl(var(--chart-1))",
  secondary: "hsl(var(--chart-2))",
  green: "rgb(16 185 129)",
  lime: "rgb(132 204 22)",
  amber: "rgb(245 158 11)",
  orange: "rgb(249 115 22)",
  red: "rgb(239 68 68)",
  cyan: "rgb(6 182 212)",
  pink: "rgb(236 72 153)",
  neutral: "hsl(var(--muted-foreground) / 0.35)",
} as const;

export type ChartSeries = { label: string, color: string };

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function compactNumber(value: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/**
 * Stacked bar chart over time buckets, with gridlines, a y-axis and a hover read-out of every
 * series in the hovered bucket. Built from flex columns rather than SVG so it stays crisp at any
 * width without a resize observer.
 */
export function TimeSeriesChart({ buckets, series, height = 168, emptyLabel = "No activity in this window" }: {
  buckets: readonly TimeBucket[],
  series: readonly ChartSeries[],
  height?: number,
  emptyLabel?: string,
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const totals = buckets.map(bucket => bucket.values.reduce((sum, value) => sum + value, 0));
  const max = niceMax(Math.max(0, ...totals));
  const ticks = [max, max / 2, 0];
  const total = totals.reduce((sum, value) => sum + value, 0);
  const hoveredBucket = hovered == null ? null : buckets.at(hovered) ?? null;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 6));

  return (
    <div>
      <div className="relative flex gap-2" style={{ height }}>
        <div className="relative w-8 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {ticks.map((tick, index) => (
            <span key={tick} className="absolute right-0 -translate-y-1/2 leading-none" style={{ top: `${(index / (ticks.length - 1)) * 100}%` }}>
              {compactNumber(tick)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" onMouseLeave={() => setHovered(null)}>
          {ticks.map((tick, index) => (
            <div
              key={tick}
              aria-hidden="true"
              className={cn("absolute inset-x-0 border-t", index === ticks.length - 1 ? "border-border" : "border-dashed border-[hsl(var(--chart-grid))]")}
              style={{ top: `${(index / (ticks.length - 1)) * 100}%` }}
            />
          ))}
          {total === 0 && (
            <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">{emptyLabel}</div>
          )}
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {buckets.map((bucket, index) => {
              const bucketTotal = totals[index];
              return (
                <div
                  key={bucket.start}
                  className={cn("relative flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm", hovered === index && "bg-foreground/[0.04]")}
                  onMouseEnter={() => setHovered(index)}
                >
                  <div className="flex flex-col-reverse overflow-hidden rounded-t-[3px]" style={{ height: `${(bucketTotal / max) * 100}%` }}>
                    {bucket.values.map((value, seriesIndex) => (
                      <div
                        key={seriesIndex}
                        style={{
                          height: bucketTotal === 0 ? 0 : `${(value / bucketTotal) * 100}%`,
                          backgroundColor: series[seriesIndex]?.color,
                          opacity: hovered == null || hovered === index ? 1 : 0.55,
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {hoveredBucket != null && hovered != null && (
            <div
              className="pointer-events-none absolute -top-2 z-20 w-max min-w-36 -translate-y-full rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
              style={hovered > buckets.length / 2
                ? { right: `${((buckets.length - hovered - 1) / buckets.length) * 100}%` }
                : { left: `${(hovered / buckets.length) * 100}%` }}
            >
              <p className="mb-1 font-medium text-foreground">{hoveredBucket.fullLabel}</p>
              {series.map((item, seriesIndex) => (
                <div key={item.label} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-sm" style={{ backgroundColor: item.color }} />
                    {item.label}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">{(hoveredBucket.values[seriesIndex] ?? 0).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="ml-10 mt-1.5 flex gap-[3px] text-[10px] text-muted-foreground">
        {buckets.map((bucket, index) => (
          <span key={bucket.start} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {index % labelEvery === 0 ? bucket.label : ""}
          </span>
        ))}
      </div>
      {series.length > 1 && (
        <div className="ml-10 mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {series.map(item => <LegendItem key={item.label} color={item.color}>{item.label}</LegendItem>)}
        </div>
      )}
    </div>
  );
}

export function LegendItem({ color, children }: { color: string, children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="size-2 rounded-sm" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

/** Inline trend line for KPI tiles. Values are plotted evenly spaced; no axes. */
export function Sparkline({ values, color = CHART_COLORS.primary, className }: { values: readonly number[], color?: string, className?: string }) {
  const gradientId = useId();
  if (values.length < 2) return <div className={className} />;
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => [(index / (values.length - 1)) * 100, 28 - (value / max) * 26] as const);
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  return (
    <svg aria-hidden="true" viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("overflow-visible", className)}>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L100,30 L0,30 Z`} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export type BarListItem = {
  key: string,
  label: ReactNode,
  value: number,
  /** Overrides the list colour for this row (eg. score buckets). */
  color?: string,
  /** Secondary read-out next to the value (eg. "42%"). */
  detail?: string,
  title?: string,
  onClick?: () => void,
};

/**
 * Ranked horizontal bars with the label drawn over a tinted bar, sized relative to the largest
 * row. Used for every "top N" breakdown in the console.
 */
export function BarList({ items, color = CHART_COLORS.primary, emptyLabel = "No data", formatValue = value => value.toLocaleString(), limit }: {
  items: readonly BarListItem[],
  color?: string,
  emptyLabel?: string,
  formatValue?: (value: number) => string,
  /** Show only the first N rows (items are expected pre-sorted). */
  limit?: number,
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return <p className="py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>;
  const max = Math.max(...items.map(item => item.value), 1);
  const visible = limit == null || expanded ? items : items.slice(0, limit);
  return (
    <div className="space-y-1">
      {visible.map(item => {
        const rowColor = item.color ?? color;
        const content = (
          <>
            <div
              aria-hidden="true"
              className="absolute inset-y-0 left-0 rounded-[5px]"
              style={{ width: `${Math.max(1.5, (item.value / max) * 100)}%`, backgroundColor: rowColor, opacity: 0.14 }}
            />
            <span className="relative min-w-0 flex-1 truncate text-left text-xs text-foreground">{item.label}</span>
            {item.detail != null && <span className="relative font-mono text-[11px] tabular-nums text-muted-foreground">{item.detail}</span>}
            <span className="relative w-14 text-right font-mono text-[11.5px] font-medium tabular-nums text-foreground">{formatValue(item.value)}</span>
          </>
        );
        const rowClasses = "relative flex h-7 w-full items-center gap-3 px-2";
        return item.onClick == null ? (
          <div key={item.key} title={item.title} className={rowClasses}>{content}</div>
        ) : (
          <button key={item.key} type="button" title={item.title} onClick={item.onClick} className={cn(rowClasses, "rounded-[5px] transition-colors hover:bg-muted hover:transition-none")}>
            {content}
          </button>
        );
      })}
      {limit != null && items.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded(previous => !previous)}
          className="px-2 pt-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground hover:transition-none"
        >
          {expanded ? "Show less" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

/** Part-of-whole bar with a legend underneath (eg. input vs output tokens). */
export function SegmentBar({ segments, formatValue = value => value.toLocaleString() }: {
  segments: ReadonlyArray<{ label: string, value: number, color: string }>,
  formatValue?: (value: number) => string,
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) return <p className="py-6 text-center text-xs text-muted-foreground">No data</p>;
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {segments.filter(segment => segment.value > 0).map(segment => (
          <div
            key={segment.label}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(segment.value / total) * 100}%`, backgroundColor: segment.color }}
            title={`${segment.label}: ${formatValue(segment.value)}`}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        {segments.map(segment => (
          <div key={segment.label} className="min-w-0">
            <LegendItem color={segment.color}>{segment.label}</LegendItem>
            <p className="mt-0.5 truncate font-mono text-[13px] font-medium tabular-nums text-foreground">
              {formatValue(segment.value)}
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{Math.round((segment.value / total) * 100)}%</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
