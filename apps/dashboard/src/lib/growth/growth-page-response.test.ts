import { describe, expect, it } from "vitest";
import { parseGrowthPageResponse } from "./growth-page-response";

describe("parseGrowthPageResponse", () => {
  it("separates fenced MDX and evidence JSON while ignoring surrounding model prose", () => {
    expect(parseGrowthPageResponse(`I removed the unsupported attribute.

\`\`\`mdx
## Engagement is deepening

<TrendChart data="daily" />
\`\`\`

\`\`\`json
[{"id":"daily","kind":"time_series"}]
\`\`\``)).toEqual({
      sourceMdx: "## Engagement is deepening\n\n<TrendChart data=\"daily\" />",
      evidenceDataJson: "[\n  {\n    \"id\": \"daily\",\n    \"kind\": \"time_series\"\n  }\n]",
    });
  });

  it("leaves a plain MDX paste alone", () => {
    expect(parseGrowthPageResponse("## Engagement is deepening")).toBeNull();
  });

  it("rejects a partial response instead of importing it as customer content", () => {
    expect(() => parseGrowthPageResponse("```mdx\n## Missing data\n```"))
      .toThrowError("The model response is missing its fenced json block.");
  });
});
