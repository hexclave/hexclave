import { describe, expect, it } from "vitest";
import { collectGrowthDocumentActionIds, collectStoredGrowthDocumentActionIds, compileGrowthActionDocument, compileGrowthDocument } from "./content-document";

const trendData = {
  id: "signup-trend",
  kind: "time_series",
  title: "Weekly signups",
  unit: "count",
  source: "Growth daily metrics · Jul 1–21",
  takeaway: "Signups declined for three consecutive weeks.",
  series: [{ label: "Signups", points: [{ label: "Jul 7", value: 120 }, { label: "Jul 14", value: 96 }] }],
};

describe("compileGrowthDocument", () => {
  it("compiles the constrained MDX vocabulary into a safe render tree", () => {
    expect(compileGrowthDocument({
      format: "growth-mdx-v1",
      source_mdx: "## What changed\n\n<TrendChart data=\"signup-trend\" />\n\n<Hypothesis confidence=\"medium\">\n\nThe landing-page promise may not match paid traffic.\n\n</Hypothesis>",
      data: [trendData],
    })).toMatchInlineSnapshot(`
      {
        "blocks": [
          {
            "children": [
              {
                "type": "text",
                "value": "What changed",
              },
            ],
            "level": 2,
            "type": "heading",
          },
          {
            "actionId": null,
            "children": [],
            "confidence": null,
            "dataId": "signup-trend",
            "name": "TrendChart",
            "type": "component",
          },
          {
            "actionId": null,
            "children": [
              {
                "children": [
                  {
                    "type": "text",
                    "value": "The landing-page promise may not match paid traffic.",
                  },
                ],
                "type": "paragraph",
              },
            ],
            "confidence": "medium",
            "dataId": null,
            "name": "Hypothesis",
            "type": "component",
          },
        ],
        "data": [
          {
            "currency": null,
            "id": "signup-trend",
            "kind": "time_series",
            "series": [
              {
                "label": "Signups",
                "points": [
                  {
                    "label": "Jul 7",
                    "value": 120,
                  },
                  {
                    "label": "Jul 14",
                    "value": 96,
                  },
                ],
              },
            ],
            "source": "Growth daily metrics · Jul 1–21",
            "takeaway": "Signups declined for three consecutive weeks.",
            "timezone": null,
            "title": "Weekly signups",
            "unit": "count",
          },
        ],
        "format": "growth-mdx-v1",
        "sourceMdx": "## What changed

      <TrendChart data=\"signup-trend\" />

      <Hypothesis confidence=\"medium\">

      The landing-page promise may not match paid traffic.

      </Hypothesis>",
      }
    `);
  });

  it.each([
    ["raw HTML", "<script>alert(1)</script>"],
    ["imports", "import Thing from './thing'\n\n## Result"],
    ["expressions", "## Result\n\n{process.env.SECRET}"],
    ["unknown components", "<Anything />"],
  ])("rejects %s", (_label, source_mdx) => {
    expect(() => compileGrowthDocument({ format: "growth-mdx-v1", source_mdx, data: [] })).toThrow(/Invalid Growth document/);
  });

  it("rejects chart references with the wrong evidence type", () => {
    expect(() => compileGrowthDocument({
      format: "growth-mdx-v1",
      source_mdx: "<Metric data=\"signup-trend\" />",
      data: [trendData],
    })).toThrow(/Metric requires metric data/);
  });

  it("rejects overwhelming paragraphs", () => {
    expect(() => compileGrowthDocument({ format: "growth-mdx-v1", source_mdx: "a".repeat(361), data: [] })).toThrow(/at most 360 characters/);
  });

  // <ActionButton> is the one authored component that does something rather than
  // says something, so what it may and may not carry is worth pinning down: an
  // action id and nothing else. Whether that id exists is checked where the
  // document is persisted (lib/growth/category-pages.ts) — the compiler has no
  // database.
  it("compiles an action reference and nothing else about the action", () => {
    const compiled = compileGrowthDocument({
      format: "growth-mdx-v1",
      source_mdx: "Ready when you are.\n\n<ActionButton action=\"8f1c0c9e-1f0e-4f1e-9b4a-1c0e5f8a2b31\" />",
      data: [],
    });
    expect(compiled.blocks[1]).toEqual({
      type: "component",
      name: "ActionButton",
      dataId: null,
      confidence: null,
      actionId: "8f1c0c9e-1f0e-4f1e-9b4a-1c0e5f8a2b31",
      children: [],
    });
    expect(collectGrowthDocumentActionIds(compiled.blocks)).toEqual(["8f1c0c9e-1f0e-4f1e-9b4a-1c0e5f8a2b31"]);
  });

  it.each([
    ["an action reference with no action", "<ActionButton />"],
    ["a label that could contradict what the action does", "<ActionButton action=\"abc\">Deploy everything</ActionButton>"],
    ["attributes other than the reference", "<ActionButton action=\"abc\" onClick=\"run()\" />"],
  ])("rejects %s", (_label, source_mdx) => {
    expect(() => compileGrowthDocument({ format: "growth-mdx-v1", source_mdx, data: [] })).toThrow(/Invalid Growth document/);
  });

  it("collects each referenced action once, including from inside lists", () => {
    const compiled = compileGrowthDocument({
      format: "growth-mdx-v1",
      source_mdx: "<ActionButton action=\"first\" />\n\n<Experiment>\n\n<ActionButton action=\"second\" />\n\n</Experiment>\n\n<ActionButton action=\"first\" />",
      data: [],
    });
    expect(collectGrowthDocumentActionIds(compiled.blocks)).toEqual(["first", "second"]);
  });

  it("collects the same references off a stored document, which is plain JSON", () => {
    const compiled = compileGrowthDocument({
      format: "growth-mdx-v1",
      source_mdx: "<ActionButton action=\"first\" />\n\n<Experiment>\n\n<ActionButton action=\"second\" />\n\n</Experiment>",
      data: [],
    });
    // A stored row has been through JSON, so it is structurally identical but no longer typed.
    expect(collectStoredGrowthDocumentActionIds(JSON.parse(JSON.stringify(compiled)))).toEqual(["first", "second"]);
    expect(collectStoredGrowthDocumentActionIds(null)).toEqual([]);
    expect(collectStoredGrowthDocumentActionIds({ blocks: [{ type: "paragraph", children: [] }] })).toEqual([]);
  });

  it("requires a currency before rendering monetary minor units", () => {
    expect(() => compileGrowthDocument({
      format: "growth-mdx-v1",
      source_mdx: "<Metric data=\"spend\" />",
      data: [{ id: "spend", kind: "metric", title: "Spend", unit: "minor_units", source: "Ad account", takeaway: "Spend stayed within the cap.", value: 1250 }],
    })).toThrow(/three-letter ISO currency/);
  });
});

