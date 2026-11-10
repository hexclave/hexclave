"use client";

import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { cn } from "./cn";

/**
 * Glassmorphic card matching the dashboard's DesignCard surface (translucent card background,
 * hairline border + ring, soft shadow), but with the tighter padding and uppercase micro-title an
 * internal tool wants.
 */
export function Card({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string,
  actions?: React.ReactNode,
  children: React.ReactNode,
  className?: string,
  bodyClassName?: string,
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-black/[0.06] bg-card shadow-sm ring-1 ring-black/[0.04] backdrop-blur-xl",
        "dark:border-white/[0.06] dark:ring-white/[0.04]",
        className,
      )}
    >
      {(title != null || actions != null) && (
        <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] px-4 py-2.5 dark:border-white/[0.06]">
          {title != null && (
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
          )}
          {actions}
        </div>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </div>
  );
}

/**
 * One glass surface split into hairline-separated regions. Overview pages use this instead of a
 * grid of separate Cards: a dozen floating boxes reads as noise, one sectioned report reads as a
 * single thing. Direct children are separated by horizontal hairlines.
 *
 * Deliberately not `overflow-hidden`: metric tooltips must be able to escape the panel. The
 * children have no background of their own, so nothing needs clipping to the rounded corners.
 */
export function Panel({ children, className }: { children: React.ReactNode, className?: string }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-black/[0.06] bg-card shadow-sm ring-1 ring-black/[0.04] backdrop-blur-xl",
        "divide-y divide-black/[0.06] dark:divide-white/[0.06] dark:border-white/[0.06] dark:ring-white/[0.04]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Titled region inside a Panel (or a PanelGrid cell). Same micro-title as Card, no chrome. */
export function PanelSection({
  title,
  actions,
  children,
  className,
}: {
  title?: string,
  actions?: React.ReactNode,
  children: React.ReactNode,
  className?: string,
}) {
  return (
    <section className={cn("min-w-0 p-4", className)}>
      {(title != null || actions != null) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title != null && (
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Wrapping row of controls inside a Panel — the building block of every filter toolbar in this
 * tool (search row, filter row, …). Push trailing status/actions right with `ml-auto`.
 */
export function PanelRow({ children, className }: { children: React.ReactNode, className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5", className)}>{children}</div>;
}

/**
 * Two-column grid of PanelSections, divided by hairlines (left border on the right column, top
 * border from the second row on). The surrounding Panel's `divide-y` supplies the outer top edge.
 */
export function PanelGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2",
        "[&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t",
        "[&>*]:border-black/[0.06] dark:[&>*]:border-white/[0.06]",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Column layouts for MetricStrip. Spelled out as full static strings (Tailwind can't see
 * interpolated class names), with the hairline pattern matching each breakpoint's wrap: vertical
 * rules between cells of a row, horizontal rules between rows.
 */
export type MetricStripLayout = "4" | "3-then-9";

const metricStripLayoutClasses = new Map<MetricStripLayout, string>([
  ["4", "grid-cols-4 [&>*:not(:first-child)]:border-l"],
  ["3-then-9", cn(
    "grid-cols-3 [&>*:not(:nth-child(3n+1))]:border-l [&>*:nth-child(n+4)]:border-t",
    "xl:grid-cols-9 xl:[&>*:nth-child(n+4)]:border-t-0 xl:[&>*:nth-child(3n+1):not(:first-child)]:border-l",
  )],
]);

/** Row of Metrics inside a Panel, separated by hairlines instead of each sitting in its own box. */
export function MetricStrip({ layout, children }: { layout: MetricStripLayout, children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid [&>*]:border-black/[0.06] dark:[&>*]:border-white/[0.06]",
        metricStripLayoutClasses.get(layout) ?? throwErr(`No metric strip classes for layout ${layout}; metricStripLayoutClasses must cover every MetricStripLayout`),
      )}
    >
      {children}
    </div>
  );
}

/**
 * KPI cell for a MetricStrip. `tooltip` renders the hover explainer; pass `tooltipAlign="right"`
 * on the last column so its tooltip opens inward instead of widening the page.
 */
export function Metric({
  label,
  value,
  valueClassName,
  subtitle,
  tooltip,
  tooltipAlign = "left",
}: {
  label: string,
  value: string,
  valueClassName?: string,
  subtitle?: string,
  tooltip?: string,
  tooltipAlign?: "left" | "right",
}) {
  return (
    <div className="group relative min-w-0 px-4 py-3 hover:z-20">
      <p className="mb-1 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("truncate text-xl font-semibold tabular-nums", valueClassName ?? "text-foreground")}>{value}</p>
      {subtitle != null && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{subtitle}</p>}
      {tooltip != null && <Tooltip align={tooltipAlign}>{tooltip}</Tooltip>}
    </div>
  );
}

/**
 * Hover explainer. Positioned absolutely under its (relatively positioned, `group`-classed) parent
 * and inert to pointer events so it never eats clicks on the element it describes.
 */
export function Tooltip({
  children,
  align = "left",
  className,
}: {
  children: React.ReactNode,
  align?: "left" | "right",
  className?: string,
}) {
  return (
    <div
      className={cn(
        "invisible pointer-events-none absolute top-full z-50 mt-1 w-72 rounded-md px-2.5 py-2 shadow-lg group-hover:visible",
        "border border-black/[0.06] bg-popover text-[11px] font-normal normal-case leading-snug text-popover-foreground",
        "dark:border-white/[0.08]",
        align === "right" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

export type AlertVariant = "error" | "warning" | "info" | "success";

const alertVariantClasses = new Map<AlertVariant, string>([
  ["error", "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"],
  ["warning", "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"],
  ["info", "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"],
  ["success", "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"],
]);

/** `md` is the standalone panel; `sm` is the compact strip used inside forms and cards. */
export type AlertSize = "sm" | "md";

const alertSizeClasses = new Map<AlertSize, string>([
  ["sm", "px-3 py-1.5 text-xs font-medium"],
  ["md", "p-4 text-sm"],
]);

/**
 * Inline status/error panel. Uses alerts (not toasts) per repo convention for blocking errors.
 * Padding and type size come from `size`, not `className` — `cn` does not merge Tailwind classes,
 * so a caller-supplied `p-3` would compete with the default instead of replacing it.
 */
export function Alert({
  variant = "error",
  size = "md",
  children,
  className,
}: {
  variant?: AlertVariant,
  size?: AlertSize,
  children: React.ReactNode,
  className?: string,
}) {
  const variantClasses = alertVariantClasses.get(variant)
    ?? throwErr(`No alert classes for variant ${variant}; alertVariantClasses must cover every AlertVariant`);
  const sizeClasses = alertSizeClasses.get(size)
    ?? throwErr(`No alert classes for size ${size}; alertSizeClasses must cover every AlertSize`);
  return (
    <div className={cn("rounded-xl border", sizeClasses, variantClasses, className)}>{children}</div>
  );
}

/** Placeholder for "nothing here yet" regions. */
export function EmptyState({ children, className }: { children: React.ReactNode, className?: string }) {
  return (
    <div className={cn("py-8 text-center text-sm text-muted-foreground", className)}>{children}</div>
  );
}
