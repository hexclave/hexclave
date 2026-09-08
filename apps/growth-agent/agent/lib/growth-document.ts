import { z } from "zod";

export const GROWTH_DOCUMENT_AUTHORING_GUIDE = `Use constrained Growth MDX. Put every Growth component and its opening/closing tags on their own lines, with blank lines around the content. Use data="id", never data-id. Keep paragraphs under 360 characters and lists under 8 items. Allowed headings are ## and ###. Allowed components are <Metric data="id" />, <TrendChart data="id" />, <ComparisonChart data="id" />, <BreakdownChart data="id" />, <Evidence data="id">...</Evidence>, <Hypothesis confidence="low|medium|high">...</Hypothesis>, <Experiment>...</Experiment>, <DataGap>...</DataGap>, <Finding>...</Finding>, <Recommendation>...</Recommendation>, and <MeasurementPlan />. Every chart or metric must reference a matching data item with a source and one-sentence takeaway. Evidence with unit minor_units must include its three-letter currency; other units must omit currency. No HTML, imports, exports, JavaScript expressions, images, or arbitrary components. Prefer a scan-friendly sequence: evidence, hypothesis, experiment, success metric, and action.`;

export const GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE = `Write a short decision page in simple English. Use exactly this Growth MDX structure, in this order, with every tag on its own line: one <Finding>...</Finding>, one to four <Evidence data="id">...</Evidence> blocks, one <Recommendation>...</Recommendation>, then one self-closing <MeasurementPlan />. Finding is one sentence describing only what the evidence shows. Each Evidence gives one decision-relevant fact with its population or sample, time window, comparison or baseline, named source, and material limitation. Recommendation starts with one short action and may add at most four short steps. MeasurementPlan has no text or attributes because the dashboard fills it from the action's live watched metrics. Use one idea per sentence and keep each sentence under 18 words. Never invent a number, date, target, source, or cause. Never use hypothesis, cohort, attributed, incumbent, compounding, directional, or guardrail in customer copy. Use data="id", never data-id. Do not add headings, charts, standalone paragraphs, or other components. Every Evidence block must reference matching data. The dashboard owns labels, layout, metrics, status, and controls; you write only editable decision copy.`;

type GrowthComponentName = "Metric" | "TrendChart" | "ComparisonChart" | "BreakdownChart" | "Evidence" | "Hypothesis" | "Experiment" | "DataGap" | "Finding" | "Recommendation" | "MeasurementPlan";

const GROWTH_COMPONENT_NAMES: readonly GrowthComponentName[] = [
  "Metric",
  "TrendChart",
  "ComparisonChart",
  "BreakdownChart",
  "Evidence",
  "Hypothesis",
  "Experiment",
  "DataGap",
  "Finding",
  "Recommendation",
  "MeasurementPlan",
];

const SELF_CLOSING_COMPONENTS: readonly GrowthComponentName[] = ["Metric", "TrendChart", "ComparisonChart", "BreakdownChart", "MeasurementPlan"];
const COMPONENT_TAG_PATTERN = /<\/?([A-Z][A-Za-z0-9]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/?>/g;
const ATTRIBUTE_PATTERN = /\s+([A-Za-z][A-Za-z0-9-]*)(?:=(?:"([^"]*)"|'([^']*)'))?/g;

function findGrowthComponentName(value: string): GrowthComponentName | undefined {
  return GROWTH_COMPONENT_NAMES.find((name) => name === value);
}

function isSelfClosingComponent(name: GrowthComponentName): boolean {
  return SELF_CLOSING_COMPONENTS.some((candidate) => candidate === name);
}

function addMdxIssue(ctx: z.RefinementCtx, message: string): void {
  ctx.addIssue({ code: "custom", message: `Invalid Growth MDX: ${message}` });
}

// RegExp capture groups are typed as strings even though unmatched alternatives
// are undefined at runtime. Keep that runtime fact explicit instead of relying
// on a non-null assertion when accepting either single- or double-quoted values.
function firstDefinedCapture(first: string | undefined, second: string | undefined): string | undefined {
  if (first !== undefined) return first;
  return second;
}

function maskMarkdownCode(sourceMdx: string): string {
  return sourceMdx.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, (code) => code.replace(/[^\n]/g, " "));
}

