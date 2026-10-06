"use client";

import { DesignBadge, type DesignBadgeColor } from "@/components/design-components";


const LEVEL_BADGE_COLORS = new Map<string, DesignBadgeColor>([
  ["trace", "zinc"],
  ["debug", "zinc"],
  ["info", "blue"],
  ["warn", "orange"],
  ["error", "red"],
  ["fatal", "red"],
]);

export function logLevelBadgeColor(level: string): DesignBadgeColor {
  return LEVEL_BADGE_COLORS.get(level) ?? "zinc";
}

export function LogLevelChip({ level }: { level: string }) {
  return (
    <DesignBadge
      label={level === "" ? "—" : level.toUpperCase()}
      color={logLevelBadgeColor(level)}
      size="sm"
    />
  );
}
