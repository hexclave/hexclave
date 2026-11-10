"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "../../components/design/cn";
import type { ConnectionState } from "../data/console-data";
import { Sparkline } from "./charts";
import { Icon } from "./icons";
import { HoverCard } from "./overlays";
import { Callout, Card, Skeleton } from "./primitives";

export type ValueTone = "default" | "good" | "warn" | "bad" | "muted";

const valueToneClasses = new Map<ValueTone, string>([
  ["default", "text-foreground"],
  ["good", "text-emerald-600 dark:text-emerald-400"],
  ["warn", "text-amber-600 dark:text-amber-400"],
  ["bad", "text-red-600 dark:text-red-400"],
  ["muted", "text-muted-foreground"],
]);

/**
 * KPI tile: label, headline value, a one-line context, and optionally a sparkline + trend. The
 * `info` explainer opens on hover/focus of the label's info icon, so definitions stay one hover
 * away without cluttering the grid. With `href` the whole tile is a link (eg. into a queue).
 */
export function KpiCard({ label, value, tone = "default", context, info, spark, sparkColor, trend, trendGoodWhen = "up", href }: {
  label: string,
  value: string,
  tone?: ValueTone,
  context?: ReactNode,
  info?: string,
  spark?: readonly number[],
  sparkColor?: string,
  /** Percent change between the halves of `spark`'s window. */
  trend?: number | null,
  trendGoodWhen?: "up" | "down" | "neutral",
  href?: string,
}) {
  const trendClass = trend == null || trend === 0 || trendGoodWhen === "neutral"
    ? "text-muted-foreground"
    : (trend > 0) === (trendGoodWhen === "up") ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {info != null && (
          <span className="group relative inline-flex" tabIndex={0} aria-label={`About ${label}`}>
            <span className="grid size-3.5 place-items-center rounded-full border border-border text-[9px] font-semibold text-muted-foreground">i</span>
            <HoverCard>{info}</HoverCard>
          </span>
        )}
        {href != null && <Icon name="arrowRight" size="xs" className="ml-auto text-muted-foreground opacity-0 group-hover/kpi:opacity-100" />}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("truncate text-[26px] font-semibold leading-none tracking-tight tabular-nums", valueToneClasses.get(tone))}>{value}</p>
          <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {trend != null && (
              <span className={cn("font-medium tabular-nums", trendClass)}>{trend > 0 ? "↑" : trend < 0 ? "↓" : "→"} {Math.abs(trend)}%</span>
            )}
            {context != null && <span className="truncate">{context}</span>}
          </div>
        </div>
        {spark != null && <Sparkline values={spark} color={sparkColor} className="h-9 w-24 shrink-0" />}
      </div>
    </>
  );
  const classes = "group/kpi relative block rounded-xl border border-border bg-card p-4 shadow-[0_1px_2px_hsl(var(--foreground)/0.04)] hover:z-10";
  return href == null
    ? <div className={classes}>{body}</div>
    : <Link href={href} className={cn(classes, "transition-colors hover:border-foreground/20 hover:transition-none")}>{body}</Link>;
}

/** Shown in place of a page's content until its subscription has data, or when it failed. */
export function ConnectionGate({ state, errorMessage, hasRows, source, children }: {
  state: ConnectionState,
  errorMessage: string | null,
  hasRows: boolean,
  source: string,
  children: ReactNode,
}) {
  if (state === "error") {
    return (
      <>
        <Callout title={`Can't reach SpacetimeDB for ${source}`}>
          <p>Verify the <code className="font-mono">hexclave-ai-analytics</code> module is published and the SpacetimeDB container is reachable. The connection keeps retrying in the background.</p>
          {errorMessage != null && errorMessage !== "" && (
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-red-500/10 p-2 font-mono text-[11px]">{errorMessage}</pre>
          )}
        </Callout>
        {hasRows && children}
      </>
    );
  }
  if (state === "connecting" && !hasRows) return <LoadingSkeleton />;
  return <>{children}</>;
}

export function LoadingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-[104px]" />)}
      </div>
      <Card>
        <div className="space-y-3 p-4">
          <Skeleton className="h-4 w-40" />
          {[0, 1, 2, 3, 4, 5].map(index => <Skeleton key={index} className="h-8" />)}
        </div>
      </Card>
    </div>
  );
}

/** Horizontal strip that holds a page's filters, with a right-aligned summary + actions slot. */
export function FilterBar({ children, summary, actions }: { children: ReactNode, summary?: ReactNode, actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Icon name="filter" size="sm" className="mr-0.5 text-muted-foreground" />
      {children}
      <div className="ml-auto flex items-center gap-2">
        {summary != null && <span className="text-xs tabular-nums text-muted-foreground">{summary}</span>}
        {actions}
      </div>
    </div>
  );
}
