"use client";

import { cn } from "./cn";

/**
 * Bar fills for the hand-rolled charts. Each entry is tuned per theme: solid-ish in light mode,
 * slightly lighter hue in dark mode so bars keep contrast against the dark card surface.
 */
export const chartColors = {
  blue: "bg-blue-500/80 dark:bg-blue-400/80",
  cyan: "bg-cyan-500/80 dark:bg-cyan-400/80",
  emerald: "bg-emerald-500/80 dark:bg-emerald-400/80",
  green: "bg-green-500/80 dark:bg-green-400/80",
  amber: "bg-amber-500/80 dark:bg-amber-400/80",
  orange: "bg-orange-500/80 dark:bg-orange-400/80",
  red: "bg-red-500/80 dark:bg-red-400/80",
  purple: "bg-purple-500/80 dark:bg-purple-400/80",
  indigo: "bg-indigo-500/80 dark:bg-indigo-400/80",
  pink: "bg-pink-500/80 dark:bg-pink-400/80",
  neutral: "bg-foreground/25",
} as const;

export type ChartColor = keyof typeof chartColors;

/** Neutral track a horizontal bar is drawn on. */
export const chartTrackClass = "bg-foreground/[0.07]";

/** Horizontal "label — bar — value" row, used by every distribution list in the tool. */
export function BarRow({
  label,
  labelClassName,
  barClassName,
  pct,
  value,
  extra,
  title,
}: {
  label: React.ReactNode,
  labelClassName?: string,
  barClassName: string,
  pct: number,
  value: React.ReactNode,
  extra?: React.ReactNode,
  title?: string,
}) {
  return (
    <div className="flex items-center gap-2" title={title}>
      <span className={cn("truncate text-[11px] text-muted-foreground", labelClassName)}>{label}</span>
      <div className={cn("h-4 flex-1 overflow-hidden rounded-full", chartTrackClass)}>
        <div className={cn("h-full rounded-full", barClassName)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right font-mono text-[11px] tabular-nums text-foreground">{value}</span>
      {extra}
    </div>
  );
}

/** Legend swatch + caption pair shown under the stacked time-series charts. */
export function LegendItem({ colorClass, children }: { colorClass: string, children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[9px] text-muted-foreground">
      <span className={cn("inline-block h-2 w-2 rounded-sm", colorClass)} />
      {children}
    </span>
  );
}
