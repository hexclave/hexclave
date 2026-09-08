import { describe } from "vitest";
import { it } from "../../../../../../helpers";
import { Project, backendContext, niceBackendFetch } from "../../../../../backend-helpers";
import { GROWTH_AGENT_AUTH, createGrowthProject } from "../growth/growth-helpers";

const BASE_PATH = "/api/latest/internal/growth-agent";

// Growth fixtures seed sandbox-backed workflows during onboarding and can land around 60s under
// full-suite load, so default-timeout tests need 90s of headroom.

// The growth-agent read routes are machine routes authenticated purely by the shared agent secret
// (GROWTH_AGENT_AUTH) plus project_id/branch_id in the query/body — no Hexclave access type. The
// auth negatives are exercised on one representative route (project-context) since all four routes
// share the exact same authenticateGrowthAgentRequest entry point.

async function createOnboardedGrowthProject() {
  const projectKeys = await createGrowthProject();
  if (projectKeys === "no-project") {
    throw new Error("createGrowthProject should have switched to a real project.");
  }
  const onboardingResponse = await niceBackendFetch("/api/latest/internal/growth/onboarding", {
    method: "POST",
    accessType: "admin",
    body: {
      website_url: "https://example.com",
      company_summary: "An example company.",
      additional_notes: "Focus on self-serve adoption and avoid paid acquisition recommendations.",
    },
  });
  if (onboardingResponse.status !== 200) {
    throw new Error(`Growth onboarding failed: ${JSON.stringify(onboardingResponse.body)}`);
  }
  return { projectId: projectKeys.projectId, branchId: projectKeys.branchId ?? "main" };
}

describe("growth-agent read route auth", { timeout: 90_000 }, () => {
  it("rejects missing header, wrong secret, unknown project, and growth-disabled project", async ({ expect }) => {
    const { projectId, branchId } = await createOnboardedGrowthProject();
    const contextUrl = `${BASE_PATH}/project-context`;

    const missingHeader = await niceBackendFetch(contextUrl, {
      method: "GET",
      query: { project_id: projectId, branch_id: branchId },
    });
    expect(missingHeader.status).toBe(401);

    const wrongSecret = await niceBackendFetch(contextUrl, {
      method: "GET",
      headers: { "authorization": "Bearer definitely-not-the-secret" },
      query: { project_id: projectId, branch_id: branchId },
    });
    expect(wrongSecret.status).toBe(401);

    const unknownProject = await niceBackendFetch(contextUrl, {
      method: "GET",
      headers: GROWTH_AGENT_AUTH,
      query: { project_id: "00000000-0000-0000-0000-000000000000", branch_id: branchId },
    });
    expect(unknownProject.status).toBe(404);

    // A project without the growth app enabled: valid secret, valid project, but the app gate rejects.
    await Project.createAndSwitch();
    const disabledProjectKeys = backendContext.value.projectKeys;
    if (disabledProjectKeys === "no-project") {
      throw new Error("Project.createAndSwitch should have switched to a real project.");
    }
    const disabled = await niceBackendFetch(contextUrl, {
      method: "GET",
      headers: GROWTH_AGENT_AUTH,
      query: { project_id: disabledProjectKeys.projectId, branch_id: disabledProjectKeys.branchId ?? "main" },
    });
    expect(disabled.status).toBe(400);
  });
});

describe("growth-agent project-context", { timeout: 90_000 }, () => {
  it("returns the project context right after onboarding", async ({ expect }) => {
    const { projectId, branchId } = await createOnboardedGrowthProject();
    const response = await niceBackendFetch(`${BASE_PATH}/project-context`, {
      method: "GET",
      headers: GROWTH_AGENT_AUTH,
      query: { project_id: projectId, branch_id: branchId },
    });
    expect(response.status).toBe(200);
    // Project id, display name, and the latest run id are per-test-run values, so the deterministic
    // parts are asserted with toMatchObject instead of an inline snapshot.
    expect(response.body).toMatchObject({
      project: {
        id: projectId,
        display_name: expect.any(String),
      },
      onboarding: {
        website_url: "https://example.com/",
        company_summary: "An example company.",
        additional_notes: "Focus on self-serve adoption and avoid paid acquisition recommendations.",
      },
      domains: [],
      enabled_apps: expect.arrayContaining(["gtm"]),
      user_count: 0,
      latest_run: {
        id: expect.any(String),
        // Onboarding starts the initial analysis run, which nothing advances in this test (the
        // workflow engine is never ticked here).
        status: "pending",
        trigger: "initial",
      },
    });
  });
});

