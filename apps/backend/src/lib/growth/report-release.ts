import type { Tenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import { toJsonInput } from "./agent-writes";
import { getGrowthReportBody } from "./actions";
import { collectGrowthDocumentActionIds, compileGrowthDocument } from "./content-document";
import { assertTriggerIsValid } from "./phases";
import { RELEASED_GROWTH_REPORT_FILTER } from "./report-visibility";

export { RELEASED_GROWTH_REPORT_FILTER } from "./report-visibility";


export async function isGrowthWorkspaceReleased(tenancy: Tenancy): Promise<boolean> {
  const published = await globalPrismaClient.growthReport.findFirst({
    where: { projectId: tenancy.project.id, branchId: tenancy.branchId, ...RELEASED_GROWTH_REPORT_FILTER },
    select: { id: true },
  });
  return published != null;
}

export async function requireGrowthWorkspaceReleased(tenancy: Tenancy): Promise<void> {
  if (!(await isGrowthWorkspaceReleased(tenancy))) {
    throw new StatusError(409, "Your growth report is still being prepared.");
  }
}

export const GROWTH_RELEASE_STATES = ["not_ready", "preparing", "released"] as const;
export type GrowthReleaseState = typeof GROWTH_RELEASE_STATES[number];

export function getGrowthReleaseState(options: {
  released: boolean,
  deepAnalysisStarted: boolean,
  analysisFailed: boolean,
}): GrowthReleaseState {
  if (options.released) return "released";
  if (options.analysisFailed || !options.deepAnalysisStarted) return "not_ready";
  return "preparing";
}


async function requireReportInTenancy(tenancy: Tenancy, reportId: string) {
  if (!isUuid(reportId)) throw new StatusError(404, "Report not found.");
  const report = await globalPrismaClient.growthReport.findFirst({
    where: { id: reportId, projectId: tenancy.project.id, branchId: tenancy.branchId },
    select: { id: true, publishedAt: true, publishedByUserId: true },
  });
  if (report == null) throw new StatusError(404, "Report not found.");
  return report;
}

export async function listGrowthAdminReports(tenancy: Tenancy) {
  const reports = await globalPrismaClient.growthReport.findMany({
    where: { projectId: tenancy.project.id, branchId: tenancy.branchId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      title: true,
      summary: true,
      createdAt: true,
      publishedAt: true,
      publishedByUserId: true,
      run: { select: { trigger: true } },
    },
  });
  const actionItemCounts = await globalPrismaClient.growthActionItem.groupBy({
    by: ["reportId"],
    where: { projectId: tenancy.project.id, branchId: tenancy.branchId, reportId: { in: reports.map((report) => report.id) } },
    _count: true,
  });
  const actionItemCountByReportId = new Map(actionItemCounts.map((row) => [row.reportId, row._count]));
  return {
    reports: reports.map((report) => ({
      id: report.id,
      title: report.title,
      summary: report.summary,
      trigger: assertTriggerIsValid(report.run.trigger),
      action_item_count: actionItemCountByReportId.get(report.id) ?? 0,
      created_at_millis: report.createdAt.getTime(),
      published_at_millis: report.publishedAt == null || report.publishedByUserId == null ? null : report.publishedAt.getTime(),
      published_by_user_id: report.publishedAt == null ? null : report.publishedByUserId,
    })),
  };
}


export async function getGrowthAdminReport(tenancy: Tenancy, reportId: string) {
  const report = await requireReportInTenancy(tenancy, reportId);
  const body = await getGrowthReportBody(tenancy, report.id, { publishedOnly: false });
  return { ...body, published_at_millis: report.publishedAt == null || report.publishedByUserId == null ? null : report.publishedAt.getTime() };
}


export async function saveGrowthAdminReportDocument(tenancy: Tenancy, reportId: string, documentInput: unknown) {
  const document = compileGrowthDocument(documentInput);
  const referencedActionIds = collectGrowthDocumentActionIds(document.blocks);
  const report = await requireReportInTenancy(tenancy, reportId);

  if (referencedActionIds.length > 0) {
    const actions = await globalPrismaClient.growthActionItem.findMany({
      where: {
        id: { in: referencedActionIds },
        reportId: report.id,
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
      },
      select: { id: true },
    });
    const foundIds = new Set(actions.map((action) => action.id));
    const missingId = referencedActionIds.find((id) => !foundIds.has(id));
    if (missingId != null) {
      throw new StatusError(400, `This report references an action that does not belong to it: ${missingId}`);
    }
  }

  // Updating customer-visible copy is deliberately independent from its release receipt. The
  // report remains live with the same publishedAt/publishedByUserId; unpublish is only for taking it
  // away from the customer, not a prerequisite for correcting its content.
  await globalPrismaClient.growthReport.update({
    where: { id: report.id },
    data: { document: toJsonInput(document) },
  });
  return await getGrowthAdminReport(tenancy, report.id);
}

export async function publishGrowthReport(tenancy: Tenancy, reportId: string, input: { publishedByUserId: string, now: Date }) {
  if (!isUuid(reportId)) throw new StatusError(404, "Report not found.");
  const result = await globalPrismaClient.growthReport.updateMany({
    where: {
      id: reportId,
      projectId: tenancy.project.id,
      branchId: tenancy.branchId,
      OR: [{ publishedAt: null }, { publishedByUserId: null }],
    },
    data: { publishedAt: input.now, publishedByUserId: input.publishedByUserId },
  });
  if (result.count === 0) {
    const report = await requireReportInTenancy(tenancy, reportId);
    if (report.publishedAt != null && report.publishedByUserId != null) throw new StatusError(409, "This report is already published.");
    throw new StatusError(404, "Report not found.");
  }
  return await listGrowthAdminReports(tenancy);
}

export async function unpublishGrowthReport(tenancy: Tenancy, reportId: string) {
  const report = await requireReportInTenancy(tenancy, reportId);
  if (report.publishedAt == null || report.publishedByUserId == null) throw new StatusError(409, "This report is not published.");
  await globalPrismaClient.growthReport.update({
    where: { id: report.id },
    data: { publishedAt: null, publishedByUserId: null },
  });
  return await listGrowthAdminReports(tenancy);
}
