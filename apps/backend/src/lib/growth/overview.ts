import type { Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { growthActionItemToWire, loadGrowthActionWorkflowRuntimeInfo } from "./actions";
import { GROWTH_CATEGORIES, GROWTH_NOTE_KIND, isGrowthCategory, normalizeStoredGrowthCategory, type GrowthCategory } from "./categories";
import { getGrowthPublishedCategoryPages } from "./category-pages";

const DEFAULT_OVERVIEW_LIMIT = 24;
const MAX_OVERVIEW_LIMIT = 50;

export function normalizeGrowthOverviewLimit(requestedLimit?: number): number {
  return Math.max(1, Math.min(MAX_OVERVIEW_LIMIT, requestedLimit ?? DEFAULT_OVERVIEW_LIMIT));
}

function assertStoredCategory(value: string | null): GrowthCategory | null {
  if (value == null) return null;
  return normalizeStoredGrowthCategory(value)
    ?? throwErr(new HexclaveAssertionError(`Growth overview encountered an invalid stored category \"${value}\".`, { value }));
}

export function growthFindingToWire(finding: {
  id: string,
  source: string,
  kind: string,
  category: string | null,
  tags: string[],
  title: string,
  body: string,
  data: unknown,
  document?: unknown,
  createdAt: Date,
}) {
  return {
    id: finding.id,
    source: finding.source,
    kind: finding.kind,
    category: assertStoredCategory(finding.category),
    tags: finding.tags,
    title: finding.title,
    body: finding.body,
    data: finding.data ?? null,
    document: finding.document ?? null,
    created_at_millis: finding.createdAt.getTime(),
  };
}

/**
 * Builds the bounded, branch-scoped read model for both the customer workspace and the internal
 * editor. Keeping the aggregation in the Growth domain prevents either caller from learning about
 * persistence details or becoming a second source of business logic.
 */
export async function getGrowthOverviewBody(tenancy: Tenancy, requestedLimit?: number) {
  const projectId = tenancy.project.id;
  const branchId = tenancy.branchId;
  const limit = normalizeGrowthOverviewLimit(requestedLimit);

  const [latestReport, latestBrief, findings, notes, activeActions, archivedActions, storedScores, findingCategoryCounts, actionCategoryCounts, unclassifiedFindings, unclassifiedActions, categoryPages] = await Promise.all([
    globalPrismaClient.growthReport.findFirst({
      where: { projectId, branchId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, title: true, summary: true, createdAt: true },
    }),
    globalPrismaClient.growthBrief.findFirst({
      where: { projectId, branchId, status: "ready" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, date: true, summary: true, contentMd: true, createdAt: true },
    }),
    // The two lanes split on KIND alone, not on `source === "admin" && kind === "note"` as they
    // originally did. Notes used to be admin-authored only; the analysis phases now write them too
    // (trends and patterns observed across the metric history), and keying the lane on the admin
    // source would have forced agent notes to masquerade as human ones to appear here. Splitting on
    // the kind keeps `source` honest — it stays the phase key that observed the trend — while both
    // kinds of note still land in the same lane. See GROWTH_NOTE_KIND in categories.ts.
    globalPrismaClient.growthFinding.findMany({
      where: { projectId, branchId, NOT: { kind: GROWTH_NOTE_KIND } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    }),
    globalPrismaClient.growthFinding.findMany({
      where: { projectId, branchId, kind: GROWTH_NOTE_KIND },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    }),
    globalPrismaClient.growthActionItem.findMany({
      where: { projectId, branchId, status: { in: ["proposed", "active"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    }),
    globalPrismaClient.growthActionItem.findMany({
      where: { projectId, branchId, status: { in: ["completed", "dismissed"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    }),
    globalPrismaClient.growthCategoryScore.findMany({ where: { projectId, branchId } }),
    globalPrismaClient.growthFinding.groupBy({
      by: ["category"],
      where: { projectId, branchId, category: { not: null } },
      _count: true,
    }),
    globalPrismaClient.growthActionItem.groupBy({
      by: ["category"],
      where: { projectId, branchId, category: { not: null } },
      _count: true,
    }),
    globalPrismaClient.growthFinding.count({ where: { projectId, branchId, category: null } }),
    globalPrismaClient.growthActionItem.count({ where: { projectId, branchId, category: null } }),
    // Only the LIVE stage pages, for both callers: the internal editor gets drafts
    // and history from its own endpoint, so this read model has no way to leak an
    // unpublished page to a customer.
    getGrowthPublishedCategoryPages(tenancy),
  ]);

  // A live page's <ActionButton> must resolve even when the action it points at falls outside the
  // capped, status-filtered lanes above (completed, dismissed, or simply older than the cap):
  // otherwise the customer reads a page whose own buttons claim to no longer exist.
  const loadedActionIds = new Set([...activeActions, ...archivedActions].map((item) => item.id));
  const missingReferencedIds = [...new Set(categoryPages.flatMap((page) => page.referenced_action_ids))].filter((id) => !loadedActionIds.has(id));
  const referencedActions = missingReferencedIds.length === 0 ? [] : await globalPrismaClient.growthActionItem.findMany({
    where: { projectId, branchId, id: { in: missingReferencedIds } },
  });

  const actions = [...activeActions, ...archivedActions, ...referencedActions];
  const workflowRuntimeByItemId = await loadGrowthActionWorkflowRuntimeInfo(tenancy, actions);
  const actionById = new Map(actions.map((item) => [item.id, item]));
  const counts = new Map<GrowthCategory, number>(GROWTH_CATEGORIES.map((category) => [category, 0]));
  for (const row of [...findingCategoryCounts, ...actionCategoryCounts]) {
    const category = assertStoredCategory(row.category);
    if (category != null) counts.set(category, (counts.get(category) ?? 0) + row._count);
  }
  const scoreByCategory = new Map<GrowthCategory, number>();
  const legacyScoreTotals = new Map<GrowthCategory, { total: number, count: number }>();
  for (const row of storedScores) {
    const category = assertStoredCategory(row.category) ?? throwErr(new HexclaveAssertionError("GrowthCategoryScore.category cannot be null."));
    if (isGrowthCategory(row.category)) {
      scoreByCategory.set(category, row.score);
    } else {
      const aggregate = legacyScoreTotals.get(category) ?? { total: 0, count: 0 };
      legacyScoreTotals.set(category, { total: aggregate.total + row.score, count: aggregate.count + 1 });
    }
  }
  for (const [category, aggregate] of legacyScoreTotals) {
    if (!scoreByCategory.has(category)) scoreByCategory.set(category, Math.round(aggregate.total / aggregate.count));
  }

  return {
    latest_report: latestReport == null ? null : {
      id: latestReport.id,
      title: latestReport.title,
      summary: latestReport.summary,
      created_at_millis: latestReport.createdAt.getTime(),
    },
    latest_brief: latestBrief == null ? null : {
      id: latestBrief.id,
      date: latestBrief.date.toISOString().slice(0, 10),
      summary: latestBrief.summary,
      content_md: latestBrief.contentMd,
      created_at_millis: latestBrief.createdAt.getTime(),
    },
    findings: findings.map(growthFindingToWire),
    notes: notes.map(growthFindingToWire),
    actions: activeActions.map((item) => growthActionItemToWire(item, workflowRuntimeByItemId.get(item.id) ?? null)),
    archive: archivedActions.map((item) => growthActionItemToWire(item, workflowRuntimeByItemId.get(item.id) ?? null)),
    categories: GROWTH_CATEGORIES.map((category) => ({
      category,
      count: counts.get(category) ?? 0,
      score: scoreByCategory.get(category) ?? null,
    })),
    category_pages: categoryPages.map((page) => ({
      category: page.category,
      version: page.version,
      document: page.document,
      published_at_millis: page.published_at_millis,
      actions: page.referenced_action_ids.flatMap((id) => {
        const item = actionById.get(id);
        return item == null ? [] : [growthActionItemToWire(item, workflowRuntimeByItemId.get(item.id) ?? null)];
      }),
    })),
    needs_category_count: unclassifiedFindings + unclassifiedActions,
    limit,
  };
}
