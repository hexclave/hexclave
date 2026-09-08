import { describe } from "vitest";
import { it } from "../../../../../../helpers";
import { niceBackendFetch } from "../../../../../backend-helpers";
import { GROWTH_AGENT_AUTH, asGrowthStaff, createGrowthProject, unlockGrowthWorkspaceAsStaff } from "./growth-helpers";

const ADMIN_BASE = "/api/latest/internal/growth/admin";
const GROWTH_BASE = "/api/latest/internal/growth";
const AGENT_BASE = "/api/latest/internal/growth-agent";
const CATEGORIES = ["product", "reach", "conversion", "retention", "revenue"] as const;

// Growth fixtures seed sandbox-backed workflows during onboarding and can land around 60s under
// full-suite load, so default-timeout tests need 90s of headroom.

/** A project with a released workspace and one conversion action a stage page can link to. */
async function createFixture() {
  const keys = await createGrowthProject();
  if (keys === "no-project") throw new Error("The stage page test requires a fresh project.");
  const scope = { project_id: keys.projectId, branch_id: "main" };
  await unlockGrowthWorkspaceAsStaff(scope);
  const conversionAction = await niceBackendFetch(`${AGENT_BASE}/action-items`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: { ...scope, type_id: "custom", category: "conversion", tags: [], title: "Trim the signup form", description: "Three fields instead of seven." },
  });
  if (conversionAction.status !== 200) throw new Error(`Seeding the conversion action failed with ${conversionAction.status}.`);
  const retentionAction = await niceBackendFetch(`${AGENT_BASE}/action-items`, {
    method: "POST",
    headers: GROWTH_AGENT_AUTH,
    body: { ...scope, type_id: "custom", category: "retention", tags: [], title: "Win-back email", description: "For accounts idle 30 days." },
  });
  if (retentionAction.status !== 200) throw new Error(`Seeding the retention action failed with ${retentionAction.status}.`);
  return {
    projectId: keys.projectId,
    conversionActionId: (conversionAction.body as { action_item_id: string }).action_item_id,
    retentionActionId: (retentionAction.body as { action_item_id: string }).action_item_id,
  };
}

function documentWith(actionId: string) {
  return {
    format: "growth-mdx-v1",
    source_mdx: [
      "## Where signups are lost",
      "",
      "Most people who start the form never finish it.",
      "",
      `<ActionButton action="${actionId}" />`,
    ].join("\n"),
    data: [],
  };
}

function customerCategoryPages(body: unknown) {
  return (body as { category_pages: { category: string, version: number, actions: { id: string }[] }[] }).category_pages;
}

