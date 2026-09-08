import { StatusError } from "@hexclave/shared/dist/utils/errors";
import type { RootContent, PhrasingContent } from "mdast";
import type { MdxJsxAttribute, MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

export const GROWTH_DOCUMENT_FORMAT = "growth-mdx-v1" as const;

const MAX_SOURCE_LENGTH = 100_000;
const MAX_PARAGRAPH_LENGTH = 360;
const MAX_LIST_ITEMS = 7;
const MAX_TABLE_ROWS = 8;
const MAX_DATA_ITEMS = 40;
const MAX_SERIES = 3;
const MAX_POINTS_PER_SERIES = 90;

export const GROWTH_DOCUMENT_UNITS = ["count", "cents", "percent", "seconds", "minor_units"] as const;
export type GrowthDocumentUnit = typeof GROWTH_DOCUMENT_UNITS[number];

export type GrowthDocumentInline =
  | { type: "text", value: string }
  | { type: "strong", children: GrowthDocumentInline[] }
  | { type: "emphasis", children: GrowthDocumentInline[] }
  | { type: "delete", children: GrowthDocumentInline[] }
  | { type: "code", value: string }
  | { type: "break" }
  | { type: "link", url: string, children: GrowthDocumentInline[] };

export type GrowthDocumentComponentName = "Metric" | "TrendChart" | "ComparisonChart" | "BreakdownChart" | "Evidence" | "Hypothesis" | "Experiment" | "DataGap" | "ActionButton" | "Finding" | "Recommendation" | "MeasurementPlan";

export type GrowthDocumentBlock =
  | { type: "heading", level: 2 | 3, children: GrowthDocumentInline[] }
  | { type: "paragraph", children: GrowthDocumentInline[] }
  | { type: "list", ordered: boolean, items: GrowthDocumentBlock[][] }
  | { type: "table", align: Array<"left" | "center" | "right" | null>, rows: GrowthDocumentInline[][][] }
  | { type: "code", language: string | null, value: string }
  | { type: "rule" }
  // `actionId` is only ever set on ActionButton: a reference to a GrowthActionItem
  // of this project. It carries no privilege — the dashboard resolves it to its own
  // action control, which calls the ordinary (authorized) action endpoints — which
  // is why an authored document may contain one at all.
  | { type: "component", name: GrowthDocumentComponentName, dataId: string | null, confidence: "low" | "medium" | "high" | null, actionId: string | null, children: GrowthDocumentBlock[] };

export type GrowthEvidencePoint = { label: string, value: number };
export type GrowthEvidenceSeries = { label: string, points: GrowthEvidencePoint[] };

type GrowthEvidenceBase = {
  id: string,
  title: string,
  unit: GrowthDocumentUnit,
  source: string,
  takeaway: string,
  timezone: string | null,
  currency: string | null,
};

export type GrowthEvidenceDatum =
  | (GrowthEvidenceBase & { kind: "metric", value: number, comparisonLabel: string | null, comparisonValue: number | null })
  | (GrowthEvidenceBase & { kind: "time_series", series: GrowthEvidenceSeries[] })
  | (GrowthEvidenceBase & { kind: "comparison" | "breakdown", items: GrowthEvidencePoint[] });

export type GrowthDocument = {
  format: typeof GROWTH_DOCUMENT_FORMAT,
  sourceMdx: string,
  blocks: GrowthDocumentBlock[],
  data: GrowthEvidenceDatum[],
};

function invalidDocument(message: string): never {
  throw new StatusError(400, `Invalid Growth document: ${message}`);
}

function readRequiredString(value: unknown, field: string, maxLength = 5_000): string {
  if (typeof value !== "string" || value.trim().length === 0) invalidDocument(`${field} must be a non-empty string.`);
  if (value.length > maxLength) invalidDocument(`${field} is too long.`);
  return value;
}

function readOptionalString(value: unknown, field: string, maxLength = 5_000): string | null {
  if (value == null) return null;
  return readRequiredString(value, field, maxLength);
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalidDocument(`${field} must be a finite number.`);
  return value;
}

function readUnit(value: unknown, field: string): GrowthDocumentUnit {
  if (typeof value !== "string") invalidDocument(`${field} must be a supported unit.`);
  const unit = GROWTH_DOCUMENT_UNITS.find((candidate) => candidate === value);
  if (unit == null) invalidDocument(`${field} must be one of ${GROWTH_DOCUMENT_UNITS.join(", ")}.`);
  return unit;
}

function readPoint(value: unknown, field: string): GrowthEvidencePoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidDocument(`${field} must be an object.`);
  if (!("label" in value) || !("value" in value)) invalidDocument(`${field} must include label and value.`);
  return {
    label: readRequiredString(value.label, `${field}.label`, 100),
    value: readFiniteNumber(value.value, `${field}.value`),
  };
}

