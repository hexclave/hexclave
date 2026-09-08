import { urlString } from "@hexclave/shared/dist/utils/urls";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { describe } from "vitest";
import { it } from "../../../../../../helpers";
import { Auth, INTERNAL_PROJECT_OWNER_TEAM_ID, InternalProjectKeys, Project, Team, backendContext, niceBackendFetch } from "../../../../../backend-helpers";
import { GROWTH_AGENT_AUTH, asGrowthStaff, createGrowthProject } from "./growth-helpers";
import { withInternalDatabase } from "../../external-db-sync-utils";

const ADMIN_BASE = "/api/latest/internal/growth/admin";
const GROWTH_BASE = "/api/latest/internal/growth";
const AGENT_BASE = "/api/latest/internal/growth-agent";
const GROWTH_ANALYSIS_ACTIVATED_EVENT_TYPE = "custom.growth.analysis-run-activated";

// Growth fixtures seed sandbox-backed workflows during onboarding and can land around 60s under
// full-suite load, so default-timeout tests need 90s of headroom.

async function signInAsInternalAdmin(): Promise<void> {
  backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
  const { userId } = await Auth.fastSignUp();
  await Team.addMember(INTERNAL_PROJECT_OWNER_TEAM_ID, userId);
}

async function createOnboardedProjectWithAction() {
  const keys = await createGrowthProject();
  if (keys === "no-project") throw new Error("Growth admin test requires a fresh project.");
  const onboarding = await niceBackendFetch(`${GROWTH_BASE}/onboarding`, {
    accessType: "admin",
    method: "POST",
    body: { website_url: "https://admin-overview.example.com", company_summary: "Growth admin fixture" },
  });
  if (onboarding.status !== 200) throw new Error(`Growth onboarding failed with ${onboarding.status}.`);
  const scope = { project_id: keys.projectId, branch_id: "main" };
  const action = await niceBackendFetch(`${AGENT_BASE}/action-items`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: { ...scope, type_id: "custom", category: "conversion", tags: ["initial"], title: "Original proposal", description: "Original description" },
  });
  if (action.status !== 200) throw new Error(`Growth action creation failed with ${action.status}.`);
  return { projectId: keys.projectId, actionId: (action.body as { action_item_id: string }).action_item_id };
}

type ActionUpdateOverrides = Partial<{
  type_id: string,
  category: string,
  tags: string[],
  title: string,
  description: string,
  status: string,
  payload: unknown,
  watched_metrics: { metric_id: string, window_days: number }[],
}>;

function actionUpdateBody(projectId: string, overrides: ActionUpdateOverrides = {}) {
  return {
    target_project_id: projectId,
    type_id: "custom",
    category: "conversion",
    tags: ["admin-edited"],
    title: "Edited proposal",
    description: "Edited description",
    status: "proposed",
    ...overrides,
  };
}

