import { z } from "zod";

export const GROWTH_DOCUMENT_UNITS = ["count", "cents", "percent", "seconds", "minor_units"] as const;
export type GrowthDocumentUnit = typeof GROWTH_DOCUMENT_UNITS[number];

export type GrowthDocumentInline =
  | { type: "text", value: string }
  | { type: "strong" | "emphasis" | "delete", children: GrowthDocumentInline[] }
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
  | {
    type: "component",
    name: GrowthDocumentComponentName,
    dataId: string | null,
    confidence: "low" | "medium" | "high" | null,
    // Only ever set on ActionButton, and only ever an id: the document references an
    // action, it never carries the action's data (let alone its workflow payload).
    actionId: string | null,
    children: GrowthDocumentBlock[],
  };

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
  format: "growth-mdx-v1",
  sourceMdx: string,
  blocks: GrowthDocumentBlock[],
  data: GrowthEvidenceDatum[],
};

const inlineSchema: z.ZodType<GrowthDocumentInline> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("strong"), children: z.array(inlineSchema) }),
  z.object({ type: z.literal("emphasis"), children: z.array(inlineSchema) }),
  z.object({ type: z.literal("delete"), children: z.array(inlineSchema) }),
  z.object({ type: z.literal("code"), value: z.string() }),
  z.object({ type: z.literal("break") }),
  z.object({ type: z.literal("link"), url: z.string(), children: z.array(inlineSchema) }),
]));

const componentNameSchema = z.enum(["Metric", "TrendChart", "ComparisonChart", "BreakdownChart", "Evidence", "Hypothesis", "Experiment", "DataGap", "ActionButton", "Finding", "Recommendation", "MeasurementPlan"]);
const blockSchema: z.ZodType<GrowthDocumentBlock> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.union([z.literal(2), z.literal(3)]), children: z.array(inlineSchema) }),
  z.object({ type: z.literal("paragraph"), children: z.array(inlineSchema) }),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(z.array(blockSchema)) }),
  z.object({ type: z.literal("table"), align: z.array(z.enum(["left", "center", "right"]).nullable()), rows: z.array(z.array(z.array(inlineSchema))) }),
  z.object({ type: z.literal("code"), language: z.string().nullable(), value: z.string() }),
  z.object({ type: z.literal("rule") }),
  z.object({
    type: z.literal("component"),
    name: componentNameSchema,
    dataId: z.string().nullable(),
    confidence: z.enum(["low", "medium", "high"]).nullable(),
    // Defaulted rather than required: documents compiled before ActionButton existed
    // are still stored on findings/actions, and they have no `actionId` key at all.
    actionId: z.string().nullable().default(null),
    children: z.array(blockSchema),
  }),
]));

const evidenceBaseShape = {
  id: z.string(),
  title: z.string(),
  unit: z.enum(GROWTH_DOCUMENT_UNITS),
  source: z.string(),
  takeaway: z.string(),
  timezone: z.string().nullable(),
  currency: z.string().nullable(),
};

const pointSchema = z.object({ label: z.string(), value: z.number() });
const evidenceSchema: z.ZodType<GrowthEvidenceDatum> = z.discriminatedUnion("kind", [
  z.object({ ...evidenceBaseShape, kind: z.literal("metric"), value: z.number(), comparisonLabel: z.string().nullable(), comparisonValue: z.number().nullable() }),
  z.object({ ...evidenceBaseShape, kind: z.literal("time_series"), series: z.array(z.object({ label: z.string(), points: z.array(pointSchema) })) }),
  z.object({ ...evidenceBaseShape, kind: z.literal("comparison"), items: z.array(pointSchema) }),
  z.object({ ...evidenceBaseShape, kind: z.literal("breakdown"), items: z.array(pointSchema) }),
]);

export const growthDocumentSchema: z.ZodType<GrowthDocument> = z.object({
  format: z.literal("growth-mdx-v1"),
  sourceMdx: z.string(),
  blocks: z.array(blockSchema),
  data: z.array(evidenceSchema),
});
