"use client";

import { cn } from "./cn";
import { Tooltip } from "./surfaces";

/** Shared class strings for the dense data tables (header row, body row, selected row). */
export const tableClasses = {
  headRow: "border-b border-black/[0.06] text-[10px] font-medium uppercase tracking-wider text-muted-foreground dark:border-white/[0.06]",
  bodyRow: cn(
    "border-b border-black/[0.04] dark:border-white/[0.04]",
    "cursor-pointer transition-colors hover:transition-none hover:bg-foreground/[0.04]",
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  ),
  selectedRow: "bg-foreground/[0.06]",
  cell: "py-2 pr-3 text-foreground",
  mutedCell: "py-2 pr-3 text-muted-foreground",
} as const;

/** Sortable `<th>`: click to toggle direction, optional hover explainer for the metric. */
export function SortHeader({
  children,
  align = "left",
  active,
  dir,
  onClick,
  tooltip,
  className,
}: {
  children: React.ReactNode,
  align?: "left" | "right",
  active: boolean,
  dir: "asc" | "desc",
  onClick: () => void,
  tooltip?: string,
  className?: string,
}) {
  return (
    <th className={cn("group relative px-3 py-2", align === "left" ? "text-left" : "text-right", className)}>
      <button
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:transition-none hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span>{children}</span>
        <span className="text-[8px]">{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
      {tooltip != null && <Tooltip align={align === "right" ? "right" : "left"} className="w-64">{tooltip}</Tooltip>}
    </th>
  );
}
