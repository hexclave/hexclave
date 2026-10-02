"use client";

import { cn } from "@hexclave/ui";

export type DesignBadgeColor = "blue" | "cyan" | "purple" | "green" | "orange" | "red" | "zinc";
export type DesignBadgeSize = "sm" | "md";

const badgeStyles = new Map<DesignBadgeColor, string>([
  ["zinc", "text-zinc-600 dark:text-zinc-400 bg-zinc-500/20 dark:bg-zinc-500/10 ring-1 ring-zinc-500/30 dark:ring-zinc-500/20"],
  ["blue", "text-blue-700 dark:text-blue-400 bg-blue-500/20 dark:bg-blue-500/10 ring-1 ring-blue-500/30 dark:ring-blue-500/20"],
  ["cyan", "text-cyan-700 dark:text-cyan-400 bg-cyan-500/20 dark:bg-cyan-500/10 ring-1 ring-cyan-500/30 dark:ring-cyan-500/20"],
  ["purple", "text-purple-700 dark:text-purple-400 bg-purple-500/20 dark:bg-purple-500/10 ring-1 ring-purple-500/30 dark:ring-purple-500/20"],
  ["green", "text-emerald-700 dark:text-emerald-400 bg-emerald-500/20 dark:bg-emerald-500/10 ring-1 ring-emerald-500/30 dark:ring-emerald-500/20"],
  ["orange", "text-amber-700 dark:text-amber-300 bg-amber-500/20 dark:bg-amber-500/10 ring-1 ring-amber-500/30 dark:ring-amber-500/20"],
  ["red", "text-red-700 dark:text-red-400 bg-red-500/20 dark:bg-red-500/10 ring-1 ring-red-500/30 dark:ring-red-500/20"],
]);

function getMapValueOrThrow<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, mapName: string) {
  const value = map.get(key);
  if (!value) {
    throw new Error(`Missing ${mapName} entry for key "${String(key)}"`);
  }
  return value;
}

/** At least one of showLabel or showIcon must be true. */
export type DesignBadgeContentMode = "both" | "text" | "icon";

export type DesignBadgeProps = {
  label: string,
  color: DesignBadgeColor,
  icon?: React.ElementType,
  /** Extra classes merged onto the rendered icon, e.g. `animate-spin` for an in-progress status. */
  iconClassName?: string,
  size?: DesignBadgeSize,
  /** What to display: "both" (default), "text" (label only), or "icon" (icon only; requires icon prop). */
  contentMode?: DesignBadgeContentMode,
};

function getShowLabelShowIcon(
  contentMode: DesignBadgeContentMode,
  hasIcon: boolean,
): { showLabel: boolean, showIcon: boolean } {
  switch (contentMode) {
    case "both": {
      return { showLabel: true, showIcon: hasIcon };
    }
    case "text": {
      return { showLabel: true, showIcon: false };
    }
    case "icon": {
      if (!hasIcon) {
        throw new Error("DesignBadge contentMode 'icon' requires the icon prop to be provided.");
      }
      return { showLabel: false, showIcon: true };
    }
    default: {
      const _exhaustive: never = contentMode;
      throw new Error(`Unknown contentMode: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Small pill used for status tags, roles, categories, and other short
 * labels. Not a variant-based component — pick a semantic `color` and
 * optionally pass an `icon` (as a component type, not a rendered node).
 *
 * ```tsx
 * <DesignBadge label="Verified" color="green" icon={CheckIcon} />
 * <DesignBadge label="Beta" color="purple" />
 * <DesignBadge label="Error" color="red" size="sm" />
 * ```
 *
 * Notes:
 * - Props are `label` + `color`, NOT `variant` + children.
 * - `color` is one of: `"blue" | "cyan" | "purple" | "green" | "orange" | "red" | "zinc"`.
 * - `icon` is optional but, if set via `contentMode: "icon"`, is required.
 */
export function DesignBadge({
  label,
  color,
  icon,
  iconClassName,
  size = "md",
  contentMode = "both",
}: DesignBadgeProps) {
  const Icon = icon;
  const { showLabel, showIcon } = getShowLabelShowIcon(contentMode, !!Icon);
  if (!showLabel && !showIcon) {
    throw new Error("DesignBadge must show at least label or icon.");
  }
  const sizeClasses = size === "sm"
    ? "px-2 py-0.5 text-[10px]"
    : "px-2.5 py-1 text-[11px]";
  const colorClasses = getMapValueOrThrow(badgeStyles, color, "badgeStyles");

  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full font-medium leading-none",
        colorClasses,
        sizeClasses
      )}
      title={!showLabel ? label : undefined}
      aria-label={label}
    >
      {showIcon && Icon && <Icon className={cn("h-3 w-3", iconClassName)} />}
      {showLabel ? label : null}
    </div>
  );
}
