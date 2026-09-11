"use client";

import { DesignBadge } from "@/components/design-components";
import { cn } from "@/lib/utils";
import type { TransactionSummary } from "./transaction-actions";

const TONE_ICON_CLASS = new Map<TransactionSummary["displayType"]["tone"], { bg: string, fg: string }>([
  ["blue", { bg: "bg-blue-500/10 dark:bg-blue-400/15", fg: "text-blue-600 dark:text-blue-400" }],
  ["cyan", { bg: "bg-cyan-500/10 dark:bg-cyan-400/15", fg: "text-cyan-600 dark:text-cyan-400" }],
  ["purple", { bg: "bg-purple-500/10 dark:bg-purple-400/15", fg: "text-purple-600 dark:text-purple-400" }],
  ["green", { bg: "bg-emerald-500/10 dark:bg-emerald-400/15", fg: "text-emerald-600 dark:text-emerald-400" }],
  ["orange", { bg: "bg-orange-500/10 dark:bg-orange-400/15", fg: "text-orange-600 dark:text-orange-400" }],
  ["red", { bg: "bg-red-500/10 dark:bg-red-400/15", fg: "text-red-600 dark:text-red-400" }],
]);

function typeToneClass(tone: TransactionSummary["displayType"]["tone"]) {
  return TONE_ICON_CLASS.get(tone) ?? TONE_ICON_CLASS.get("purple") ?? { bg: "", fg: "" };
}

function StatusBadge(props: { status: TransactionSummary["status"] }) {
  if (props.status == null) {
    return null;
  }
  return <DesignBadge label={props.status.label} color={props.status.color} size="sm" />;
}

/**
 * Type + what happened, in one cell. Status (Test / Refunded / Canceled)
 * lives here so the table doesn't spend a column on "—" for most rows.
 */
export function TransactionEventCell(props: { summary: TransactionSummary }) {
  const { Icon, label, tone } = props.summary.displayType;
  const toneClass = typeToneClass(tone);
  const detail = props.summary.detail;
  const showDetail = detail !== "—" && detail !== label;

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", toneClass.bg)}>
        <Icon className={cn("h-4 w-4", toneClass.fg)} aria-hidden />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
          <StatusBadge status={props.summary.status} />
        </div>
        {showDetail ? (
          <div className="truncate text-xs text-muted-foreground">{detail}</div>
        ) : null}
      </div>
    </div>
  );
}

export function TransactionAmountCell(props: {
  summary: TransactionSummary,
  size?: "sm" | "md",
}) {
  const sizeClass = props.size === "md" ? "text-base" : "text-sm";
  if (props.summary.amountTone === "empty") {
    return <span className={cn(sizeClass, "tabular-nums text-muted-foreground")}>{props.summary.amountDisplay}</span>;
  }
  return (
    <span
      className={cn(
        sizeClass,
        "font-medium tabular-nums",
        props.summary.amountTone === "outflow"
          ? "text-red-600 dark:text-red-400"
          : "text-foreground",
      )}
    >
      {props.summary.amountDisplay}
    </span>
  );
}
