import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { it } from "../../../../../../helpers";
import { Project, niceBackendFetch } from "../../../../../backend-helpers";
import { GROWTH_AGENT_AUTH, createGrowthProject, releaseGrowthReportAsStaff, requireRunId } from "./growth-helpers";

const ADMIN_BASE = "/api/latest/internal/growth";
const AGENT_BASE = "/api/latest/internal/growth-agent";

// Growth fixtures seed sandbox-backed workflows during onboarding and can land around 60s under
// full-suite load, so default-timeout tests need 90s of headroom.

// The admin report/action surface has no write API of its own — reports and action items only come
// into existence through the machine-facing growth-agent routes. So these tests seed by "playing
// the agent" (like agent-simulation.test.ts, and deliberately WITHOUT mock-eve: no engine, no
// dispatch — phases keep attempt 0) and then exercise the admin read/ack routes on top.

async function createGrowthProjectWithIds() {
  const projectKeys = await createGrowthProject();
  if (projectKeys === "no-project") {
    throw new Error("createGrowthProject should have switched the context to a fresh project.");
  }
  // Tests always run against the default branch.
  return { projectId: projectKeys.projectId, branchId: "main" };
}

async function completeOnboarding() {
  const onboarding = await niceBackendFetch(`${ADMIN_BASE}/onboarding`, {
    accessType: "admin",
    method: "POST",
    body: { website_url: "https://plannery.example.com", company_summary: "Project management for small teams." },
  });
  if (onboarding.status !== 200) {
    throw new Error(`Growth onboarding failed with status ${onboarding.status}.`);
  }
  return requireRunId(onboarding.body);
}

const REPORT_SECTIONS = [
  { id: "current-state", kind: "markdown", title: "Current state", body_markdown: "Steady signups, low activation." },
  { id: "opportunities", kind: "markdown", title: "Opportunities", body_markdown: "Paid search and comparison content." },
];

const REPORT_DOCUMENT = {
  format: "growth-mdx-v1",
  source_mdx: "## Activation opportunity\n\n<Metric data=\"activation\" />\n\n<Experiment>\n\nShow a four-step checklist in empty workspaces.\n\n</Experiment>",
  data: [{
    id: "activation",
    kind: "metric",
    title: "New workspaces creating a second project",
    unit: "percent",
    source: "Workspace events · last 30 days",
    takeaway: "The second-project step is the largest activation gap.",
    value: 59,
    comparison_label: "created a first project",
    comparison_value: 74,
  }],
};

/**
 * Plays the agent through a minimal full run: complete every phase, save + complete the interview,
 * then save the report with three action items (one per registered type). Returns the ids the
 * admin surface should observe.
 */
