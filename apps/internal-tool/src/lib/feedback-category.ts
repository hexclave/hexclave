import type { BadgeColor } from "../components/design";

const CATEGORY_COLORS = new Map<string, BadgeColor>([
  ["bug", "red"],
  ["docs-gap", "orange"],
  ["suggestion", "blue"],
  ["praise", "green"],
  ["other", "neutral"],
]);

export function feedbackCategoryColor(category: string): BadgeColor {
  return CATEGORY_COLORS.get(category) ?? "neutral";
}