function readPoints(value: unknown, field: string, max: number): GrowthEvidencePoint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) invalidDocument(`${field} must contain 1-${max} points.`);
  return value.map((point, index) => readPoint(point, `${field}[${index}]`));
}

function readEvidenceDatum(value: unknown, index: number): GrowthEvidenceDatum {
  const field = `data[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidDocument(`${field} must be an object.`);
  if (!("id" in value) || !("kind" in value) || !("title" in value) || !("unit" in value) || !("source" in value) || !("takeaway" in value)) {
    invalidDocument(`${field} is missing required evidence metadata.`);
  }
  const unit = readUnit(value.unit, `${field}.unit`);
  const currency = "currency" in value ? readOptionalString(value.currency, `${field}.currency`, 3) : null;
  if (unit === "minor_units" && (currency == null || !/^[A-Za-z]{3}$/.test(currency))) {
    invalidDocument(`${field}.currency must be a three-letter ISO currency when unit is minor_units.`);
  }
  if (unit !== "minor_units" && currency != null) invalidDocument(`${field}.currency is only valid when unit is minor_units.`);
  const base: GrowthEvidenceBase = {
    id: readRequiredString(value.id, `${field}.id`, 100),
    title: readRequiredString(value.title, `${field}.title`, 200),
    unit,
    source: readRequiredString(value.source, `${field}.source`, 500),
    takeaway: readRequiredString(value.takeaway, `${field}.takeaway`, 360),
    timezone: "timezone" in value ? readOptionalString(value.timezone, `${field}.timezone`, 100) : null,
    currency: currency == null ? null : currency.toUpperCase(),
  };
  if (value.kind === "metric") {
    if (!("value" in value)) invalidDocument(`${field}.value is required for a metric.`);
    const comparisonLabel = "comparison_label" in value ? readOptionalString(value.comparison_label, `${field}.comparison_label`, 100) : null;
    const comparisonValue = "comparison_value" in value && value.comparison_value != null
      ? readFiniteNumber(value.comparison_value, `${field}.comparison_value`)
      : null;
    if ((comparisonLabel == null) !== (comparisonValue == null)) invalidDocument(`${field} comparison label and value must be provided together.`);
    return { ...base, kind: "metric", value: readFiniteNumber(value.value, `${field}.value`), comparisonLabel, comparisonValue };
  }
  if (value.kind === "time_series") {
    if (!("series" in value) || !Array.isArray(value.series) || value.series.length === 0 || value.series.length > MAX_SERIES) {
      invalidDocument(`${field}.series must contain 1-${MAX_SERIES} series.`);
    }
    const series = value.series.map((candidate, seriesIndex) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || !("label" in candidate) || !("points" in candidate)) {
        invalidDocument(`${field}.series[${seriesIndex}] must include label and points.`);
      }
      return {
        label: readRequiredString(candidate.label, `${field}.series[${seriesIndex}].label`, 100),
        points: readPoints(candidate.points, `${field}.series[${seriesIndex}].points`, MAX_POINTS_PER_SERIES),
      };
    });
    return { ...base, kind: "time_series", series };
  }
  if (value.kind === "comparison" || value.kind === "breakdown") {
    if (!("items" in value)) invalidDocument(`${field}.items is required.`);
    return { ...base, kind: value.kind, items: readPoints(value.items, `${field}.items`, MAX_TABLE_ROWS) };
  }
  invalidDocument(`${field}.kind is not supported.`);
}

function readEvidenceData(value: unknown): GrowthEvidenceDatum[] {
  if (!Array.isArray(value) || value.length > MAX_DATA_ITEMS) invalidDocument(`data must be an array with at most ${MAX_DATA_ITEMS} items.`);
  const data = value.map(readEvidenceDatum);
  const ids = new Set<string>();
  for (const datum of data) {
    if (ids.has(datum.id)) invalidDocument(`data id "${datum.id}" is duplicated.`);
    ids.add(datum.id);
  }
  return data;
}

function readSafeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    invalidDocument("links must use absolute http, https, or mailto URLs.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    invalidDocument("links must use http, https, or mailto URLs.");
  }
  return url;
}

function inlineTextLength(children: GrowthDocumentInline[]): number {
  let total = 0;
  for (const child of children) {
    if (child.type === "text" || child.type === "code") total += child.value.length;
    if (child.type === "strong" || child.type === "emphasis" || child.type === "delete" || child.type === "link") total += inlineTextLength(child.children);
  }
  return total;
}

function convertInline(node: PhrasingContent): GrowthDocumentInline {
  switch (node.type) {
    case "text": { return { type: "text", value: node.value }; }
    case "strong": { return { type: "strong", children: node.children.map(convertInline) }; }
    case "emphasis": { return { type: "emphasis", children: node.children.map(convertInline) }; }
    case "delete": { return { type: "delete", children: node.children.map(convertInline) }; }
    case "inlineCode": { return { type: "code", value: node.value }; }
    case "break": { return { type: "break" }; }
    case "link": { return { type: "link", url: readSafeUrl(node.url), children: node.children.map(convertInline) }; }
    case "image": { return invalidDocument("images are not supported; use evidence components instead."); }
    case "html": { return invalidDocument("raw HTML is not allowed."); }
    case "linkReference":
    case "imageReference":
    case "footnoteReference": { return invalidDocument("reference-style Markdown is not supported."); }
    case "mdxJsxTextElement": { return invalidDocument("Growth components must be block-level elements on their own line."); }
    case "mdxTextExpression": { return invalidDocument("JavaScript expressions are not allowed."); }
  }
}

function readAttributes(node: MdxJsxFlowElement): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const attribute of node.attributes) {
    if (attribute.type !== "mdxJsxAttribute") invalidDocument("spread and expression attributes are not allowed.");
    if (result.has(attribute.name)) invalidDocument(`${node.name ?? "component"} repeats the ${attribute.name} attribute.`);
    if (attribute.value != null && typeof attribute.value !== "string") invalidDocument("attribute expressions are not allowed.");
    result.set(attribute.name, attribute.value ?? null);
  }
  return result;
}

function assertOnlyAttributes(name: string, attributes: Map<string, string | null>, allowed: readonly string[]): void {
  for (const key of attributes.keys()) {
    if (!allowed.includes(key)) invalidDocument(`${name} does not support the ${key} attribute.`);
  }
}

function convertComponent(node: MdxJsxFlowElement): GrowthDocumentBlock {
  const name = node.name;
  if (name !== "Metric" && name !== "TrendChart" && name !== "ComparisonChart" && name !== "BreakdownChart"
    && name !== "Evidence" && name !== "Hypothesis" && name !== "Experiment" && name !== "DataGap" && name !== "ActionButton"
    && name !== "Finding" && name !== "Recommendation" && name !== "MeasurementPlan") {
    invalidDocument(`component ${name ?? "fragment"} is not allowed.`);
  }
  const attributes = readAttributes(node);
  if (name === "Metric" || name === "TrendChart" || name === "ComparisonChart" || name === "BreakdownChart") {
    assertOnlyAttributes(name, attributes, ["data"]);
    const dataId = attributes.get("data");
    if (dataId == null || dataId.length === 0) invalidDocument(`${name} requires a data attribute.`);
    if (node.children.length > 0) invalidDocument(`${name} must be self-closing.`);
    return { type: "component", name, dataId, confidence: null, actionId: null, children: [] };
  }
  if (name === "ActionButton") {
    assertOnlyAttributes(name, attributes, ["action"]);
    const actionId = attributes.get("action");
    if (actionId == null || actionId.length === 0) invalidDocument("ActionButton requires an action attribute.");
    if (actionId.length > 100) invalidDocument("ActionButton action is not an action id.");
    // Self-closing on purpose: the button's label and state come from the action it
    // references, so customer-facing copy cannot drift from what the action does.
    if (node.children.length > 0) invalidDocument("ActionButton must be self-closing.");
    return { type: "component", name, dataId: null, confidence: null, actionId, children: [] };
  }
  if (name === "MeasurementPlan") {
    assertOnlyAttributes(name, attributes, []);
    if (node.children.length > 0) invalidDocument("MeasurementPlan must be self-closing.");
    return { type: "component", name, dataId: null, confidence: null, actionId: null, children: [] };
  }
  if (name === "Evidence") {
    assertOnlyAttributes(name, attributes, ["data"]);
    return { type: "component", name, dataId: attributes.get("data") ?? null, confidence: null, actionId: null, children: node.children.map(convertBlock) };
  }
  if (name === "Hypothesis") {
    assertOnlyAttributes(name, attributes, ["confidence"]);
    const confidence = attributes.get("confidence") ?? "medium";
    if (confidence !== "low" && confidence !== "medium" && confidence !== "high") invalidDocument("Hypothesis confidence must be low, medium, or high.");
    return { type: "component", name, dataId: null, confidence, actionId: null, children: node.children.map(convertBlock) };
  }
  assertOnlyAttributes(name, attributes, []);
  return { type: "component", name, dataId: null, confidence: null, actionId: null, children: node.children.map(convertBlock) };
}

function convertBlock(node: RootContent): GrowthDocumentBlock {
  switch (node.type) {
    case "heading": {
      if (node.depth !== 2 && node.depth !== 3) invalidDocument("only level 2 and level 3 headings are allowed.");
      return { type: "heading", level: node.depth, children: node.children.map(convertInline) };
    }
    case "paragraph": {
      const children = node.children.map(convertInline);
      if (inlineTextLength(children) > MAX_PARAGRAPH_LENGTH) invalidDocument(`paragraphs must be at most ${MAX_PARAGRAPH_LENGTH} characters.`);
      return { type: "paragraph", children };
    }
    case "list": {
      if (node.children.length > MAX_LIST_ITEMS) invalidDocument(`lists must have at most ${MAX_LIST_ITEMS} items.`);
      return { type: "list", ordered: node.ordered === true, items: node.children.map((item) => item.children.map(convertBlock)) };
    }
    case "table": {
      if (node.children.length > MAX_TABLE_ROWS + 1) invalidDocument(`tables must have at most ${MAX_TABLE_ROWS} body rows.`);
      return { type: "table", align: node.align ?? [], rows: node.children.map((row) => row.children.map((cell) => cell.children.map(convertInline))) };
    }
    case "code": { return { type: "code", language: node.lang ?? null, value: node.value }; }
    case "thematicBreak": { return { type: "rule" }; }
    case "mdxJsxFlowElement": { return convertComponent(node); }
    case "blockquote": { return invalidDocument("blockquotes are not supported; use Evidence, Hypothesis, Experiment, or DataGap."); }
    case "html": { return invalidDocument("raw HTML is not allowed."); }
    case "definition":
    case "footnoteDefinition": { return invalidDocument("reference-style Markdown is not supported."); }
    case "mdxjsEsm": { return invalidDocument("imports and exports are not allowed."); }
    case "mdxFlowExpression": { return invalidDocument("JavaScript expressions are not allowed."); }
    case "yaml": { return invalidDocument("frontmatter is not allowed."); }
    case "link":
    case "delete":
    case "text":
    case "image":
    case "break":
    case "strong":
    case "emphasis":
    case "footnoteReference":
    case "imageReference":
    case "inlineCode":
    case "linkReference":
    case "mdxJsxTextElement":
    case "mdxTextExpression":
    case "listItem":
    case "tableCell":
    case "tableRow": { return invalidDocument(`${node.type} cannot appear as a top-level block.`); }
  }
}

function validateDataReferences(blocks: GrowthDocumentBlock[], data: GrowthEvidenceDatum[]): void {
  const byId = new Map(data.map((datum) => [datum.id, datum]));
  const visit = (block: GrowthDocumentBlock): void => {
    if (block.type === "list") {
      for (const item of block.items) for (const child of item) visit(child);
      return;
    }
    if (block.type !== "component") return;
    if (block.dataId != null) {
      const datum = byId.get(block.dataId);
      if (datum == null) invalidDocument(`${block.name} references missing data id "${block.dataId}".`);
      if (block.name === "Metric" && datum.kind !== "metric") invalidDocument(`Metric requires metric data.`);
      if (block.name === "TrendChart" && datum.kind !== "time_series") invalidDocument(`TrendChart requires time_series data.`);
      if (block.name === "ComparisonChart" && datum.kind !== "comparison") invalidDocument(`ComparisonChart requires comparison data.`);
      if (block.name === "BreakdownChart" && datum.kind !== "breakdown") invalidDocument(`BreakdownChart requires breakdown data.`);
    }
    for (const child of block.children) visit(child);
  };
  for (const block of blocks) visit(block);
}

/**
 * Every action an authored document references, in document order and de-duplicated.
 *
 * The compiler cannot check that an id exists — it has no database — so the caller
 * that persists a document (see lib/growth/category-pages.ts) resolves these ids
 * against its own project/branch and rejects references it does not own. A
 * dangling reference must fail on write, not render as a dead button.
 */
export function collectGrowthDocumentActionIds(blocks: GrowthDocumentBlock[]): string[] {
  const ids: string[] = [];
  const visit = (block: GrowthDocumentBlock): void => {
    if (block.type === "list") {
      for (const item of block.items) for (const child of item) visit(child);
      return;
    }
    if (block.type !== "component") return;
    if (block.actionId != null && !ids.includes(block.actionId)) ids.push(block.actionId);
    for (const child of block.children) visit(child);
  };
  for (const block of blocks) visit(block);
  return ids;
}

/**
 * The same reference list, read off a STORED document.
 *
 * A stored row is JSON that was a valid AST when it was written, so this walks it structurally
 * rather than re-typing it: callers only need the ids (to resolve the actions a live page links to),
 * and a row written by an older shape of the compiler must still yield its references.
 */
export function collectStoredGrowthDocumentActionIds(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if ("actionId" in node && typeof node.actionId === "string" && node.actionId.length > 0 && !ids.includes(node.actionId)) ids.push(node.actionId);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return ids;
}

export function compileGrowthDocument(value: unknown): GrowthDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidDocument("document must be an object.");
  if (!("format" in value) || value.format !== GROWTH_DOCUMENT_FORMAT) invalidDocument(`format must be ${GROWTH_DOCUMENT_FORMAT}.`);
  if (!("source_mdx" in value) || !("data" in value)) invalidDocument("source_mdx and data are required.");
  const sourceMdx = readRequiredString(value.source_mdx, "source_mdx", MAX_SOURCE_LENGTH);
  const data = readEvidenceData(value.data);
  let tree;
  try {
    tree = unified().use(remarkParse).use(remarkGfm).use(remarkMdx).parse(sourceMdx);
  } catch {
    invalidDocument("MDX could not be parsed.");
  }
  const blocks = tree.children.map(convertBlock);
  if (blocks.length === 0) invalidDocument("document must contain content.");
  validateDataReferences(blocks, data);
  return { format: GROWTH_DOCUMENT_FORMAT, sourceMdx, blocks, data };
}

function containsGrowthComponent(blocks: GrowthDocumentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === "component") return true;
    if (block.type === "list" && block.items.some((item) => containsGrowthComponent(item))) return true;
  }
  return false;
}

/**
 * Action pages use the shared editable MDX format, but their information architecture is fixed.
 * Keeping this validation beside the general compiler means both agent writes and staff-edited
 * drafts enforce the same contract instead of relying on the dashboard to hide malformed content.
 */
export function compileGrowthActionDocument(value: unknown): GrowthDocument {
  const document = compileGrowthDocument(value);
  if (document.blocks.some((block) => block.type !== "component")) {
    invalidDocument("action pages may only contain Finding, Evidence, Recommendation, and MeasurementPlan sections.");
  }
  const components = document.blocks.flatMap((block) => block.type === "component" ? [block] : []);
  const names = components.map((component) => component.name);
  const evidence = components.filter((component) => component.name === "Evidence");
  const hasSemanticOrder = names.length >= 4
    && names[0] === "Finding"
    && names.at(-2) === "Recommendation"
    && names.at(-1) === "MeasurementPlan"
    && names.slice(1, -2).every((name) => name === "Evidence");
  // Existing action pages used Hypothesis/Evidence/Experiment. Keep that exact grammar editable
  // while every current model-facing schema and prompt emits the semantic structure above.
  const hasLegacyOrder = names.length >= 3
    && names[0] === "Hypothesis"
    && names.at(-1) === "Experiment"
    && names.slice(1, -1).every((name) => name === "Evidence");
  if ((!hasSemanticOrder && !hasLegacyOrder) || evidence.length > 4) {
    invalidDocument("action pages must contain one Finding, one to four Evidence sections, one Recommendation, and one MeasurementPlan, in that order.");
  }
  if (hasSemanticOrder && evidence.some((component) => component.dataId == null)) {
    invalidDocument("every action-page Evidence section must reference a data id.");
  }
  for (const component of components) {
    if (containsGrowthComponent(component.children)) {
      invalidDocument(`${component.name} cannot contain nested Growth components on an action page.`);
    }
  }
  return document;
}