async function seedCompletedRunWithReport(scope: { project_id: string, branch_id: string }, runId: string) {
  const run = await niceBackendFetch(`${ADMIN_BASE}/runs/${runId}`, { accessType: "admin" });
  if (run.status !== 200) {
    throw new Error(`Reading the run failed with status ${run.status}.`);
  }
  const phaseKeys = (run.body as { phases: { phase_key: string }[] }).phases.map((phase) => phase.phase_key);
  for (const phaseKey of phaseKeys) {
    for (const action of ["start", "complete"]) {
      const response = await niceBackendFetch(`${AGENT_BASE}/runs/${runId}/phases/${phaseKey}/${action}`, {
        method: "POST",
        headers: GROWTH_AGENT_AUTH,
        body: { ...scope, attempt: 0 },
      });
      if (response.status !== 200) {
        throw new Error(`Phase ${phaseKey} ${action} failed with status ${response.status}.`);
      }
    }
  }

  const questions = await niceBackendFetch(`${AGENT_BASE}/interview-questions`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: {
      ...scope,
      run_id: runId,
      questions: [{
        question_key: "primary-goal",
        prompt: "What is your primary growth goal?",
        kind: "single",
        options: [{ id: "signups", label: "More signups" }, { id: "revenue", label: "More revenue" }],
      }],
    },
  });
  if (questions.status !== 200) {
    throw new Error(`Saving interview questions failed with status ${questions.status}.`);
  }
  const interviewComplete = await niceBackendFetch(`${AGENT_BASE}/interview/complete`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: { ...scope, run_id: runId },
  });
  if (interviewComplete.status !== 200) {
    throw new Error(`Completing the interview failed with status ${interviewComplete.status}.`);
  }

  const artifact = await niceBackendFetch(`${AGENT_BASE}/artifacts`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: { ...scope, run_id: runId, kind: "blog_draft", title: "Plannery vs incumbents", content: "# Draft\n\nFull post..." },
  });
  if (artifact.status !== 200) {
    throw new Error(`Saving the blog draft artifact failed with status ${artifact.status}.`);
  }
  const artifactId = (artifact.body as { artifact_id: string }).artifact_id;

  const report = await niceBackendFetch(`${AGENT_BASE}/report`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: {
      ...scope,
      run_id: runId,
      title: "Growth analysis for Plannery",
      summary: "Focus on paid acquisition and comparison content.",
      content_md: "# Report\n\nDetails...",
      document: REPORT_DOCUMENT,
      sections: REPORT_SECTIONS,
      action_items: [
        { type_id: "run_ads", category: "reach", tags: ["search"], title: "Launch a search ads campaign", description: "Target small agencies.", document: REPORT_DOCUMENT },
        {
          type_id: "publish_blog",
          category: "reach",
          tags: ["comparison"],
          title: "Publish an SEO comparison post",
          description: "Compare against incumbents.",
          payload: { artifact_id: artifactId },
          watched_metrics: [{ metric_id: "new_signups", window_days: 30 }],
        },
        { type_id: "custom", category: "retention", tags: ["win-back"], title: "Email churned users", description: "Win-back campaign." },
      ],
    },
  });
  if (report.status !== 200) {
    throw new Error(`Saving the report failed with status ${report.status}.`);
  }
  const reportId = (report.body as { report_id: string }).report_id;
  await releaseGrowthReportAsStaff(scope.project_id, reportId);
  return {
    reportId,
    actionItemIds: (report.body as { action_item_ids: string[] }).action_item_ids,
    artifactId,
  };
}

