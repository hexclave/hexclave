import { describe, expect, it } from "vitest";
import { buildSecurityEventsOffendersQuery, buildSecurityEventsSummaryQuery } from "./security-event-queries";

const SHARED_WHERE = `
  WHERE project_id = {projectId:String}
    AND branch_id = {branchId:String}
    AND event_at >= {from:DateTime}
    AND event_at <= {to:DateTime}`;

describe("compliance security event query shape", () => {
  it("expands all summary dimensions from one telemetry scan", () => {
    const query = buildSecurityEventsSummaryQuery(SHARED_WHERE);

    expect(query.match(/FROM analytics_internal\.events/g)).toHaveLength(1);
    expect(query).toContain("('category',");
    expect(query).toContain("('outcome',");
    expect(query).toContain("('reason',");
    expect(query).toContain("GROUP BY kind, bucket");
    expect(query).not.toContain("UNION ALL");
  });

  it("preserves an independent top ten for all offender dimensions in one scan", () => {
    const query = buildSecurityEventsOffendersQuery(SHARED_WHERE);

    expect(query.match(/FROM analytics_internal\.events/g)).toHaveLength(1);
    expect(query).toContain("('email',");
    expect(query).toContain("('ip',");
    expect(query).toContain("('country',");
    expect(query).toContain("LIMIT 10 BY kind");
    expect(query).not.toContain("UNION ALL");
  });
});
