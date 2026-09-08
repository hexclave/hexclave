export type GrowthPageResponse = {
  sourceMdx: string,
  evidenceDataJson: string,
};

const FENCED_BLOCK_PATTERN = /```([^\r\n`]*)\r?\n([\s\S]*?)\r?\n```/g;

/**
 * Extracts the two fenced blocks requested by the copyable stage-page prompt. Returning null keeps
 * ordinary MDX pastes untouched; once either expected fence is present, a partial or ambiguous
 * response fails loudly instead of saving explanatory prose as customer-visible content.
 */
export function parseGrowthPageResponse(value: string): GrowthPageResponse | null {
  let sourceMdx: string | null = null;
  let evidenceDataJson: string | null = null;
  for (const match of value.matchAll(FENCED_BLOCK_PATTERN)) {
    const language = match[1].trim().toLowerCase();
    const body = match[2].trim();
    if (language === "mdx") {
      if (sourceMdx != null) throw new Error("The model response contains more than one fenced mdx block.");
      sourceMdx = body;
    }
    if (language === "json") {
      if (evidenceDataJson != null) throw new Error("The model response contains more than one fenced json block.");
      evidenceDataJson = body;
    }
  }
  if (sourceMdx == null && evidenceDataJson == null) return null;
  if (sourceMdx == null) throw new Error("The model response is missing its fenced mdx block.");
  if (evidenceDataJson == null) throw new Error("The model response is missing its fenced json block.");

  const evidence = JSON.parse(evidenceDataJson);
  if (!Array.isArray(evidence)) throw new Error("The model response's evidence data must be a JSON array.");
  return { sourceMdx, evidenceDataJson: JSON.stringify(evidence, null, 2) };
}
