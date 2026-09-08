import { describe } from "vitest";
import { it } from "../../../../../../helpers";
import { Auth, InternalProjectKeys, backendContext, niceBackendFetch } from "../../../../../backend-helpers";
import { GROWTH_AGENT_AUTH, asGrowthStaff, createGrowthProject, requireRunId } from "./growth-helpers";

const GROWTH_BASE = "/api/latest/internal/growth";
const ADMIN_BASE = "/api/latest/internal/growth/admin";
const AGENT_BASE = "/api/latest/internal/growth-agent";

// Growth fixtures seed sandbox-backed workflows during onboarding and can land around 60s under
// full-suite load, so default-timeout tests need 90s of headroom.

/**
 * What a customer may read, and when. Writing a report creates a staff-only draft. The workspace
 * remains dark until staff explicitly release that report; unpublishing closes it again.
 *
 * Seeding "plays the agent" with the shared machine secret, the way report-actions.test.ts does:
 * reports have no customer-facing write API, so that is the only way one comes into existence.
 */

async function seedProjectWithoutReport() {
  const keys = await createGrowthProject();
  if (keys === "no-project") throw new Error("The release-gate test requires a fresh project.");

  const onboarding = await niceBackendFetch(`${GROWTH_BASE}/onboarding`, {
    accessType: "admin",
    method: "POST",
    body: { website_url: "https://release-gate.example.com", company_summary: "Release gate fixture" },
  });
  if (onboarding.status !== 200) throw new Error(`Growth onboarding failed with ${onboarding.status}.`);
  return { projectId: keys.projectId, scope: { project_id: keys.projectId, branch_id: "main" }, runId: requireRunId(onboarding.body) };
}

async function seedReport() {
  const { projectId, scope, runId } = await seedProjectWithoutReport();
  const report = await niceBackendFetch(`${AGENT_BASE}/report`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: {
      ...scope,
      run_id: runId,
      title: "Growth analysis for the fixture",
      summary: "Everything the customer may now see.",
      content_md: "# Review\n\nHeld until staff release.",
      action_items: [
        { type_id: "custom", category: "conversion", tags: [], title: "A suggestion", description: "Also live." },
      ],
    },
  });
  if (report.status !== 200) throw new Error(`Saving the report failed with ${report.status}.`);
  return { projectId, scope, reportId: (report.body as { report_id: string }).report_id };
}

async function publishReport(projectId: string, reportId: string) {
  return await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, {
    accessType: "client",
    method: "PATCH",
    body: { target_project_id: projectId, action: "publish" },
  }));
}

