import { Prisma } from "@/generated/prisma/client";
import { ensurePlatformAdmin } from "@/lib/platform-admin";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import type { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { activateGrowthActionItem, dismissGrowthActionItem, growthActionItemToWire, loadGrowthActionWorkflowRuntimeInfo } from "./actions";
import { assertGrowthAdminActionTransition } from "./admin-state";
import { resolveGrowthWatchedMetrics, toJsonInput, type GrowthAgentActionItemWorkflowInput } from "./agent-writes";
import { assertGrowthActionTypeId } from "./action-item-types";
import { assertGrowthCategory, assertGrowthCategoryScore, normalizeGrowthTags, type GrowthCategory } from "./categories";
import { getGrowthOverviewBody } from "./overview";
import { getGrowthActionEventSlug, validateGrowthWorkflowSpec } from "./workflow-authoring";

const INTERNAL_PROJECT_ID = "internal";
type GrowthAdminUser = UsersCrud["Admin"]["Read"];

async function ensureGrowthAdmin(authProjectId: string, user: GrowthAdminUser | null | undefined): Promise<void> {
  if (user == null) throw new KnownErrors.UserAuthenticationRequired();
  if (authProjectId !== INTERNAL_PROJECT_ID) throw new KnownErrors.ExpectedInternalProject();
  await ensurePlatformAdmin(user);
}

export async function listGrowthAdminProjects(authProjectId: string, user: GrowthAdminUser | null | undefined) {
  await ensureGrowthAdmin(authProjectId, user);
  const rows = await globalPrismaClient.growthOnboarding.findMany({
    where: { branchId: DEFAULT_BRANCH_ID, projectId: { not: INTERNAL_PROJECT_ID } },
    select: { websiteUrl: true, companySummary: true, completedAt: true, project: { select: { id: true, displayName: true } } },
    orderBy: [{ project: { displayName: "asc" } }, { projectId: "asc" }],
  });
  return rows.map((row) => ({
    id: row.project.id,
    display_name: row.project.displayName,
    website_url: row.websiteUrl,
    company_summary: row.companySummary,
    completed_at_millis: row.completedAt.getTime(),
  }));
}

export async function requireGrowthAdminTenancy(authProjectId: string, user: GrowthAdminUser | null | undefined, targetProjectId: string): Promise<Tenancy> {
  await ensureGrowthAdmin(authProjectId, user);
  if (targetProjectId === INTERNAL_PROJECT_ID) throw new StatusError(400, "Select an onboarded customer project.");
  const onboarding = await globalPrismaClient.growthOnboarding.findUnique({
    where: { projectId_branchId: { projectId: targetProjectId, branchId: DEFAULT_BRANCH_ID } },
    select: { projectId: true },
  });
  if (onboarding == null) throw new StatusError(404, "Growth project not found.");
  const tenancy = await getSoleTenancyFromProjectBranch(targetProjectId, DEFAULT_BRANCH_ID, true);
  if (tenancy == null) throw new StatusError(404, "Growth project tenancy not found.");
  return tenancy;
}

export async function getGrowthAdminOverview(authProjectId: string, user: GrowthAdminUser | null | undefined, targetProjectId: string) {
  return await getGrowthOverviewBody(await requireGrowthAdminTenancy(authProjectId, user, targetProjectId), 50);
}

export async function createGrowthAdminFinding(tenancy: Tenancy, input: { kind: string, category: GrowthCategory, tags: string[], title: string, body: string, note: boolean }) {
  const finding = await globalPrismaClient.growthFinding.create({
    data: {
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      source: "admin",
      kind: input.note ? "note" : input.kind,
      category: assertGrowthCategory(input.category),
      tags: normalizeGrowthTags(input.tags),
      title: input.title,
      body: input.body,
    },
  });
  return { id: finding.id };
}

export async function updateGrowthAdminFinding(tenancy: Tenancy, findingId: string, input: { kind: string, category: GrowthCategory, tags: string[], title: string, body: string }) {
  const result = await globalPrismaClient.growthFinding.updateMany({
    where: { id: findingId, projectId: tenancy.project.id, branchId: tenancy.branchId },
    data: { kind: input.kind, category: assertGrowthCategory(input.category), tags: normalizeGrowthTags(input.tags), title: input.title, body: input.body },
  });
  if (result.count === 0) throw new StatusError(404, "Growth finding not found.");
  return { id: findingId };
}

export async function deleteGrowthAdminFinding(tenancy: Tenancy, findingId: string) {
  const result = await globalPrismaClient.growthFinding.deleteMany({ where: { id: findingId, projectId: tenancy.project.id, branchId: tenancy.branchId, source: "admin" } });
  if (result.count === 0) throw new StatusError(404, "Admin note not found.");
  return { status: "deleted" };
}

export async function setGrowthAdminCategoryScore(tenancy: Tenancy, category: GrowthCategory, score: number) {
  const normalizedCategory = assertGrowthCategory(category);
  assertGrowthCategoryScore(score);
  await globalPrismaClient.growthCategoryScore.upsert({
    where: { projectId_branchId_category: { projectId: tenancy.project.id, branchId: tenancy.branchId, category: normalizedCategory } },
    create: { projectId: tenancy.project.id, branchId: tenancy.branchId, category: normalizedCategory, score },
    update: { score },
  });
  return { category: normalizedCategory, score };
}

type AdminActionUpdate = {
  typeId: string,
  category: GrowthCategory,
  tags: string[],
  title: string,
  description: string,
  payload: unknown | undefined,
  watchedMetrics: { metric_id: string, window_days: number }[] | undefined,
  workflow: GrowthAgentActionItemWorkflowInput | null | undefined,
  status: string,
};

async function validateAdminWorkflow(tenancy: Tenancy, workflow: GrowthAgentActionItemWorkflowInput | null | undefined): Promise<Prisma.InputJsonValue | undefined> {
  if (workflow == null) return undefined;
  const result = await validateGrowthWorkflowSpec({ tenancy, workflowId: workflow.workflowId, source: workflow.source, expectedActionEventSlug: getGrowthActionEventSlug(workflow.workflowId) });
  if (!result.valid || result.manifest == null) throw new StatusError(400, result.error ?? "Invalid Growth workflow.");
  return toJsonInput(result.manifest);
}

export async function updateGrowthAdminAction(tenancy: Tenancy, actionId: string, input: AdminActionUpdate) {
  assertGrowthActionTypeId(input.typeId);
  const existing = await globalPrismaClient.growthActionItem.findFirst({ where: { id: actionId, projectId: tenancy.project.id, branchId: tenancy.branchId } });
  if (existing == null) throw new StatusError(404, "Growth action not found.");
  const requestedStatus = assertGrowthAdminActionTransition(existing.status, input.status);

  const effectivePayload = input.payload === undefined ? existing.payload : input.payload;
  if (effectivePayload != null && typeof effectivePayload === "object" && !Array.isArray(effectivePayload) && "ad_campaign" in effectivePayload) {
    if (input.typeId !== "run_ads") throw new StatusError(400, "ad_campaign is only valid on run_ads actions.");
    // Shape-only: the full AdCampaignSpec validation (objective/delivery matrix, budget floors,
    // creative binding, live account facts) belongs to the ad platform integration and lands with
    // it. Until then an ad_campaign payload is an inert proposal — nothing reads it to create
    // anything — so the only invariant worth enforcing here is that it is a JSON object at all.
    const adCampaign = effectivePayload.ad_campaign;
    if (typeof adCampaign !== "object" || adCampaign == null || Array.isArray(adCampaign)) {
      throw new StatusError(400, "ad_campaign must be an object.");
    }
  }
  const watchedMetrics = input.watchedMetrics === undefined
    ? input.typeId === existing.typeId ? undefined : resolveGrowthWatchedMetrics(input.typeId, undefined)
    : resolveGrowthWatchedMetrics(input.typeId, input.watchedMetrics);

  if (existing.status !== "proposed") {
    const functionalChanged = input.typeId !== existing.typeId || input.payload !== undefined || input.watchedMetrics !== undefined || input.workflow !== undefined;
    if (functionalChanged) throw new StatusError(400, "Functional fields are immutable after activation. Use the workflow or campaign lifecycle controls for deployed changes.");
  }
  const workflowManifest = existing.status === "proposed" && input.workflow !== undefined ? await validateAdminWorkflow(tenancy, input.workflow) : undefined;
  await globalPrismaClient.growthActionItem.update({
    where: { id: existing.id },
    data: {
      typeId: input.typeId,
      category: assertGrowthCategory(input.category),
      tags: normalizeGrowthTags(input.tags),
      title: input.title,
      description: input.description,
      ...existing.status !== "proposed" ? {} : {
        payload: input.payload === undefined ? existing.payload ?? undefined : toJsonInput(input.payload),
        ...watchedMetrics === undefined ? {} : { watchedMetrics: toJsonInput(watchedMetrics) },
        ...input.workflow === undefined ? {} : {
          workflowId: input.workflow?.workflowId ?? null,
          workflowSource: input.workflow?.source ?? null,
          workflowManifest: workflowManifest ?? Prisma.JsonNull,
          workflowExplanation: input.workflow?.explanation ?? null,
          workflowRollbackNote: input.workflow?.rollbackNote ?? null,
        },
      },
    },
  });
  if (requestedStatus === "active") await activateGrowthActionItem(tenancy, existing.id);
  if (requestedStatus === "dismissed") await dismissGrowthActionItem(tenancy, existing.id);
  const updated = await globalPrismaClient.growthActionItem.findUnique({ where: { id: existing.id } });
  if (updated == null) throw new StatusError(404, "Growth action not found after update.");
  const runtime = await loadGrowthActionWorkflowRuntimeInfo(tenancy, [updated]);
  return growthActionItemToWire(updated, runtime.get(updated.id) ?? null);
}
