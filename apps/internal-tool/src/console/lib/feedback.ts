import type { Tone } from "../ui/primitives";

/**
 * Badge tone per `give_feedback` category. Categories come from the MCP tool, so unknown ones fall
 * back to neutral rather than failing (the console must keep rendering new categories).
 */
const CATEGORY_TONES = new Map<string, Tone>([
  ["bug", "red"],
  ["docs-gap", "amber"],
  ["suggestion", "blue"],
  ["praise", "green"],
  ["other", "neutral"],
]);

export function feedbackTone(category: string): Tone {
  return CATEGORY_TONES.get(category) ?? "neutral";
}
