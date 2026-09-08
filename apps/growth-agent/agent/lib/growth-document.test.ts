import { describe, expect, it } from "vitest";
import { GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE, growthActionDocumentInputSchema, growthDocumentInputSchema } from "./growth-document.ts";

const metricData = {
  id: "activation",
  kind: "metric",
  title: "New-user activation",
  unit: "percent",
  source: "Product events, last 30 days",
  takeaway: "New-user activation is below the current target.",
  value: 12,
};

function parseDocument(source_mdx: string) {
  return growthDocumentInputSchema.safeParse({
    format: "growth-mdx-v1",
    source_mdx,
    data: [metricData],
  });
}

describe("growthDocumentInputSchema", () => {
  it("accepts valid block-level Growth MDX", () => {
    expect(parseDocument(`## Activation

<Metric data="activation" />

<Evidence data="activation">

Only 12% of new signups activated in the measured window.

</Evidence>`).success).toBe(true);
  });

  it("does not interpret component-like text or expressions inside code as MDX", () => {
    expect(parseDocument(`## Implementation note

\`{value}\`

\`\`\`tsx
<Metric data-id="example" />
const example = { value: 1 };
\`\`\``).success).toBe(true);
  });

  it.each([
    ["the unsupported data-id attribute", '<Metric data-id="activation" />', /data attribute, not data-id/],
    ["an inline component", 'Activation is low: <Metric data="activation" />', /block-level component/],
    ["malformed MDX", '<Metric data="activation" /', /malformed or unterminated/],
    ["an unclosed component", '<Evidence data="activation">\n\nActivation is low.', /missing its closing tag/],
    ["an oversized paragraph", "a".repeat(361), /at most 360 characters/],
    ["an oversized component body", `<Evidence>\n\n${"a".repeat(361)}\n\n</Evidence>`, /at most 360 characters/],
    ["a list with eight items", Array.from({ length: 8 }, (_, index) => `- item ${index + 1}`).join("\n"), /lists must have at most 7 items/],
  ])("rejects %s before a save tool can call the backend", (_label, sourceMdx, expectedMessage) => {
    const result = parseDocument(sourceMdx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(expectedMessage);
  });

  it("rejects a metric component whose data item has the wrong kind", () => {
    const result = growthDocumentInputSchema.safeParse({
      format: "growth-mdx-v1",
      source_mdx: '<Metric data="activation" />',
      data: [{
        id: "activation",
        kind: "comparison",
        title: "Activation",
        unit: "percent",
        source: "Product events",
        takeaway: "Activation varies by source.",
        items: [{ label: "Organic", value: 12 }],
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/Metric requires metric data/);
  });

  it("rejects an Evidence component whose data item is missing", () => {
    const result = parseDocument(`<Evidence data="missing">\n\nThe source is unavailable.\n\n</Evidence>`);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/Evidence references missing data id/);
  });
});

describe("growthActionDocumentInputSchema", () => {
  it("tells the model to write a short, grounded decision page", () => {
    expect(GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE).toContain("population or sample");
    expect(GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE).toContain("time window");
    expect(GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE).toContain("comparison or baseline");
    expect(GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE).toContain("material limitation");
    expect(GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE).toContain("simple English");
    expect(GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE).toContain("under 18 words");
    expect(GROWTH_ACTION_DOCUMENT_AUTHORING_GUIDE).toContain("live watched metrics");
  });

  it("accepts the semantic finding, evidence, recommendation, measurement sequence", () => {
    const result = growthActionDocumentInputSchema.safeParse({
      format: "growth-mdx-v1",
      source_mdx: `<Finding>

Search visitors activate more often than the site average.

</Finding>

<Evidence data="activation">

Only 12% of new signups activated in the measured window.

</Evidence>

<Recommendation>

Test a clearer signup prompt for 14 days.

</Recommendation>

<MeasurementPlan />`,
      data: [metricData],
    });

    expect(result.success).toBe(true);
  });

  it("rejects model-authored headings and extra action sections", () => {
    const result = growthActionDocumentInputSchema.safeParse({
      format: "growth-mdx-v1",
      source_mdx: "## Finding\n\n<Finding>Search converts better.</Finding>\n\n<Evidence data=\"activation\">Proof</Evidence>\n\n<Recommendation>Run it.</Recommendation>\n\n<MeasurementPlan />",
      data: [metricData],
    });

    expect(result.success).toBe(false);
  });

  it("rejects action evidence without a data reference", () => {
    const result = growthActionDocumentInputSchema.safeParse({
      format: "growth-mdx-v1",
      source_mdx: "<Finding>Search converts better.</Finding>\n\n<Evidence>Proof</Evidence>\n\n<Recommendation>Run it.</Recommendation>\n\n<MeasurementPlan />",
      data: [metricData],
    });

    expect(result.success).toBe(false);
  });
});
