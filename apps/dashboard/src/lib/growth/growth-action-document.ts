import type { GrowthDocument, GrowthDocumentBlock } from "./growth-document";

export type GrowthActionNarrativeSections = {
  finding: GrowthDocumentBlock[],
  evidence: GrowthDocumentBlock[],
  recommendation: GrowthDocumentBlock[],
};

const EVIDENCE_COMPONENTS = new Set(["Evidence", "Metric", "TrendChart", "ComparisonChart", "BreakdownChart"]);

/**
 * Action documents are model-authored, but their information architecture is not. Only the three
 * supported narrative components reach the action page; headings and free-standing prose cannot
 * create new sections or change their order. Hypothesis and Experiment remain compatibility aliases
 * so documents saved before the semantic action-page contract keep rendering without a migration.
 */
export function getGrowthActionNarrativeSections(document: GrowthDocument): GrowthActionNarrativeSections {
  const sections: GrowthActionNarrativeSections = { finding: [], evidence: [], recommendation: [] };
  for (const block of document.blocks) {
    if (block.type !== "component") continue;
    if (block.name === "Finding" || block.name === "Hypothesis") {
      sections.finding.push(block);
    } else if (EVIDENCE_COMPONENTS.has(block.name)) {
      sections.evidence.push(block);
    } else if (block.name === "Recommendation" || block.name === "Experiment") {
      sections.recommendation.push(block);
    }
  }
  return sections;
}
