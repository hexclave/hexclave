import { describe, expect, it } from "vitest";
import { buildGrowthDemoStatus, GROWTH_DEMO_NOW_MILLIS } from "@/lib/growth/growth-demo-data";
import type { GrowthStatus } from "@/lib/growth/growth-types";
import { getGrowthOverviewRefreshVersion } from "./workspace-overview";

describe("getGrowthOverviewRefreshVersion", () => {
  it("changes when the report is published or its run completes", () => {
    const beforeReport = buildGrowthDemoStatus("analyzing", GROWTH_DEMO_NOW_MILLIS);
    const withReport = {
      ...beforeReport,
      latestReport: {
        id: "report-1",
        createdAtMillis: GROWTH_DEMO_NOW_MILLIS,
        readAtMillis: null,
        trigger: "initial",
        milestoneLabel: null,
      },
    } satisfies GrowthStatus;
    const completed = {
      ...withReport,
      analysis: {
        ...withReport.analysis,
        completedAtMillis: GROWTH_DEMO_NOW_MILLIS + 1,
      },
    };

    expect(getGrowthOverviewRefreshVersion(beforeReport)).not.toBe(getGrowthOverviewRefreshVersion(withReport));
    expect(getGrowthOverviewRefreshVersion(withReport)).not.toBe(getGrowthOverviewRefreshVersion(completed));
  });

  it("does not change for ordinary status polls during the same run", () => {
    const status = buildGrowthDemoStatus("analyzing", GROWTH_DEMO_NOW_MILLIS);
    const polled = {
      ...status,
      analysis: {
        ...status.analysis,
        startedAtMillis: GROWTH_DEMO_NOW_MILLIS + 1,
      },
    };

    expect(getGrowthOverviewRefreshVersion(status)).toBe(getGrowthOverviewRefreshVersion(polled));
  });

  it("changes when staff releases the scored workspace", () => {
    const preparing = buildGrowthDemoStatus("report-ready", GROWTH_DEMO_NOW_MILLIS);
    const released = {
      ...preparing,
      release: { state: "released" },
    } satisfies GrowthStatus;

    expect(preparing.release.state).toBe("preparing");
    expect(getGrowthOverviewRefreshVersion(preparing)).not.toBe(getGrowthOverviewRefreshVersion(released));
  });
});