describe("compileGrowthActionDocument", () => {
  const source_mdx = `<Finding>

Search visitors activate more often than direct visitors.

</Finding>

<Evidence data="activation">

Search visitors activated at 31%. Direct visitors activated at 23%.

</Evidence>

<Recommendation>

Publish the comparison page.

- Link it from the home page.
- Review results after 14 days.

</Recommendation>

<MeasurementPlan />`;

  const data = [{
    id: "activation",
    kind: "metric",
    title: "Search activation",
    unit: "percent",
    source: "Acquisition events, last 30 days",
    takeaway: "Search activation is eight points above direct activation.",
    value: 31,
    comparison_label: "direct activation",
    comparison_value: 23,
  }];

  it("compiles the editable semantic action-page structure", () => {
    expect(compileGrowthActionDocument({ format: "growth-mdx-v1", source_mdx, data }).blocks.map((block) => block.type === "component" ? block.name : block.type)).toEqual([
      "Finding",
      "Evidence",
      "Recommendation",
      "MeasurementPlan",
    ]);
  });

  it("keeps legacy action-page MDX editable", () => {
    const legacySource = `<Hypothesis confidence="medium">

Search visitors may be a strong audience.

</Hypothesis>

<Evidence data="activation">

Search visitors activated at 31%. Direct visitors activated at 23%.

</Evidence>

<Experiment>

Publish the comparison page.

</Experiment>`;

    expect(compileGrowthActionDocument({ format: "growth-mdx-v1", source_mdx: legacySource, data }).blocks).toHaveLength(3);
  });

  it.each([
    ["missing evidence data", source_mdx.replace(' data="activation"', "")],
    ["free-standing prose", `${source_mdx}\n\nExtra copy`],
    ["missing measurement plan", source_mdx.replace("\n\n<MeasurementPlan />", "")],
  ])("rejects %s in newly authored action pages", (_label, invalidSource) => {
    expect(() => compileGrowthActionDocument({ format: "growth-mdx-v1", source_mdx: invalidSource, data })).toThrow(/Invalid Growth document/);
  });
});
