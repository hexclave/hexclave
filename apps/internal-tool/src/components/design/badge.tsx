"use client";

import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { cn } from "./cn";

/** Same palette as the dashboard's DesignBadge, plus a neutral tone for "unset"/"anon" tags. */
export type BadgeColor = "blue" | "cyan" | "purple" | "green" | "orange" | "red" | "neutral";

const badgeColorClasses = new Map<BadgeColor, string>([
  ["blue", "text-blue-700 dark:text-blue-400 bg-blue-500/20 dark:bg-blue-500/10 ring-1 ring-blue-500/30 dark:ring-blue-500/20"],
  ["cyan", "text-cyan-700 dark:text-cyan-400 bg-cyan-500/20 dark:bg-cyan-500/10 ring-1 ring-cyan-500/30 dark:ring-cyan-500/20"],
  ["purple", "text-purple-700 dark:text-purple-400 bg-purple-500/20 dark:bg-purple-500/10 ring-1 ring-purple-500/30 dark:ring-purple-500/20"],
  ["green", "text-emerald-700 dark:text-emerald-400 bg-emerald-500/20 dark:bg-emerald-500/10 ring-1 ring-emerald-500/30 dark:ring-emerald-500/20"],
  ["orange", "text-amber-700 dark:text-amber-300 bg-amber-500/20 dark:bg-amber-500/10 ring-1 ring-amber-500/30 dark:ring-amber-500/20"],
  ["red", "text-red-700 dark:text-red-400 bg-red-500/20 dark:bg-red-500/10 ring-1 ring-red-500/30 dark:ring-red-500/20"],
  ["neutral", "text-muted-foreground bg-foreground/[0.06] ring-1 ring-foreground/[0.08]"],
]);

export function Badge({
  children,
  color = "neutral",
  size = "sm",
  mono = false,
  className,
  title,
}: {
  children: React.ReactNode,
  color?: BadgeColor,
  size?: "xs" | "sm",
  mono?: boolean,
  className?: string,
  title?: string,
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full font-medium leading-none",
        size === "xs" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]",
        mono && "font-mono",
        badgeColorClasses.get(color) ?? throwErr(`No badge classes for color ${color}; badgeColorClasses must cover every BadgeColor`),
        className,
      )}
    >
      {children}
    </span>
  );
}
