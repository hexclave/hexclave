import { GROWTH_DOCUMENT_UNITS } from "./growth-document";
import type { GrowthCategory, GrowthActionItem, GrowthOverviewFinding } from "./growth-types";

/**
 * The copyable prompts behind the "Copy prompt" buttons in the GTM admin workspace.
 *
 * Staff read what the agent found, decide how a customer should be told about it, and paste one of
 * these into an external model to get a first draft of the stage page. So the prompt has two jobs:
 * teach the model the exact `growth-mdx-v1` subset the backend compiler accepts (anything else is
 * rejected on save, which is a wasted round trip), and hand over the source material.
 *
 * What it deliberately leaves out is as important as what it includes: an action's `payload` and its
 * workflow `source` never appear. They are operational internals — a pasted prompt is the least
 * controlled place our data ever sits, and a customer-facing page has no use for either.
 */

const CATEGORY_LABELS: Record<GrowthCategory, string> = {
  product: "Product",
  reach: "Reach",
  conversion: "Conversion",
  retention: "Retention",
  revenue: "Revenue",
};

export function growthCategoryLabel(category: GrowthCategory): string {
  return CATEGORY_LABELS[category];
}

function formatBrief(options: { allowActionButtons: boolean }): string {
  return `You are writing a page that a customer of a growth product reads under one stage of their growth funnel. It replaces a raw list of AI findings, so it must read as a short, confident argument: what we saw, what it means, and what to do next.

Output format: a constrained MDX dialect called growth-mdx-v1. A strict compiler rejects anything else, so use ONLY:

- Markdown: "##" and "###" headings, paragraphs (max 360 characters each), ordered/unordered lists (max 7 items), GFM tables (max 8 rows), fenced code blocks, thematic breaks, bold/italic/strikethrough/inline code, and links with absolute http(s) or mailto URLs.
- Callout components, each wrapping its own paragraphs: <Evidence>, <Hypothesis>, <Experiment>, <DataGap>. Only <Hypothesis> may take confidence="low|medium|high"; the other callouts take no attributes.
- Data components, self-closing and referencing a data id: <Metric data="id" />, <TrendChart data="id" />, <ComparisonChart data="id" />, <BreakdownChart data="id" />.
${options.allowActionButtons
    ? '- Action buttons: <ActionButton action="ACTION_ID" />, self-closing, using an action id given below. This renders the real action with its live status and its activate/dismiss controls.'
    : '- Do not use <ActionButton> on this action-detail page; its live action controls are rendered separately by the product.'}

No raw HTML, no JSX other than the components above, no imports, no expressions, no attributes other than the ones listed.

Return exactly two things:

1. A fenced "mdx" block with the page body.
2. A fenced "json" block with the evidence data array the data components reference: a JSON array of objects with "id", "kind" ("metric" | "time_series" | "comparison" | "breakdown"), "title", "unit" (${GROWTH_DOCUMENT_UNITS.join(" | ")}), "source", "takeaway", optional "timezone", "currency" (required, three-letter ISO, when unit is "minor_units"), plus "value" (+ optional "comparison_label" and "comparison_value") for a metric, "series" of {label, points:[{label, value}]} for a time series, or "items" of {label, value} for a comparison or breakdown. Use [] if the page references no data components. Never invent numbers: only use figures that appear in the material below.

Write for the customer, not for us: no mention of AI, agents, findings, notes, or internal tooling.`;
}

function formatActionBrief(): string {
  return `Write a short decision page for a busy product owner. Use simple English and only the facts below.

Output format: the constrained MDX dialect growth-mdx-v1. Return exactly:

1. One fenced "mdx" block using this exact order:
   - One <Finding>...</Finding> with one sentence describing what the evidence shows.
   - One to four <Evidence data="id">...</Evidence> blocks. Each block must reference supplied evidence data.
   - One <Recommendation>...</Recommendation> with one short recommendation followed by at most four short steps.
   - One self-closing <MeasurementPlan />. The product fills this section from the action's live tracked metrics.
2. One fenced "json" block containing the evidence data array.

Evidence data is a JSON array of objects with "id", "kind" ("metric" | "time_series" | "comparison" | "breakdown"), "title", "unit" (${GROWTH_DOCUMENT_UNITS.join(" | ")}), "source", "takeaway", optional "timezone", "currency" (required, three-letter ISO, when unit is "minor_units"), plus "value" (+ optional "comparison_label" and "comparison_value") for a metric, "series" of {label, points:[{label, value}]} for a time series, or "items" of {label, value} for a comparison or breakdown.

Writing rules:
- One idea per sentence. Keep each sentence under 18 words.
- Do not use: hypothesis, cohort, attributed, incumbent, compounding, directional, or guardrail.
- Never invent a number, date, target, source, or cause.
- Every number must come from the supplied material and reference matching evidence data.
- Keep observed facts separate from recommendations.
- If facts conflict, do not hide the conflict. State it in the relevant Evidence block.
- Use exact metric scope. Visits to one page and all search visits are different metrics.
- Do not write metric targets or tracking windows in prose; <MeasurementPlan /> uses live action data.
- No headings, free-standing prose, HTML, imports, expressions, action buttons, charts, or other components.

Today is ${formatDate(new Date().getTime())}. Treat past deadlines as past. Write for the customer; never mention AI, agents, internal tooling, or this prompt.`;
}