describe("internal Growth stage pages", { timeout: 90_000 }, () => {
  it("publishes a stage page to the customer workspace and takes it back down", async ({ expect }) => {
    const { projectId, conversionActionId } = await createFixture();

    const beforePublish = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(beforePublish.status).toBe(200);
    expect(customerCategoryPages(beforePublish.body)).toEqual([]);

    const saved = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        category: "conversion",
        document: documentWith(conversionActionId),
        source_action_ids: [conversionActionId],
        // No draft exists yet, and saying so is what makes the save fail if one appeared meanwhile.
        expected_draft_updated_at_millis: null,
      },
    }));
    expect(saved).toMatchObject({ status: 200, body: { category: "conversion", version: 1, status: "draft", stale_source_ids: [] } });

    // A draft is staff-only: the customer keeps seeing the raw lanes until someone publishes.
    const withDraft = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(customerCategoryPages(withDraft.body)).toEqual([]);

    const published = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages/publish`, {
      accessType: "client",
      method: "POST",
      body: { target_project_id: projectId, category: "conversion", version: 1 },
    }));
    expect(published).toMatchObject({ status: 200, body: { category: "conversion", version: 1, status: "published" } });

    const live = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(live.status).toBe(200);
    const pages = customerCategoryPages(live.body);
    expect(pages).toMatchObject([{ category: "conversion", version: 1 }]);
    // The customer receives the compiled document, not the authored source, and the action button is
    // a typed reference — never the action's payload or workflow.
    expect(live.body).toMatchObject({
      category_pages: [expect.objectContaining({
        document: expect.objectContaining({
          format: "growth-mdx-v1",
          blocks: expect.arrayContaining([expect.objectContaining({ type: "component", name: "ActionButton", actionId: conversionActionId })]),
        }),
      })],
    });

    // The page carries the actions its buttons reference. Without that, a button would only render
    // while its action happened to be inside the overview's capped suggestion/archive lanes — so a
    // dismissed one, or the 21st action in the stage, would silently become "no longer available".
    expect(pages[0]?.actions).toMatchObject([{ id: conversionActionId, title: "Trim the signup form" }]);
    const dismissed = await niceBackendFetch(`${GROWTH_BASE}/actions/${conversionActionId}/dismiss`, { accessType: "admin", method: "POST" });
    expect(dismissed.status).toBe(200);
    const afterDismiss = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(customerCategoryPages(afterDismiss.body)[0]?.actions).toMatchObject([{ id: conversionActionId, status: "dismissed" }]);

    const takenDown = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages/publish`, {
      accessType: "client",
      method: "DELETE",
      body: { target_project_id: projectId, category: "conversion" },
    }));
    expect(takenDown).toMatchObject({ status: 200, body: { status: "unpublished" } });

    const afterTakedown = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(customerCategoryPages(afterTakedown.body)).toEqual([]);
  });

  it("publishes all five stage drafts atomically", { timeout: 180_000 }, async ({ expect }) => {
    const { projectId } = await createFixture();
    const reportList = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports?project_id=${projectId}`, { accessType: "client" }));
    const reports = typeof reportList.body === "object" && reportList.body != null && "reports" in reportList.body && Array.isArray(reportList.body.reports)
      ? reportList.body.reports
      : [];
    const reportId = reports.find((report): report is { id: string } => typeof report === "object" && report != null && "id" in report && typeof report.id === "string")?.id;
    if (reportId == null) throw new Error("The atomic stage-page fixture created no report to release.");
    const unpublished = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/reports/${reportId}`, {
      accessType: "client",
      method: "PATCH",
      body: { target_project_id: projectId, action: "unpublish" },
    }));
    expect(unpublished.status).toBe(200);

    const drafts: { category: typeof CATEGORIES[number], version: number }[] = [];
    for (const category of CATEGORIES) {
      const saved = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages`, {
        accessType: "client",
        method: "PUT",
        body: {
          target_project_id: projectId,
          category,
          document: { format: "growth-mdx-v1", source_mdx: `## ${category} plan`, data: [] },
          expected_draft_updated_at_millis: null,
        },
      }));
      expect(saved).toMatchObject({ status: 200, body: { category, status: "draft" } });
      const version = typeof saved.body === "object" && saved.body != null && "version" in saved.body ? saved.body.version : null;
      if (typeof version !== "number") throw new Error(`Saving the ${category} draft returned no version.`);
      drafts.push({ category, version });
    }

    const staleRequest = drafts.map((draft) => draft.category === "conversion" ? { ...draft, version: draft.version + 100 } : draft);
    const rejected = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages/publish`, {
      accessType: "client",
      method: "PUT",
      body: { target_project_id: projectId, drafts: staleRequest, report_id: reportId },
    }));
    expect(rejected.status).toBe(409);
    const afterRejectedRelease = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    // The failed transaction leaves the first report behind the release gate, so the customer still
    // cannot open the workspace at all; this is stronger than merely returning no stage pages.
    expect(afterRejectedRelease.status).toBe(409);

    const published = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages/publish`, {
      accessType: "client",
      method: "PUT",
      body: { target_project_id: projectId, drafts, report_id: reportId },
    }));
    expect(published).toMatchObject({
      status: 200,
      body: { pages: CATEGORIES.map((category) => expect.objectContaining({ category, status: "published" })) },
    });
    const afterRelease = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(afterRelease.status).toBe(200);
    expect(customerCategoryPages(afterRelease.body).map((page) => page.category).sort()).toEqual([...CATEGORIES].sort());
    expect(afterRelease.body).toMatchObject({ latest_report: { id: reportId } });
  });

  it("carries a draft's referenced actions so staff can preview its buttons", async ({ expect }) => {
    const { projectId, conversionActionId } = await createFixture();

    const saved = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages`, {
      accessType: "client",
      method: "PUT",
      body: { target_project_id: projectId, category: "conversion", document: documentWith(conversionActionId), expected_draft_updated_at_millis: null },
    }));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ actions: [{ id: conversionActionId, title: "Trim the signup form" }] });

    // The staff preview renders the draft, so the draft must carry its own referenced actions: the
    // overview's lanes are capped and active-only, and a dismissed (or past-the-cap) action would
    // otherwise make a perfectly publishable draft preview as "no longer available".
    const dismissed = await niceBackendFetch(`${GROWTH_BASE}/actions/${conversionActionId}/dismiss`, { accessType: "admin", method: "POST" });
    expect(dismissed.status).toBe(200);

    const listed = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages?project_id=${projectId}`, { accessType: "client" }));
    expect(listed.status).toBe(200);
    const conversion = (listed.body as { pages: { category: string, draft: { actions: { id: string, status: string }[] } | null }[] }).pages.find((page) => page.category === "conversion");
    expect(conversion?.draft?.actions).toMatchObject([{ id: conversionActionId, status: "dismissed" }]);
  });

  it("refuses action references from another stage, and drafts that do not compile", async ({ expect }) => {
    const { projectId, retentionActionId } = await createFixture();

    const crossStage = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages`, {
      accessType: "client",
      method: "PUT",
      body: { target_project_id: projectId, category: "conversion", document: documentWith(retentionActionId), expected_draft_updated_at_millis: null },
    }));
    expect(crossStage.status).toBe(400);

    const uncompilable = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages`, {
      accessType: "client",
      method: "PUT",
      body: { target_project_id: projectId, category: "conversion", document: { format: "growth-mdx-v1", source_mdx: "<script>alert(1)</script>", data: [] }, expected_draft_updated_at_millis: null },
    }));
    expect(uncompilable.status).toBe(400);

    const listed = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages?project_id=${projectId}`, { accessType: "client" }));
    expect(listed).toMatchObject({ status: 200, body: { pages: [] } });

    const discarded = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages`, {
      accessType: "client",
      method: "DELETE",
      body: { target_project_id: projectId, category: "conversion" },
    }));
    expect(discarded.status).toBe(404);
  });

  it("refuses a draft save that was written against an older version of the draft", async ({ expect }) => {
    const { projectId, conversionActionId } = await createFixture();
    const save = async (body: { source_mdx: string, expected: number | null }) => await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        category: "conversion",
        document: { format: "growth-mdx-v1", source_mdx: body.source_mdx, data: [] },
        source_action_ids: [conversionActionId],
        expected_draft_updated_at_millis: body.expected,
      },
    }));

    const first = await save({ source_mdx: "## First author", expected: null });
    expect(first.status).toBe(200);
    const firstUpdatedAt = (first.body as { updated_at_millis: number }).updated_at_millis;

    // A second author who loaded the page before the first save holds a stale timestamp (or, having
    // seen no draft at all, none) and must not overwrite work they never saw.
    expect((await save({ source_mdx: "## Second author", expected: null })).status).toBe(409);
    expect((await save({ source_mdx: "## Second author", expected: firstUpdatedAt - 1000 })).status).toBe(409);
    expect((await save({ source_mdx: "## Second author", expected: firstUpdatedAt })).status).toBe(200);
  });

  it("keeps the version history and rolls back to an earlier version", async ({ expect }) => {
    const { projectId, conversionActionId } = await createFixture();
    const saveDraft = async (body: string) => await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages`, {
      accessType: "client",
      method: "PUT",
      body: {
        target_project_id: projectId,
        category: "conversion",
        document: { format: "growth-mdx-v1", source_mdx: `## ${body}`, data: [] },
        source_action_ids: [conversionActionId],
        // Publishing consumes the draft slot, so each save here starts from no draft.
        expected_draft_updated_at_millis: null,
      },
    }));

    expect(await saveDraft("First cut")).toMatchObject({ status: 200, body: { version: 1, status: "draft" } });
    await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages/publish`, {
      accessType: "client",
      method: "POST",
      body: { target_project_id: projectId, category: "conversion", version: 1 },
    }));
    // The published version is untouched by further editing, so a new draft takes the next number.
    expect(await saveDraft("Second cut")).toMatchObject({ status: 200, body: { version: 2, status: "draft" } });
    await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages/publish`, {
      accessType: "client",
      method: "POST",
      body: { target_project_id: projectId, category: "conversion", version: 2 },
    }));

    const afterSecondPublish = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(customerCategoryPages(afterSecondPublish.body)).toMatchObject([{ category: "conversion", version: 2 }]);

    const rolledBack = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages/publish`, {
      accessType: "client",
      method: "POST",
      body: { target_project_id: projectId, category: "conversion", version: 1 },
    }));
    expect(rolledBack).toMatchObject({ status: 200, body: { version: 1, status: "published" } });

    const afterRollback = await niceBackendFetch(`${GROWTH_BASE}/overview`, { accessType: "admin" });
    expect(customerCategoryPages(afterRollback.body)).toMatchObject([{ category: "conversion", version: 1 }]);

    const listed = await asGrowthStaff(async () => await niceBackendFetch(`${ADMIN_BASE}/category-pages?project_id=${projectId}`, { accessType: "client" }));
    expect(listed).toMatchObject({
      status: 200,
      body: { pages: [expect.objectContaining({ category: "conversion", published: expect.objectContaining({ version: 1 }), archived: [expect.objectContaining({ version: 2, status: "archived" })] })] },
    });
  });

  it("requires a platform admin", async ({ expect }) => {
    const { projectId } = await createFixture();
    const asCustomer = await niceBackendFetch(`${ADMIN_BASE}/category-pages?project_id=${projectId}`, { accessType: "admin" });
    expect(asCustomer.status).toBe(401);
  });
});