describe("internal growth reports and actions", { timeout: 90_000 }, () => {
  it("serves the report by id and as latest, with its action items", async ({ expect }) => {
    const { projectId, branchId } = await createGrowthProjectWithIds();
    const scope = { project_id: projectId, branch_id: branchId };
    const runId = await completeOnboarding();
    const { reportId, actionItemIds, artifactId } = await seedCompletedRunWithReport(scope, runId);

    // No report exists under the id "latest"-shaped lookup until we saved one — asserted implicitly
    // by the cross-project test below; here the saved content must round-trip exactly.
    const latest = await niceBackendFetch(`${ADMIN_BASE}/reports/latest`, { accessType: "admin" });
    expect(latest.status).toBe(200);
    expect(latest.body).toMatchObject({
      id: reportId,
      run_id: runId,
      title: "Growth analysis for Plannery",
      summary: "Focus on paid acquisition and comparison content.",
      content_md: "# Report\n\nDetails...",
      document: expect.objectContaining({ format: "growth-mdx-v1", sourceMdx: REPORT_DOCUMENT.source_mdx }),
      sections: REPORT_SECTIONS,
    });
    const actionItems = (latest.body as { action_items: { id: string, type_id: string, status: string, payload: unknown, watched_metrics: unknown, workflow: unknown, created_at_millis: number, activated_at_millis: number | null, completed_at_millis: number | null, report_id: string | null, brief_id: string | null }[] }).action_items;
    expect(actionItems).toHaveLength(3);
    expect(actionItems.map((item) => item.id).sort()).toEqual([...actionItemIds].sort());
    expect(actionItems.map((item) => item.type_id)).toEqual(["run_ads", "publish_blog", "custom"]);
    for (const item of actionItems) {
      expect(item).toMatchObject({
        status: "proposed",
        report_id: reportId,
        brief_id: null,
        activated_at_millis: null,
        completed_at_millis: null,
        // Plain items (no agent-authored automation attached) carry an explicit workflow: null;
        // the workflow-bearing wire shape is pinned in action-workflows.test.ts.
        workflow: null,
      });
      expect(typeof item.created_at_millis).toBe("number");
    }
    const publishBlog = actionItems[1];
    expect(publishBlog).toMatchObject({
      payload: { artifact_id: artifactId },
      watched_metrics: [{ metric_id: "new_signups", window_days: 30 }],
    });
    // run_ads without explicit watched_metrics falls back to the type registry's defaults.
    expect(actionItems[0]).toMatchObject({
      document: expect.objectContaining({ format: "growth-mdx-v1", sourceMdx: REPORT_DOCUMENT.source_mdx }),
      watched_metrics: [
        { metric_id: "new_signups", window_days: 14 },
        { metric_id: "total_users", window_days: 14 },
      ],
    });

    const byId = await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, { accessType: "admin" });
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: reportId });

    // Garbage ids must be a clean 404, not a database cast error.
    const garbageId = await niceBackendFetch(`${ADMIN_BASE}/reports/not-a-real-id`, { accessType: "admin" });
    expect(garbageId.status).toBe(404);

    // Another project (with the app enabled) must see neither the report by id nor any "latest".
    await createGrowthProjectWithIds();
    const crossProject = await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, { accessType: "admin" });
    expect(crossProject.status).toBe(404);
    const emptyLatest = await niceBackendFetch(`${ADMIN_BASE}/reports/latest`, { accessType: "admin" });
    expect(emptyLatest.status).toBe(404);
  });

  it("lists actions with status filter and cursor pagination", async ({ expect }) => {
    const { projectId, branchId } = await createGrowthProjectWithIds();
    const scope = { project_id: projectId, branch_id: branchId };
    const runId = await completeOnboarding();
    const { actionItemIds } = await seedCompletedRunWithReport(scope, runId);

    const list = await niceBackendFetch(`${ADMIN_BASE}/actions`, { accessType: "admin" });
    expect(list.status).toBe(200);
    const listBody = list.body as { items: { id: string }[], next_cursor: string | null };
    expect(listBody.items).toHaveLength(3);
    expect(listBody.next_cursor).toBeNull();
    expect(listBody.items.map((item) => item.id).sort()).toEqual([...actionItemIds].sort());

    const proposedOnly = await niceBackendFetch(`${ADMIN_BASE}/actions?status=proposed`, { accessType: "admin" });
    expect(proposedOnly.status).toBe(200);
    expect((proposedOnly.body as { items: unknown[] }).items).toHaveLength(3);
    const activeOnly = await niceBackendFetch(`${ADMIN_BASE}/actions?status=active`, { accessType: "admin" });
    expect(activeOnly.status).toBe(200);
    expect(activeOnly.body).toMatchObject({ items: [], next_cursor: null });
    const badStatus = await niceBackendFetch(`${ADMIN_BASE}/actions?status=made-up`, { accessType: "admin" });
    expect(badStatus.status).toBe(400);

    // Two pages of 2: the cursor from page one yields the remaining item, with no overlap.
    const pageOne = await niceBackendFetch(`${ADMIN_BASE}/actions?limit=2`, { accessType: "admin" });
    expect(pageOne.status).toBe(200);
    const pageOneBody = pageOne.body as { items: { id: string }[], next_cursor: string | null };
    expect(pageOneBody.items).toHaveLength(2);
    expect(typeof pageOneBody.next_cursor).toBe("string");
    const pageTwo = await niceBackendFetch(`${ADMIN_BASE}/actions?limit=2&cursor=${pageOneBody.next_cursor}`, { accessType: "admin" });
    expect(pageTwo.status).toBe(200);
    const pageTwoBody = pageTwo.body as { items: { id: string }[], next_cursor: string | null };
    expect(pageTwoBody.items).toHaveLength(1);
    expect(pageTwoBody.next_cursor).toBeNull();
    const allIds = [...pageOneBody.items, ...pageTwoBody.items].map((item) => item.id);
    expect(allIds.sort()).toEqual([...actionItemIds].sort());

    const badCursor = await niceBackendFetch(`${ADMIN_BASE}/actions?cursor=${randomUUID()}`, { accessType: "admin" });
    expect(badCursor.status).toBe(400);
  });

  it("activates and dismisses actions with idempotent acks", async ({ expect }) => {
    const { projectId, branchId } = await createGrowthProjectWithIds();
    const scope = { project_id: projectId, branch_id: branchId };
    const runId = await completeOnboarding();
    const { actionItemIds } = await seedCompletedRunWithReport(scope, runId);
    const [adsItemId, blogItemId, customItemId] = actionItemIds;

    // Activation captures a "before" metric snapshot via computeGrowthMetrics (analytics-backed) —
    // asserted only through the resulting state, never through metric values, so the test stays
    // independent of what the analytics store returns for a fresh project.
    const activate = await niceBackendFetch(`${ADMIN_BASE}/actions/${adsItemId}/activate`, { accessType: "admin", method: "POST" });
    expect(activate).toMatchObject({ status: 200, body: { status: "active" } });
    const activateAgain = await niceBackendFetch(`${ADMIN_BASE}/actions/${adsItemId}/activate`, { accessType: "admin", method: "POST" });
    expect(activateAgain).toMatchObject({ status: 200, body: { status: "active" } });

    const activeList = await niceBackendFetch(`${ADMIN_BASE}/actions?status=active`, { accessType: "admin" });
    expect(activeList.status).toBe(200);
    const activeItems = (activeList.body as { items: { id: string, status: string, activated_at_millis: number | null }[] }).items;
    expect(activeItems).toHaveLength(1);
    expect(activeItems[0]).toMatchObject({ id: adsItemId, status: "active" });
    expect(typeof activeItems[0].activated_at_millis).toBe("number");

    // Dismissal from proposed, idempotently.
    const dismiss = await niceBackendFetch(`${ADMIN_BASE}/actions/${customItemId}/dismiss`, { accessType: "admin", method: "POST" });
    expect(dismiss).toMatchObject({ status: 200, body: { status: "dismissed" } });
    const dismissAgain = await niceBackendFetch(`${ADMIN_BASE}/actions/${customItemId}/dismiss`, { accessType: "admin", method: "POST" });
    expect(dismissAgain).toMatchObject({ status: 200, body: { status: "dismissed" } });

    // A dismissed item can no longer be activated.
    const activateDismissed = await niceBackendFetch(`${ADMIN_BASE}/actions/${customItemId}/activate`, { accessType: "admin", method: "POST" });
    expect(activateDismissed.status).toBe(400);

    // An active item can still be dismissed (turning it off), and the status counts reflect it all.
    const dismissActive = await niceBackendFetch(`${ADMIN_BASE}/actions/${adsItemId}/dismiss`, { accessType: "admin", method: "POST" });
    expect(dismissActive).toMatchObject({ status: 200, body: { status: "dismissed" } });
    const finalStatus = await niceBackendFetch(`${ADMIN_BASE}/status`, { accessType: "admin" });
    expect(finalStatus.status).toBe(200);
    expect(finalStatus.body).toMatchObject({ counts: { suggested_actions: 1, active_actions: 0 } });

    // Unknown ids (and, via the same lookup, other projects' ids) are a uniform 404.
    const unknown = await niceBackendFetch(`${ADMIN_BASE}/actions/${randomUUID()}/activate`, { accessType: "admin", method: "POST" });
    expect(unknown.status).toBe(404);
    expect(blogItemId).toBeDefined(); // seeded but intentionally left proposed in this test
  });

  it("serves before/after metric series for unactivated and activated items", async ({ expect }) => {
    const { projectId, branchId } = await createGrowthProjectWithIds();
    const scope = { project_id: projectId, branch_id: branchId };
    const runId = await completeOnboarding();
    const { actionItemIds } = await seedCompletedRunWithReport(scope, runId);
    const [adsItemId, blogItemId] = actionItemIds;

    // Unactivated: a before-only preview from the daily rollups (none exist for a fresh project, so
    // the series are empty — "missing days simply absent") with null captured_at on both sides.
    const preview = await niceBackendFetch(`${ADMIN_BASE}/actions/${blogItemId}/metrics`, { accessType: "admin" });
    expect(preview).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "metrics": [
            {
              "after": [],
              "after_captured_at_millis": null,
              "before": [],
              "before_captured_at_millis": null,
              "metric_id": "new_signups",
              "window_days": 30,
            },
          ],
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);

    // Activated: the before snapshot exists, so before_captured_at_millis is set; there has been no
    // daily rollup since activation, so after stays empty and after_captured_at_millis null.
    const activate = await niceBackendFetch(`${ADMIN_BASE}/actions/${adsItemId}/activate`, { accessType: "admin", method: "POST" });
    expect(activate.status).toBe(200);
    const activated = await niceBackendFetch(`${ADMIN_BASE}/actions/${adsItemId}/metrics`, { accessType: "admin" });
    expect(activated.status).toBe(200);
    const activatedMetrics = (activated.body as { metrics: { metric_id: string, window_days: number, before: unknown[], after: unknown[], before_captured_at_millis: number | null, after_captured_at_millis: number | null }[] }).metrics;
    // run_ads has two default watched metrics.
    expect(activatedMetrics.map((series) => series.metric_id)).toEqual(["new_signups", "total_users"]);
    for (const series of activatedMetrics) {
      expect(series).toMatchObject({ window_days: 14, before: [], after: [], after_captured_at_millis: null });
      expect(typeof series.before_captured_at_millis).toBe("number");
    }

    const unknown = await niceBackendFetch(`${ADMIN_BASE}/actions/${randomUUID()}/metrics`, { accessType: "admin" });
    expect(unknown.status).toBe(404);
  });

  it("rejects non-admin access and projects without the growth app", async ({ expect }) => {
    const { projectId, branchId } = await createGrowthProjectWithIds();
    const scope = { project_id: projectId, branch_id: branchId };
    const runId = await completeOnboarding();
    const { reportId, actionItemIds } = await seedCompletedRunWithReport(scope, runId);
    const firstActionItemId = actionItemIds[0];

    const clientReport = await niceBackendFetch(`${ADMIN_BASE}/reports/latest`, { accessType: "client" });
    expect(clientReport.status).toBe(401);
    const clientActions = await niceBackendFetch(`${ADMIN_BASE}/actions`, { accessType: "client" });
    expect(clientActions.status).toBe(401);
    const clientActivate = await niceBackendFetch(`${ADMIN_BASE}/actions/${firstActionItemId}/activate`, { accessType: "client", method: "POST" });
    expect(clientActivate.status).toBe(401);

    // Disabling the app cuts off the whole surface, even for admins and existing data.
    await Project.updateConfig({ "apps.installed.gtm.enabled": false });
    const disabledReport = await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, { accessType: "admin" });
    expect(disabledReport.status).toBe(400);
    const disabledActions = await niceBackendFetch(`${ADMIN_BASE}/actions`, { accessType: "admin" });
    expect(disabledActions.status).toBe(400);
    const disabledMetrics = await niceBackendFetch(`${ADMIN_BASE}/actions/${firstActionItemId}/metrics`, { accessType: "admin" });
    expect(disabledMetrics.status).toBe(400);
  });
});