describe("internal Growth admin", { timeout: 90_000 }, () => {
  it("requires an internal platform admin", async ({ expect }) => {
    backendContext.set({ projectKeys: InternalProjectKeys, userAuth: null });
    expect((await niceBackendFetch(`${ADMIN_BASE}/projects`, { accessType: "client" })).status).toBe(401);

    await createGrowthProject();
    await Auth.fastSignUp();
    const customerRequest = await niceBackendFetch(`${ADMIN_BASE}/projects`, { accessType: "client" });
    expect(customerRequest.status).toBe(401);
    expect(customerRequest.body).toMatchObject({ code: "EXPECTED_INTERNAL_PROJECT" });
  });

  it("requires the selected project for manual scheduler actions", async ({ expect }) => {
    await signInAsInternalAdmin();
    const response = await niceBackendFetch(`${ADMIN_BASE}/run-now`, {
      accessType: "client",
      method: "POST",
      body: { step: "analysis_tick" },
    });
    expect(response.status).toBe(400);
  });

  it("reports stage prerequisites and performs no work for a blocked future stage", async ({ expect }) => {
    const project = await Project.createAndSwitch();
    try {
      await Project.updateConfig({ "apps.installed.gtm.enabled": true });
      // This endpoint test only needs the durable prerequisite row. Inserting that row directly keeps
      // the test focused and avoids spending up to a minute compiling the sandbox-backed workflows
      // that the onboarding endpoint seeds (that behavior is covered by lifecycle.test.ts).
      await withInternalDatabase(async (client) => {
        await client.query(`
          INSERT INTO "GrowthOnboarding" ("projectId", "branchId", "websiteUrl", "companySummary", "createdAt", "updatedAt", "completedAt")
          VALUES ($1, 'main', 'https://admin-stage-run.example.com/', 'Growth admin stage-run fixture', NOW(), NOW(), NOW())
        `, [project.projectId]);
      });
      await asGrowthStaff(async () => {
        const setup = await niceBackendFetch(`${ADMIN_BASE}/run-now`, {
          accessType: "client",
          method: "POST",
          body: { step: "lifecycle_stage_state", target_project_id: project.projectId, stage: "set-up" },
        });
        expect(setup).toMatchObject({
          status: 200,
          body: { stage: "set-up", state: "complete", can_run: false },
        });

        const report = await niceBackendFetch(`${ADMIN_BASE}/run-now`, {
          accessType: "client",
          method: "POST",
          body: { step: "lifecycle_stage", target_project_id: project.projectId, stage: "report" },
        });
        expect(report).toMatchObject({
          status: 200,
          body: { stage: "report", state: "blocked", can_run: false, did_work: false, leg_started: null },
        });
      });
    } finally {
      await Project.deleteProject({ projectId: project.projectId, adminAccessToken: project.adminAccessToken });
    }
  });

  it("deduplicates concurrent repairs for the same growth run", { timeout: 180_000 }, async ({ expect }) => {
    const keys = await createGrowthProject();
    if (keys === "no-project") throw new Error("Growth admin test requires a fresh project.");
    const onboarding = await niceBackendFetch(urlString`/api/latest/internal/growth/onboarding`, {
      accessType: "admin",
      method: "POST",
      body: { website_url: "https://admin-recovery-race.example.com", company_summary: "Growth admin recovery race fixture" },
    });
    expect(onboarding.status).toBe(200);
    await signInAsInternalAdmin();

    const fixture = await withInternalDatabase(async (client) => {
      const runResult = await client.query<{ tenancyId: string, runId: string }>(`
        SELECT t."id" AS "tenancyId", r."id" AS "runId"
        FROM "Tenancy" t
        JOIN "GrowthAnalysisRun" r ON r."projectId" = t."projectId" AND r."branchId" = t."branchId"
        WHERE t."projectId" = $1 AND t."branchId" = 'main'
        ORDER BY r."createdAt" DESC, r."id" DESC
        LIMIT 1
      `, [keys.projectId]);
      const run = runResult.rows.at(0);
      if (run == null) throw new Error("Growth admin test did not create an analysis run.");

      await client.query(`
        DELETE FROM "WorkflowEvent"
        WHERE "tenancyId" = $1 AND "type" = $2 AND "payload"->>'growth_run_id' = $3
      `, [run.tenancyId, GROWTH_ANALYSIS_ACTIVATED_EVENT_TYPE, run.runId]);
      await client.query(`
        DELETE FROM "WorkflowRun"
        WHERE "tenancyId" = $1 AND "workflowId" = 'growth-analysis' AND "runKey" LIKE $2
      `, [run.tenancyId, `${run.runId}:%`]);
      return run;
    });

    const responses = await Promise.all([
      niceBackendFetch(urlString`/api/latest/internal/growth/admin/run-now`, {
        accessType: "client",
        method: "POST",
        body: { step: "project_recovery", target_project_id: keys.projectId },
      }),
      niceBackendFetch(urlString`/api/latest/internal/growth/admin/run-now`, {
        accessType: "client",
        method: "POST",
        body: { step: "project_recovery", target_project_id: keys.projectId },
      }),
    ]);
    expect(responses).toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);

    const eventCount = await withInternalDatabase(async (client) => {
      const result = await client.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count
        FROM "WorkflowEvent"
        WHERE "tenancyId" = $1 AND "type" = $2 AND "payload"->>'growth_run_id' = $3
      `, [fixture.tenancyId, GROWTH_ANALYSIS_ACTIVATED_EVENT_TYPE, fixture.runId]);
      return result.rows.at(0)?.count ?? throwErr("Growth admin test did not return an event count.");
    });
    expect(eventCount).toBe(1);
  });

  it("edits customer-visible Growth data without bypassing action lifecycle rules", async ({ expect }) => {
    const { projectId, actionId } = await createOnboardedProjectWithAction();
    await signInAsInternalAdmin();

    const projects = await niceBackendFetch(`${ADMIN_BASE}/projects`, { accessType: "client" });
    expect(projects.status).toBe(200);
    expect(projects.body).toEqual(expect.arrayContaining([expect.objectContaining({
      id: projectId,
      website_url: "https://admin-overview.example.com/",
      company_summary: "Growth admin fixture",
    })]));

    const note = await niceBackendFetch(`${ADMIN_BASE}/findings`, {
      accessType: "client",
      method: "POST",
      body: { target_project_id: projectId, kind: "ignored-for-notes", note: true, category: "revenue", tags: ["Pricing", " pricing "], title: "Pricing note", body: "Keep the annual plan visible." },
    });
    expect(note.status).toBe(201);
    const score = await niceBackendFetch(`${ADMIN_BASE}/category-scores`, {
      accessType: "client",
      method: "PUT",
      body: { target_project_id: projectId, category: "revenue", score: 73 },
    });
    expect(score).toMatchObject({ status: 200, body: { category: "revenue", score: 73 } });

    const edited = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}`, {
      accessType: "client",
      method: "PATCH",
      body: actionUpdateBody(projectId, {
        payload: { experiment: "onboarding" },
        watched_metrics: [{ metric_id: "new_signups", window_days: 21 }],
      }),
    });
    expect(edited).toMatchObject({
      status: 200,
      body: {
        id: actionId,
        title: "Edited proposal",
        tags: ["admin-edited"],
        payload: { experiment: "onboarding" },
        watched_metrics: [{ metric_id: "new_signups", window_days: 21 }],
      },
    });

    const invalidCompleted = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}`, {
      accessType: "client",
      method: "PATCH",
      body: actionUpdateBody(projectId, { title: "Must not persist", status: "completed" }),
    });
    expect(invalidCompleted.status).toBe(400);

    const overview = await niceBackendFetch(`${ADMIN_BASE}/overview?project_id=${projectId}`, { accessType: "client" });
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      notes: [expect.objectContaining({ source: "admin", kind: "note", category: "revenue", tags: ["pricing"], title: "Pricing note" })],
      actions: [expect.objectContaining({ id: actionId, title: "Edited proposal" })],
    });
    const revenue = (overview.body as { categories: { category: string, score: number | null }[] }).categories.find((category) => category.category === "revenue");
    expect(revenue?.score).toBe(73);

    const activated = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}`, {
      accessType: "client",
      method: "PATCH",
      body: actionUpdateBody(projectId, { status: "active" }),
    });
    expect(activated).toMatchObject({ status: 200, body: { status: "active" } });

    const invalidFunctionalEdit = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}`, {
      accessType: "client",
      method: "PATCH",
      body: actionUpdateBody(projectId, { status: "active", payload: { experiment: "changed-after-activation" } }),
    });
    expect(invalidFunctionalEdit.status).toBe(400);
  });

  it("keeps action-page edits private until an admin publishes the compiled draft", async ({ expect }) => {
    const { projectId, actionId } = await createOnboardedProjectWithAction();
    await signInAsInternalAdmin();

    const initial = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}?project_id=${projectId}`, { accessType: "client" });
    expect(initial).toMatchObject({ status: 200, body: { action: { id: actionId, document: null }, draft: null, published_at_millis: null } });

    const sourceMdx = "## Why this matters\n\n<Hypothesis confidence=\"high\">\n\nA shorter first run will increase activation.\n\n</Hypothesis>";
    const saved = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        document: { format: "growth-mdx-v1", source_mdx: sourceMdx, data: [] },
        expected_draft_updated_at_millis: null,
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ document: { format: "growth-mdx-v1", sourceMdx }, source_json: { source_mdx: sourceMdx } });
    const draftUpdatedAtMillis = (saved.body as { updated_at_millis: number }).updated_at_millis;

    // Saving a draft must not mutate the live action document.
    const beforePublish = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}?project_id=${projectId}`, { accessType: "client" });
    expect(beforePublish.body).toMatchObject({ action: { document: null }, draft: { updated_at_millis: draftUpdatedAtMillis } });

    const staleSave = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        document: { format: "growth-mdx-v1", source_mdx: "## Stale overwrite", data: [] },
        expected_draft_updated_at_millis: null,
      },
    });
    expect(staleSave.status).toBe(409);

    const published = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}`, {
      accessType: "client",
      method: "POST",
      body: { target_project_id: projectId, expected_draft_updated_at_millis: draftUpdatedAtMillis },
    });
    expect(published).toMatchObject({ status: 200, body: { status: "published", published_at_millis: expect.any(Number) } });

    const afterPublish = await niceBackendFetch(`${ADMIN_BASE}/actions/${actionId}?project_id=${projectId}`, { accessType: "client" });
    expect(afterPublish.body).toMatchObject({ action: { document: { format: "growth-mdx-v1", sourceMdx } }, draft: null, published_at_millis: expect.any(Number) });
  });

  it("keeps evidence and note page edits private until an admin publishes the compiled draft", async ({ expect }) => {
    const { projectId } = await createOnboardedProjectWithAction();
    const created = await niceBackendFetch(`${AGENT_BASE}/findings`, {
      method: "POST",
      headers: GROWTH_AGENT_AUTH,
      body: {
        project_id: projectId,
        branch_id: "main",
        source: "data-analysis",
        findings: [{
          kind: "data-insight",
          category: "retention",
          tags: ["sessions"],
          title: "Returning use is concentrated",
          body: "A small returning cohort accounts for most sessions.",
          document: {
            format: "growth-mdx-v1",
            source_mdx: "## Generated evidence\n\nThe returning cohort is small.",
            data: [],
          },
        }],
      },
    });
    expect(created.status).toBe(200);
    const findingId = await withInternalDatabase(async (client) => {
      const result = await client.query<{ id: string }>(`
        SELECT "id" FROM "GrowthFinding"
        WHERE "projectId" = $1 AND "branchId" = 'main' AND "title" = 'Returning use is concentrated'
        LIMIT 1
      `, [projectId]);
      return result.rows.at(0)?.id ?? throwErr("Growth evidence fixture was not created.");
    });
    await signInAsInternalAdmin();

    const initial = await niceBackendFetch(`${ADMIN_BASE}/findings/${findingId}/document?project_id=${projectId}`, { accessType: "client" });
    expect(initial).toMatchObject({
      status: 200,
      body: {
        finding: { id: findingId, document: { sourceMdx: "## Generated evidence\n\nThe returning cohort is small." } },
        draft: null,
        published_at_millis: null,
      },
    });

    const sourceMdx = "## Reviewed evidence\n\n<Evidence>\n\nReturning users account for most sessions.\n\n</Evidence>";
    const saved = await niceBackendFetch(`${ADMIN_BASE}/findings/${findingId}/document`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        document: { format: "growth-mdx-v1", source_mdx: sourceMdx, data: [] },
        expected_draft_updated_at_millis: null,
      },
    });
    expect(saved).toMatchObject({ status: 200, body: { source_json: { source_mdx: sourceMdx }, document: { sourceMdx } } });
    const draftUpdatedAtMillis = (saved.body as { updated_at_millis: number }).updated_at_millis;

    const beforePublish = await niceBackendFetch(`${ADMIN_BASE}/findings/${findingId}/document?project_id=${projectId}`, { accessType: "client" });
    expect(beforePublish.body).toMatchObject({
      finding: { document: { sourceMdx: "## Generated evidence\n\nThe returning cohort is small." } },
      draft: { document: { sourceMdx }, updated_at_millis: draftUpdatedAtMillis },
    });

    const staleSave = await niceBackendFetch(`${ADMIN_BASE}/findings/${findingId}/document`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        document: { format: "growth-mdx-v1", source_mdx: "## Stale overwrite", data: [] },
        expected_draft_updated_at_millis: null,
      },
    });
    expect(staleSave.status).toBe(409);

    const published = await niceBackendFetch(`${ADMIN_BASE}/findings/${findingId}/document`, {
      accessType: "client",
      method: "POST",
      body: { target_project_id: projectId, expected_draft_updated_at_millis: draftUpdatedAtMillis },
    });
    expect(published).toMatchObject({ status: 200, body: { status: "published", published_at_millis: expect.any(Number) } });

    const afterPublish = await niceBackendFetch(`${ADMIN_BASE}/findings/${findingId}/document?project_id=${projectId}`, { accessType: "client" });
    expect(afterPublish.body).toMatchObject({ finding: { document: { sourceMdx } }, draft: null, published_at_millis: expect.any(Number) });
  });
});