describe("growth-agent context-bundle", { timeout: 90_000 }, () => {
  it("returns the empty-state bundle on a freshly onboarded project", async ({ expect }) => {
    const { projectId, branchId } = await createOnboardedGrowthProject();
    const response = await niceBackendFetch(`${BASE_PATH}/context-bundle`, {
      method: "GET",
      headers: GROWTH_AGENT_AUTH,
      query: { project_id: projectId, branch_id: branchId },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "active_actions": [],
          "artifacts": [],
          "daily_metrics": [],
          "findings": [],
          "interview_answers": [],
          "onboarding": {
            "additional_notes": "Focus on self-serve adoption and avoid paid acquisition recommendations.",
            "company_summary": "An example company.",
            "website_url": "https://example.com/",
          },
          "recent_briefs": [],
          "report_summary": null,
          "truncated": false,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });
});

describe("growth-agent metrics", { timeout: 90_000 }, () => {
  it("returns all six metrics with 30-day daily series", async ({ expect }) => {
    const { projectId, branchId } = await createOnboardedGrowthProject();
    const response = await niceBackendFetch(`${BASE_PATH}/metrics`, {
      method: "GET",
      headers: GROWTH_AGENT_AUTH,
      query: { project_id: projectId, branch_id: branchId },
    });
    expect(response.status).toBe(200);
    // Metric values depend on the shared analytics/DB state, so only the shape is asserted.
    const metricIds = ["new_signups", "returning_users", "transactions", "emails_sent", "total_users", "revenue"] as const;
    expect(response.body).toMatchObject({
      metrics: Object.fromEntries(metricIds.map((metricId) => [metricId, expect.any(Number)])),
      computed_at_millis: expect.any(Number),
    });
    // NiceResponse.body is `any`, so this annotation just documents the expected shape.
    const dailySeries: Record<string, { date: string, value: number }[]> = response.body.daily_series;
    for (const metricId of metricIds) {
      expect(dailySeries[metricId]).toHaveLength(30);
      for (const point of dailySeries[metricId]) {
        expect(point).toMatchObject({ date: expect.any(String), value: expect.any(Number) });
      }
    }
  });
});

// sql-query executes against the external analytics ClickHouse. No existing e2e suite seeds
// ClickHouse deterministically enough for content assertions (analytics-query.test.ts runs queries
// but only through the customer-facing /analytics/query endpoint against whatever the dev
// ClickHouse contains), so this suite covers sql-query's auth behavior and the always-valid trivial
// query; row contents are intentionally not asserted.
describe("growth-agent sql-query", { timeout: 90_000 }, () => {
  it("rejects bad auth and answers a trivial query", async ({ expect }) => {
    const { projectId, branchId } = await createOnboardedGrowthProject();

    const missingHeader = await niceBackendFetch(`${BASE_PATH}/sql-query`, {
      method: "POST",
      body: { project_id: projectId, branch_id: branchId, query: "SELECT 1 AS one" },
    });
    expect(missingHeader.status).toBe(401);

    const wrongSecret = await niceBackendFetch(`${BASE_PATH}/sql-query`, {
      method: "POST",
      headers: { "authorization": "Bearer definitely-not-the-secret" },
      body: { project_id: projectId, branch_id: branchId, query: "SELECT 1 AS one" },
    });
    expect(wrongSecret.status).toBe(401);

    const trivial = await niceBackendFetch(`${BASE_PATH}/sql-query`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: { project_id: projectId, branch_id: branchId, query: "SELECT 1 AS one" },
    });
    expect(trivial).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "row_count": 1,
          "rows": [{ "one": 1 }],
          "success": true,
          "total_rows": 1,
          "truncated": false,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);

    // Query errors come back as success: false with a 200 — they are agent feedback, not HTTP errors.
    const broken = await niceBackendFetch(`${BASE_PATH}/sql-query`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: { project_id: projectId, branch_id: branchId, query: "SELECT definitely_not_a_column FROM nowhere" },
    });
    expect(broken.status).toBe(200);
    expect(broken.body).toMatchObject({ success: false, error: expect.any(String) });
  });
});
