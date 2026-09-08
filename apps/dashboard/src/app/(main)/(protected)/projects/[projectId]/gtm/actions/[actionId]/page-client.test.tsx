import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionMeasurementPlan } from "./page-client";

describe("ActionMeasurementPlan", () => {
  it("renders live watched metrics as flat rows", () => {
    const html = renderToStaticMarkup(<ActionMeasurementPlan watchedMetrics={[
      { metricId: "new_signups", windowDays: 14 },
      { metricId: "returning_users", windowDays: 30 },
    ]} />);

    expect(html).toContain("What we&#x27;ll track");
    expect(html).toContain("New signups");
    expect(html).toContain("Track for 14 days");
    expect(html).toContain("Returning users");
    expect(html).not.toContain("rounded-xl");
  });
});