function bulletList(label: string, values: string[]): string[] {
  if (values.length === 0) return [];
  return [`${label}: ${values.join(", ")}`];
}

function formatDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

function appendExistingDocument(lines: string[], document: GrowthOverviewFinding["document"] | GrowthActionItem["document"]): void {
  if (document == null) return;
  lines.push("  Existing narrative (growth-mdx-v1, may be reused):");
  for (const line of document.sourceMdx.split("\n")) lines.push(`    ${line}`);
  lines.push("  Existing evidence data JSON (may be reused; do not alter values without source material):");
  for (const line of JSON.stringify(document.data, null, 2).split("\n")) lines.push(`    ${line}`);
}

/**
 * The safe, customer-relevant view of an action. `payload` and `workflow.source` are absent by
 * construction — see the file comment.
 */
function actionLines(action: GrowthActionItem, options: { includeActionButtonHint?: boolean } = {}): string[] {
  const lines = [
    `- Action id: ${action.id}${options.includeActionButtonHint === false ? "" : `  (use as <ActionButton action="${action.id}" />)`}`,
    `  Title: ${action.title}`,
    `  Type: ${action.typeId}`,
    `  Status: ${action.status}`,
    `  Proposed: ${formatDate(action.createdAtMillis)}`,
    `  Description: ${action.description}`,
  ];
  for (const line of bulletList("  Tags", action.tags)) lines.push(line);
  if (action.watchedMetrics.length > 0) {
    lines.push(`  Watched metrics: ${action.watchedMetrics.map((metric) => `${metric.metricId} over ${metric.windowDays} days`).join(", ")}`);
  }
  if (action.workflow != null) {
    lines.push(`  Automation: ${action.workflow.explanation}`);
    lines.push(`  Undoing the automation: ${action.workflow.rollbackNote}`);
  }
  appendExistingDocument(lines, action.document);
  return lines;
}

function findingLines(finding: GrowthOverviewFinding, noun: "Finding" | "Note"): string[] {
  const lines = [
    `- ${noun} id: ${finding.id}`,
    `  Title: ${finding.title}`,
    `  Source: ${finding.source} (${finding.kind})`,
    `  Recorded: ${formatDate(finding.createdAtMillis)}`,
    `  Body: ${finding.body}`,
  ];
  for (const line of bulletList("  Tags", finding.tags)) lines.push(line);
  appendExistingDocument(lines, finding.document);
  return lines;
}

/**
 * The prompt for a single item — the per-row "Copy prompt" button. Useful when one finding carries
 * the whole story for a stage and the rest is noise.
 */
export function buildGrowthItemPagePrompt(input:
  | { kind: "finding" | "note", category: GrowthCategory, finding: GrowthOverviewFinding }
  | { kind: "action", category: GrowthCategory, action: GrowthActionItem },
): string {
  const sections = [
    formatBrief({ allowActionButtons: true }),
    `Stage: ${growthCategoryLabel(input.category)}`,
    input.kind === "action"
      ? ["Material — one suggested action:", ...actionLines(input.action)].join("\n")
      : ["Material — one observation:", ...findingLines(input.finding, input.kind === "note" ? "Note" : "Finding")].join("\n"),
  ];
  return sections.join("\n\n");
}

/** The individual evidence/note page has no action controls, so it cannot reference actions. */
export function buildGrowthFindingPagePrompt(finding: GrowthOverviewFinding): string {
  const category = finding.category;
  return [
    formatBrief({ allowActionButtons: false }),
    category == null ? "Stage: Unclassified" : `Stage: ${growthCategoryLabel(category)}`,
    ["Material — the observation this page explains:", ...findingLines(finding, finding.kind === "note" ? "Note" : "Finding")].join("\n"),
  ].join("\n\n");
}

/** The action-detail variant omits ActionButton because the page already owns the action controls. */
export function buildGrowthActionPagePrompt(action: GrowthActionItem): string {
  return [
    formatActionBrief(),
    action.category == null ? "Stage: Unclassified" : `Stage: ${growthCategoryLabel(action.category)}`,
    ["Material — the action this page explains:", ...actionLines(action, { includeActionButtonHint: false })].join("\n"),
  ].join("\n\n");
}

/**
 * The prompt for a whole stage — everything the agent has on it, plus the stage score. This is the
 * one staff use to compose the page; the per-item prompts exist for the narrow cases.
 */
export function buildGrowthCategoryPagePrompt(input: {
  category: GrowthCategory,
  score: number | null,
  findings: GrowthOverviewFinding[],
  notes: GrowthOverviewFinding[],
  actions: GrowthActionItem[],
}): string {
  const material: string[] = [];
  if (input.findings.length > 0) {
    material.push("Observations from analysis:");
    for (const finding of input.findings) material.push(...findingLines(finding, "Finding"));
  }
  if (input.notes.length > 0) {
    material.push("Notes:");
    for (const note of input.notes) material.push(...findingLines(note, "Note"));
  }
  if (input.actions.length > 0) {
    material.push("Suggested actions (only these ids may be used in <ActionButton>):");
    for (const action of input.actions) material.push(...actionLines(action));
  }
  if (material.length === 0) material.push("No material has been recorded for this stage yet.");

  return [
    formatBrief({ allowActionButtons: true }),
    `Stage: ${growthCategoryLabel(input.category)}${input.score == null ? "" : ` (current stage score: ${input.score}/100)`}`,
    material.join("\n"),
  ].join("\n\n");
}
