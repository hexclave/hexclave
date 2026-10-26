// Cross-tenant statistics for the internal Deploy Admin page.
//
// Everything here reads the GLOBAL database directly, across every tenancy —
// which is what makes it an operator's view of the deployments alpha rather than
// a project's. It is therefore only ever reachable from an internal-project,
// platform-admin route.
//
// KNOWN LIMITATION, deliberately accepted: a tenancy whose config names its own
// `sourceOfTruth` keeps its deployment rows in a different database, and nothing
// here sees them. That is exactly the limitation assertGlobalDeploymentCapacity
// already lives with (it counts provisioned services the same way), so the
// numbers here agree with the ceiling they are compared against. The page says
// so rather than implying a total.
//
// No Marshal calls: MarshalClient can only list services one namespace at a
// time, so reconciling live runtime state would mean a fan-out of one HTTP
// request per tenancy on every page load. Drift detection is worth having and is
// deliberately left out of this first cut.

import type { DeploymentStatus } from "@/generated/prisma/client";
import { globalPrismaClient } from "@/prisma-client";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { MAX_GLOBAL_DEPLOYED_SERVICES, deploymentToApiShape, type DeploymentApiShape } from "@/lib/deployments";

/** The trailing window every "recent" number on the page is measured over. */
export const RECENT_WINDOW_DAYS = 7;

/** How many deployments the page's table lists. Newest first, no pagination. */
export const DEPLOYMENT_LIST_LIMIT = 100;

// Non-terminal statuses — a deployment the runtime is still working on. Kept as
// a literal list rather than derived from isTerminalDeploymentStatus because
// this one has to go into a Prisma `in` filter.
const IN_FLIGHT_STATUSES = ["QUEUED", "BUILDING", "DEPLOYING"] as const satisfies readonly DeploymentStatus[];

export type DeploymentsPlatformStats = {
  /** Distinct PROJECTS (not tenancies) holding at least one provisioned service. */
  projectsWithProvisionedServices: number,
  provisionedServices: number,
  maxDeployedServices: number,
  deploymentsTotal: number,
  deploymentsRecent: number,
  buildsTotal: number,
  buildsRecent: number,
  deploymentsInFlight: number,
  deploymentsSucceededRecent: number,
  deploymentsFailedRecent: number,
  /** Deployment SOURCES by their runtime ("fly" / "gcp"), newest split first. */
  sourcesByRuntime: { runtime: string, count: number }[],
  recentWindowDays: number,
};

export type DeploymentsPlatformListRow = {
  projectId: string,
  projectDisplayName: string,
  runtime: string,
  deployment: DeploymentApiShape,
};

/**
 * The six headline numbers, plus the runtime split.
 *
 * "Builds" is narrower than "deployments": a deployment whose every service runs
 * an already-built image starts no builder machine and produces no log. The
 * condition matches what deploymentToApiShape reports as `has_build_logs`, so
 * the tile and the per-deployment UI cannot disagree.
 *
 * CAVEAT worth knowing when reading the number: hasBuildLogs defaults to true,
 * so every deployment written before prebuilt images existed counts as a build —
 * which it was.
 */
export async function getDeploymentsPlatformStats(): Promise<DeploymentsPlatformStats> {
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const buildWhere = { marshalBuildId: { not: null }, hasBuildLogs: true } as const;

  const [
    provisionedServices,
    provisionedTenancies,
    deploymentsTotal,
    deploymentsRecent,
    buildsTotal,
    buildsRecent,
    deploymentsInFlight,
    recentByStatus,
    sourceRuntimeGroups,
  ] = await Promise.all([
    globalPrismaClient.deploymentService.count({ where: { provisionedAt: { not: null } } }),
    // Grouped, then resolved to projects below: several tenancies (branches,
    // organizations) of one project each hold their own services, and counting
    // them would overstate how many customers are on the alpha.
    globalPrismaClient.deploymentService.groupBy({
      by: ["tenancyId"],
      where: { provisionedAt: { not: null } },
    }),
    globalPrismaClient.deployment.count(),
    globalPrismaClient.deployment.count({ where: { createdAt: { gte: since } } }),
    globalPrismaClient.deployment.count({ where: buildWhere }),
    globalPrismaClient.deployment.count({ where: { ...buildWhere, createdAt: { gte: since } } }),
    globalPrismaClient.deployment.count({ where: { status: { in: [...IN_FLIGHT_STATUSES] } } }),
    globalPrismaClient.deployment.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    globalPrismaClient.deploymentSource.groupBy({
      by: ["runtime"],
      _count: { _all: true },
    }),
  ]);

  const projectIds = provisionedTenancies.length === 0 ? [] : (await globalPrismaClient.tenancy.findMany({
    where: { id: { in: provisionedTenancies.map((group) => group.tenancyId) } },
    select: { projectId: true },
  })).map((tenancy) => tenancy.projectId);

  const countForStatus = (status: DeploymentStatus) => recentByStatus.find((group) => group.status === status)?._count._all ?? 0;

  return {
    projectsWithProvisionedServices: new Set(projectIds).size,
    provisionedServices,
    maxDeployedServices: MAX_GLOBAL_DEPLOYED_SERVICES,
    deploymentsTotal,
    deploymentsRecent,
    buildsTotal,
    buildsRecent,
    deploymentsInFlight,
    deploymentsSucceededRecent: countForStatus("SUCCEEDED"),
    deploymentsFailedRecent: countForStatus("FAILED"),
    sourcesByRuntime: sourceRuntimeGroups
      .map((group) => ({ runtime: group.runtime, count: group._count._all }))
      .sort((a, b) => b.count - a.count || stringCompare(a.runtime, b.runtime)),
    recentWindowDays: RECENT_WINDOW_DAYS,
  };
}

/**
 * The newest deployments across every project, for the page's table.
 *
 * Each row carries the project it belongs to and its source's runtime — the two
 * things a per-project deployment listing never has to say and an operator's
 * always does. The deployment itself goes through deploymentToApiShape at
 * "summary" detail, so the service URLs here are exactly the ones the customer's
 * own dashboard shows, and the (potentially large) source manifest is left out.
 */
export async function listRecentDeploymentsAcrossProjects(limit: number = DEPLOYMENT_LIST_LIMIT): Promise<DeploymentsPlatformListRow[]> {
  const deployments = await globalPrismaClient.deployment.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      source: { select: { sourceId: true, runtime: true } },
      tenancy: { select: { projectId: true, project: { select: { displayName: true } } } },
    },
  });
  return deployments.map((deployment) => ({
    projectId: deployment.tenancy.projectId,
    projectDisplayName: deployment.tenancy.project.displayName,
    runtime: deployment.source.runtime,
    deployment: deploymentToApiShape(deployment, "summary"),
  }));
}