function validateParagraphLengths(sourceMdx: string, ctx: z.RefinementCtx): void {
  // Component tags are block boundaries, not paragraph content. Masking them before splitting
  // also makes paragraphs inside Evidence/Hypothesis/Experiment bodies subject to the same limit
  // as top-level paragraphs, matching the backend compiler's recursive MDX conversion.
  const paragraphSource = sourceMdx.replace(COMPONENT_TAG_PATTERN, "\n");
  const blocks = paragraphSource.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0 || lines.some((line) => /^<\/?[A-Z]/.test(line))) continue;
    if (lines.every((line) => /^(#{1,6}\s|[-*+]\s|\d+\.\s|\||```|~~~|---$)/.test(line))) continue;
    const paragraph = lines.join(" ")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`]/g, "");
    if (paragraph.length > 360) {
      addMdxIssue(ctx, `paragraphs must be at most 360 characters; found ${paragraph.length}. Split the paragraph with a blank line.`);
    }
  }
}

function validateListLengths(sourceMdx: string, ctx: z.RefinementCtx): void {
  const lines = sourceMdx.split("\n");
  const lists: { indent: number, itemCount: number }[] = [];

  const finishList = () => {
    const list = lists.pop();
    if (list != null && list.itemCount > 7) addMdxIssue(ctx, `lists must have at most 7 items; found ${list.itemCount}.`);
  };

  for (const line of lines) {
    const item = /^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/.exec(line);
    if (item != null) {
      const indent = item[1].replace(/\t/g, "    ").length;
      let currentList = lists.at(-1);
      while (currentList != null && indent < currentList.indent) {
        finishList();
        currentList = lists.at(-1);
      }
      if (currentList == null || indent > currentList.indent) lists.push({ indent, itemCount: 1 });
      else currentList.itemCount += 1;
      continue;
    }

    if (line.trim().length === 0) continue;
    const indent = line.search(/\S|$/);
    let currentList = lists.at(-1);
    while (currentList != null && indent <= currentList.indent) {
      finishList();
      currentList = lists.at(-1);
    }
  }
  while (lists.length > 0) finishList();
}

function validateGrowthMdx(sourceMdx: string, ctx: z.RefinementCtx): void {
  // Code samples are valid document blocks and their contents are not MDX.
  // Preserve their byte/line positions while masking the characters so every
  // syntax check below reasons only about actual document markup.
  const syntaxSource = maskMarkdownCode(sourceMdx);
  if (/\bdata-id\s*=/.test(syntaxSource)) {
    addMdxIssue(ctx, "Growth components use the data attribute, not data-id. Write data=\"id\".");
  }
  if (/(^|\n)\s*(?:import|export)\s/m.test(syntaxSource)) addMdxIssue(ctx, "imports and exports are not allowed.");
  if (/[{}]/.test(syntaxSource)) addMdxIssue(ctx, "JavaScript expressions are not allowed.");
  if (/!\[[^\]]*\]\([^)]*\)/.test(syntaxSource)) addMdxIssue(ctx, "images are not supported; use evidence components instead.");

  for (const heading of syntaxSource.matchAll(/^(#{1,6})\s+/gm)) {
    const marker = heading[1];
    if (marker !== "##" && marker !== "###") addMdxIssue(ctx, "only level 2 (##) and level 3 (###) headings are allowed.");
  }

  const stack: GrowthComponentName[] = [];
  const matchedTagStarts = new Set<number>();
  for (const match of syntaxSource.matchAll(COMPONENT_TAG_PATTERN)) {
    const fullTag = match[0];
    const rawName = match[1];
    const index = match.index;
    matchedTagStarts.add(index);
    const name = findGrowthComponentName(rawName);
    if (name === undefined) {
      addMdxIssue(ctx, `component ${rawName} is not allowed.`);
      continue;
    }

    const lineStart = syntaxSource.lastIndexOf("\n", index - 1) + 1;
    const nextLineBreak = syntaxSource.indexOf("\n", index + fullTag.length);
    const lineEnd = nextLineBreak === -1 ? syntaxSource.length : nextLineBreak;
    const beforeTag = syntaxSource.slice(lineStart, index).trim();
    const afterTag = syntaxSource.slice(index + fullTag.length, lineEnd).trim();
    if (beforeTag.length > 0 || afterTag.length > 0) {
      addMdxIssue(ctx, `${name} must be a block-level component with its tag on its own line.`);
    }

    const isClosing = fullTag.startsWith("</");
    const isSelfClosing = /\/\s*>$/.test(fullTag);
    if (isClosing) {
      const openName = stack.pop();
      if (openName !== name) addMdxIssue(ctx, `${name} has no matching opening tag in the correct order.`);
      continue;
    }

    const attributes = new Map<string, string | null>();
    const attributeSource = fullTag
      .replace(new RegExp(`^<${name}\\b`), "")
      .replace(/\/?>$/, "");
    for (const attributeMatch of attributeSource.matchAll(ATTRIBUTE_PATTERN)) {
      const attributeName = attributeMatch[1];
      const capturedValue = firstDefinedCapture(attributeMatch[2], attributeMatch[3]);
      const attributeValue = capturedValue === undefined ? null : capturedValue;
      if (attributes.has(attributeName)) addMdxIssue(ctx, `${name} repeats the ${attributeName} attribute.`);
      attributes.set(attributeName, attributeValue);
    }
    const unparsedAttributes = attributeSource.replace(ATTRIBUTE_PATTERN, "").trim();
    if (unparsedAttributes.length > 0) addMdxIssue(ctx, `${name} contains malformed attributes.`);

    const allowedAttributes = name === "Hypothesis" ? ["confidence"] : name === "Evidence" || (isSelfClosingComponent(name) && name !== "MeasurementPlan") ? ["data"] : [];
    for (const attributeName of attributes.keys()) {
      if (!allowedAttributes.includes(attributeName)) addMdxIssue(ctx, `${name} does not support the ${attributeName} attribute.`);
    }
    if (isSelfClosingComponent(name)) {
      const dataId = attributes.get("data");
      if (name !== "MeasurementPlan" && (dataId == null || dataId.length === 0)) addMdxIssue(ctx, `${name} requires a non-empty data attribute.`);
      if (!isSelfClosing) addMdxIssue(ctx, `${name} must be self-closing.`);
    }
    if (name === "Hypothesis") {
      const confidence = attributes.get("confidence");
      if (confidence != null && confidence !== "low" && confidence !== "medium" && confidence !== "high") {
        addMdxIssue(ctx, "Hypothesis confidence must be low, medium, or high.");
      }
    }
    if (!isSelfClosing && !isSelfClosingComponent(name)) stack.push(name);
  }

  for (const marker of syntaxSource.matchAll(/<\/?([A-Z][A-Za-z0-9]*)\b/g)) {
    if (!matchedTagStarts.has(marker.index)) addMdxIssue(ctx, `${marker[1]} has malformed or unterminated MDX syntax.`);
  }
  for (const unclosed of stack.reverse()) addMdxIssue(ctx, `${unclosed} is missing its closing tag.`);

  validateParagraphLengths(syntaxSource, ctx);
  validateListLengths(syntaxSource, ctx);
}

const evidenceBase = {
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  unit: z.enum(["count", "cents", "percent", "seconds", "minor_units"]),
  source: z.string().min(1).max(500),
  takeaway: z.string().min(1).max(360),
  timezone: z.string().min(1).max(100).optional(),
  currency: z.string().length(3).optional(),
};

const pointSchema = z.object({
  label: z.string().min(1).max(100),
  value: z.number().finite(),
});

const evidenceDatumSchema = z.discriminatedUnion("kind", [
  z.object({
    ...evidenceBase,
    kind: z.literal("metric"),
    value: z.number().finite(),
    comparison_label: z.string().min(1).max(100).optional(),
    comparison_value: z.number().finite().optional(),
  }),
  z.object({
    ...evidenceBase,
    kind: z.literal("time_series"),
    series: z.array(z.object({
      label: z.string().min(1).max(100),
      points: z.array(pointSchema).min(1).max(90),
    })).min(1).max(3),
  }),
  z.object({ ...evidenceBase, kind: z.literal("comparison"), items: z.array(pointSchema).min(1).max(8) }),
  z.object({ ...evidenceBase, kind: z.literal("breakdown"), items: z.array(pointSchema).min(1).max(8) }),
]);

/**
 * Model-facing source document. The backend compiles this restricted MDX to a safe render tree;
 * models never send JSX AST or executable code, which keeps the tool schema provider-friendly.
 */
export const growthDocumentInputSchema = z.object({
  format: z.literal("growth-mdx-v1"),
  source_mdx: z.string().min(1).max(100_000)
    .describe(GROWTH_DOCUMENT_AUTHORING_GUIDE)
    .superRefine(validateGrowthMdx),
  data: z.array(evidenceDatumSchema).max(40),
}).superRefine((document, ctx) => {
  const byId = new Map<string, typeof document.data[number]>();
  for (const datum of document.data) {
    if (byId.has(datum.id)) ctx.addIssue({ code: "custom", message: `Invalid Growth data: id ${JSON.stringify(datum.id)} is duplicated.` });
    byId.set(datum.id, datum);
    if (datum.unit === "minor_units" && datum.currency == null) {
      ctx.addIssue({ code: "custom", message: `Invalid Growth data: ${datum.id} requires a three-letter currency because its unit is minor_units.` });
    }
    if (datum.unit !== "minor_units" && datum.currency != null) {
      ctx.addIssue({ code: "custom", message: `Invalid Growth data: ${datum.id} must omit currency unless its unit is minor_units.` });
    }
    if (datum.kind === "metric" && ((datum.comparison_label == null) !== (datum.comparison_value == null))) {
      ctx.addIssue({ code: "custom", message: `Invalid Growth data: ${datum.id} must provide comparison_label and comparison_value together.` });
    }
  }

  const expectedKinds = new Map<string, "metric" | "time_series" | "comparison" | "breakdown">([
    ["Metric", "metric"],
    ["TrendChart", "time_series"],
    ["ComparisonChart", "comparison"],
    ["BreakdownChart", "breakdown"],
  ]);
  for (const match of document.source_mdx.matchAll(/<(Metric|TrendChart|ComparisonChart|BreakdownChart)\b[^>]*\bdata=(?:"([^"]+)"|'([^']+)')[^>]*\/\s*>/g)) {
    const componentName = match[1];
    const dataId = firstDefinedCapture(match[2], match[3]);
    if (dataId === undefined) {
      ctx.addIssue({ code: "custom", message: `Invalid Growth data: ${componentName} has no readable data id.` });
      continue;
    }
    const datum = byId.get(dataId);
    if (datum === undefined) {
      ctx.addIssue({ code: "custom", message: `Invalid Growth data: ${componentName} references missing data id ${JSON.stringify(dataId)}.` });
      continue;
    }
    const expectedKind = expectedKinds.get(componentName);
    if (expectedKind !== datum.kind) {
      ctx.addIssue({ code: "custom", message: `Invalid Growth data: ${componentName} requires ${expectedKind} data, but ${JSON.stringify(dataId)} is ${datum.kind}.` });
    }
  }
  for (const match of document.source_mdx.matchAll(/<Evidence\b(?=[^>]*\bdata\s*=\s*(?:"([^"]+)"|'([^']+)'))[^>]*>/g)) {
    const dataId = firstDefinedCapture(match[1], match[2]);
    if (dataId !== undefined && byId.get(dataId) === undefined) {
      ctx.addIssue({ code: "custom", message: `Invalid Growth data: Evidence references missing data id ${JSON.stringify(dataId)}.` });
    }
  }
});

export type GrowthDocumentInput = z.infer<typeof growthDocumentInputSchema>;

const ACTION_COMPONENT_PATTERN = /<(Finding|Evidence|Recommendation)\b[^>]*>[\s\S]*?<\/\1>|<MeasurementPlan\s*\/\s*>/g;

/**
 * Action suggestions intentionally have a smaller grammar than reports and findings. The product
 * owns their four-section layout, so the model may only provide semantic editable copy and the
 * marker where live watched metrics belong.
 * This validation complements the dashboard renderer, which independently ignores arbitrary
 * headings and prose in action documents saved before this contract existed.
 */
export const growthActionDocumentInputSchema = growthDocumentInputSchema.superRefine((document, ctx) => {
  const components = [...document.source_mdx.matchAll(ACTION_COMPONENT_PATTERN)];
  const names = components.map((match) => {
    const pairedComponentName = firstDefinedCapture(match[1], undefined);
    return pairedComponentName === undefined ? "MeasurementPlan" : pairedComponentName;
  });
  const remainingSource = document.source_mdx.replace(ACTION_COMPONENT_PATTERN, "").trim();
  const evidenceComponents = components.filter((match) => match[1] === "Evidence");
  const hasExactSequence = names.length >= 4
    && names[0] === "Finding"
    && names.at(-2) === "Recommendation"
    && names.at(-1) === "MeasurementPlan"
    && names.slice(1, -2).every((name) => name === "Evidence")
    && evidenceComponents.length <= 4;
  const everyEvidenceHasData = evidenceComponents.every((match) => /\bdata=(?:"[^"]+"|'[^']+')/.test(match[0]));
  if (!hasExactSequence || !everyEvidenceHasData || remainingSource.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "Action documents must contain one Finding, one to four data-backed Evidence blocks, one Recommendation, and one MeasurementPlan, in that order, with no headings or free-standing prose.",
    });
  }
});