describe("internal Growth report release", { timeout: 90_000 }, () => {
  it("withholds the whole workspace from the customer until a report exists", { timeout: 300_000 }, async ({ expect }) => {
    await seedProjectWithoutReport();

    // Every surface that could reveal what an unwritten report would say. The overview carries the
    // insights and category scores; actions ARE the suggestions; briefs and chat both speak from the
    // same findings.
    for (const path of [
      `${GROWTH_BASE}/overview`,
      `${GROWTH_BASE}/metrics-overview`,
      `${GROWTH_BASE}/actions`,
      `${GROWTH_BASE}/briefs`,
      `${GROWTH_BASE}/chat/conversations`,
    ]) {
      const response = await niceBackendFetch(path, { accessType: "admin" });
      expect([path, response.status]).toEqual([path, 409]);
      expect([path, response.body]).toEqual([path, "Your growth report is still being prepared."]);
    }

    // The report itself 404s rather than 409s: to the customer a report that does not exist yet and
    // one that was pulled back are the same thing, and neither is a state they can act on.
    const missing = await niceBackendFetch(`${GROWTH_BASE}/reports/latest`, { accessType: "admin" });
    expect(missing.status).toBe(404);
  });

  it("keeps the status endpoint open, reporting the wait rather than a report", { timeout: 300_000 }, async ({ expect }) => {
    await seedProjectWithoutReport();
    // Status must stay reachable — it is what drives the lifecycle timeline, so locking it would
    // leave the customer with a blank page instead of an explanation. `not_ready` rather than
    // `preparing` because onboarding leaves every analysis phase pending (see lifecycle.test.ts);
    // the hold only begins once deep analysis actually starts.
    const status = await niceBackendFetch(`${GROWTH_BASE}/status`, { accessType: "admin" });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ latest_report: null, latest_brief: null, release: { state: "not_ready" } });
  });

  it("keeps a generated report private until staff release it", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId, reportId } = await seedReport();

    const heldStatus = await niceBackendFetch(`${GROWTH_BASE}/status`, { accessType: "admin" });
    expect(heldStatus.body).toMatchObject({ latest_report: null });
    expect((await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" })).status).toBe(409);
    expect((await niceBackendFetch(`${GROWTH_BASE}/reports/latest`, { accessType: "admin" })).status).toBe(404);

    const published = await publishReport(projectId, reportId);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ reports: [{ id: reportId, published_at_millis: expect.any(Number), published_by_user_id: expect.any(String) }] });

    const status = await niceBackendFetch(`${GROWTH_BASE}/status`, { accessType: "admin" });
    expect(status.body).toMatchObject({ release: { state: "released" }, latest_report: { id: reportId, read_at_millis: null } });

    for (const path of [`${GROWTH_BASE}/overview`, `${GROWTH_BASE}/actions`, `${GROWTH_BASE}/briefs`]) {
      const response = await niceBackendFetch(path, { accessType: "admin" });
      expect([path, response.status]).toEqual([path, 200]);
    }

    const report = await niceBackendFetch(`${GROWTH_BASE}/reports/latest`, { accessType: "admin" });
    expect(report).toMatchObject({ status: 200, body: { id: reportId, title: "Growth analysis for the fixture" } });
  });

  it("marks a report read once and exposes the receipt on status", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId, reportId } = await seedReport();
    expect((await publishReport(projectId, reportId)).status).toBe(200);

    // A malformed id is a clean 404 from the receipt endpoint too, never a Postgres cast error.
    const malformed = await niceBackendFetch(`${GROWTH_BASE}/reports/not-a-uuid/read`, { accessType: "admin", method: "POST" });
    expect(malformed.status).toBe(404);

    const first = await niceBackendFetch(`${GROWTH_BASE}/reports/${reportId}/read`, { accessType: "admin", method: "POST" });
    expect(first).toMatchObject({ status: 200, body: { id: reportId } });
    const afterFirst = await niceBackendFetch(`${GROWTH_BASE}/status`, { accessType: "admin" });
    const firstReadAt = (afterFirst.body as { latest_report: { read_at_millis: number | null } }).latest_report.read_at_millis;
    expect(firstReadAt).toEqual(expect.any(Number));

    // Opening the report in another tab is idempotent and preserves the original first-read time.
    const second = await niceBackendFetch(`${GROWTH_BASE}/reports/${reportId}/read`, { accessType: "admin", method: "POST" });
    expect(second).toMatchObject({ status: 200, body: { id: reportId } });
    const afterSecond = await niceBackendFetch(`${GROWTH_BASE}/status`, { accessType: "admin" });
    expect((afterSecond.body as { latest_report: { read_at_millis: number | null } }).latest_report.read_at_millis).toBe(firstReadAt);
  });

  it("takes a report back out of the customer's hands when staff unpublish", async ({ expect }) => {
    const { projectId, reportId } = await seedReport();
    expect((await publishReport(projectId, reportId)).status).toBe(200);

    const unpublished = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, {
      accessType: "client",
      method: "PATCH",
      body: { target_project_id: projectId, action: "unpublish" },
    }));
    expect(unpublished.status).toBe(200);
    expect(unpublished.body).toMatchObject({ reports: [{ id: reportId, published_at_millis: null }] });

    // An unpublished report is gone for the customer, not merely missing from one response.
    const gone = await niceBackendFetch(`${GROWTH_BASE}/reports/${reportId}`, { accessType: "admin" });
    expect(gone.status).toBe(404);
    const overview = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(overview.status).toBe(409);

    // Unpublishing what is not published is a stale second tab — 409, not 500.
    const again = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, {
      accessType: "client",
      method: "PATCH",
      body: { target_project_id: projectId, action: "unpublish" },
    }));
    expect(again.status).toBe(409);
  });

  it("rejects releasing the same report twice", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId, reportId } = await seedReport();
    expect((await publishReport(projectId, reportId)).status).toBe(200);
    expect((await publishReport(projectId, reportId)).status).toBe(409);
  });

  it("lets staff edit a held report as growth MDX and serves the compiled result after release", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId, reportId } = await seedReport();
    const detailBefore = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}?project_id=${projectId}`, { accessType: "client" }));
    const actionId = (detailBefore.body as { action_items: { id: string }[] }).action_items[0]?.id;
    if (actionId == null) throw new Error("The report editor fixture requires its seeded action.");

    const saved = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        document: {
          format: "growth-mdx-v1",
          source_mdx: `## Staff-edited analysis\n\nThe reviewed conclusion.\n\n<ActionButton action="${actionId}" />`,
          data: [],
        },
      },
    }));
    expect(saved).toMatchObject({
      status: 200,
      body: {
        id: reportId,
        document: {
          format: "growth-mdx-v1",
          sourceMdx: expect.stringContaining("Staff-edited analysis"),
        },
      },
    });

    const foreignAction = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        document: {
          format: "growth-mdx-v1",
          source_mdx: "<ActionButton action=\"00000000-0000-4000-8000-000000000000\" />",
          data: [],
        },
      },
    }));
    expect(foreignAction.status).toBe(400);

    expect((await publishReport(projectId, reportId)).status).toBe(200);
    const customerReport = await niceBackendFetch(`${GROWTH_BASE}/reports/latest`, { accessType: "admin" });
    expect(customerReport).toMatchObject({
      status: 200,
      body: { document: { sourceMdx: expect.stringContaining("Staff-edited analysis") } },
    });

    const editWhileLive = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        document: { format: "growth-mdx-v1", source_mdx: "## Updated while live", data: [] },
      },
    }));
    expect(editWhileLive).toMatchObject({
      status: 200,
      body: {
        published_at_millis: expect.any(Number),
        document: { sourceMdx: "## Updated while live" },
      },
    });
    const updatedCustomerReport = await niceBackendFetch(`${GROWTH_BASE}/reports/latest`, { accessType: "admin" });
    expect(updatedCustomerReport).toMatchObject({
      status: 200,
      body: { document: { sourceMdx: "## Updated while live" } },
    });
  });

  it("shows staff every report, and refuses non-platform-admins entirely", { timeout: 300_000 }, async ({ expect }) => {
    const { projectId, reportId } = await seedReport();

    // A signed-in internal-project user who is NOT on the owner team: the internal publishable key is
    // public, so "signed into internal" must never be enough to read another company's report.
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    await Auth.fastSignUp();
    for (const [path, init] of [
      [`${ADMIN_BASE}/reports?project_id=${projectId}`, {}],
      [`${ADMIN_BASE}/reports/${reportId}?project_id=${projectId}`, {}],
      [`${ADMIN_BASE}/reports/${reportId}`, { method: "PATCH", body: { target_project_id: projectId, action: "publish" } }],
      [`${ADMIN_BASE}/reports/${reportId}`, { method: "PATCH", body: { target_project_id: projectId, action: "unpublish" } }],
      [`${ADMIN_BASE}/reports/${reportId}`, { method: "PUT", body: { target_project_id: projectId, document: { format: "growth-mdx-v1", source_mdx: "## Nope", data: [] } } }],
    ] as const) {
      const response = await niceBackendFetch(path, { accessType: "client", ...init });
      expect([path, response.status]).toEqual([path, 403]);
    }

    await asGrowthStaff(async () => {
      const list = await niceBackendFetch(`${ADMIN_BASE}/reports?project_id=${projectId}`, { accessType: "client" });
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({
        reports: [{ id: reportId, trigger: "initial", action_item_count: 1, published_by_user_id: null }],
      });
      expect((list.body as { reports: { published_at_millis: number | null }[] }).reports[0].published_at_millis).toBeNull();

      const detail = await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}?project_id=${projectId}`, { accessType: "client" });
      expect(detail).toMatchObject({
        status: 200,
        body: {
          id: reportId,
          title: "Growth analysis for the fixture",
          content_md: "# Review\n\nHeld until staff release.",
          action_items: [{ title: "A suggestion" }],
        },
      });

      // A malformed or foreign report id is a clean 404, never a Postgres cast error.
      const missing = await niceBackendFetch(`${ADMIN_BASE}/reports/not-a-uuid?project_id=${projectId}`, { accessType: "client" });
      expect(missing.status).toBe(404);
    });
  });
});
