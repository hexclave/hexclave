// The internal Deploy Admin page's whole backend: cross-project statistics for
// the deployments alpha, plus the platform fusebox that pauses it.
//
// One route with two handlers rather than four routes, because the page loads
// everything in one request and writes exactly one thing.
//
// AUTHORIZATION, the important part: this returns data about EVERY project, so
// being signed into the internal project is not enough — the internal project's
// publishable key is public, and on an instance with open dashboard sign-up
// anyone can make themselves an internal-project account. ensurePlatformAdmin is
// what actually gates it (membership of the team that owns the internal
// project); the project check below only keeps the route off other projects'
// dashboards. See @/lib/platform-admin.

import { getDeploymentsPlatformConfig, updateDeploymentsPlatformConfig } from "@/lib/deployments/platform-config";
import { getDeploymentsPlatformStats, listRecentDeploymentsAcrossProjects, DEPLOYMENT_LIST_LIMIT } from "@/lib/deployments/platform-stats";
import { ensurePlatformAdmin } from "@/lib/platform-admin";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import {
  adaptSchema,
  clientOrHigherAuthTypeSchema,
  yupArray,
  yupBoolean,
  yupMixed,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";

const INTERNAL_PROJECT_ID = "internal";

const authSchema = yupObject({
  type: clientOrHigherAuthTypeSchema.defined(),
  tenancy: adaptSchema.defined(),
  user: adaptSchema,
  project: adaptSchema.defined(),
}).defined();

const statsSchema = yupObject({
  projects_with_provisioned_services: yupNumber().defined(),
  provisioned_services: yupNumber().defined(),
  max_deployed_services: yupNumber().defined(),
  deployments_total: yupNumber().defined(),
  deployments_recent: yupNumber().defined(),
  builds_total: yupNumber().defined(),
  builds_recent: yupNumber().defined(),
  deployments_in_flight: yupNumber().defined(),
  deployments_succeeded_recent: yupNumber().defined(),
  deployments_failed_recent: yupNumber().defined(),
  sources_by_runtime: yupArray(yupObject({
    runtime: yupString().defined(),
    count: yupNumber().defined(),
  }).defined()).defined(),
  recent_window_days: yupNumber().defined(),
}).defined();

const fuseboxSchema = yupObject({
  deployments_enabled: yupBoolean().defined(),
}).defined();

const overviewResponseSchema = yupObject({
  statusCode: yupNumber().oneOf([200]).defined(),
  bodyType: yupString().oneOf(["json"]).defined(),
  body: yupObject({
    fusebox: fuseboxSchema,
    stats: statsSchema,
    // yupMixed rather than a spelled-out deployment schema: the rows are
    // whatever deploymentToApiShape returns, and restating that shape here would
    // give it a second definition to drift from.
    deployments: yupArray(yupMixed().defined()).defined(),
    deployments_limit: yupNumber().defined(),
  }).defined(),
});

/**
 * Both handlers' gate. The user check is not redundant with the auth schema:
 * client auth is satisfied by a publishable key alone, so without it a request
 * with no user at all would reach ensurePlatformAdmin.
 */
async function ensureInternalPlatformAdmin(auth: { project: { id: string }, user?: unknown }): Promise<void> {
  if (auth.project.id !== INTERNAL_PROJECT_ID) {
    throw new KnownErrors.ExpectedInternalProject();
  }
  if (!auth.user) {
    throw new KnownErrors.UserAuthenticationRequired();
  }
  await ensurePlatformAdmin(auth.user as Parameters<typeof ensurePlatformAdmin>[0]);
}

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Deployments platform overview",
    description: "Cross-project statistics for the Deployments app, the newest deployments across every project, and the current state of the platform fusebox. Internal, platform-admin only.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: authSchema,
    method: yupString().oneOf(["GET"]).defined(),
  }),
  response: overviewResponseSchema,
  handler: async ({ auth }) => {
    await ensureInternalPlatformAdmin(auth);
    const [config, stats, deployments] = await Promise.all([
      getDeploymentsPlatformConfig(),
      getDeploymentsPlatformStats(),
      listRecentDeploymentsAcrossProjects(),
    ]);
    return {
      statusCode: 200,
      bodyType: "json" as const,
      body: {
        fusebox: { deployments_enabled: config.deploymentsEnabled },
        stats: {
          projects_with_provisioned_services: stats.projectsWithProvisionedServices,
          provisioned_services: stats.provisionedServices,
          max_deployed_services: stats.maxDeployedServices,
          deployments_total: stats.deploymentsTotal,
          deployments_recent: stats.deploymentsRecent,
          builds_total: stats.buildsTotal,
          builds_recent: stats.buildsRecent,
          deployments_in_flight: stats.deploymentsInFlight,
          deployments_succeeded_recent: stats.deploymentsSucceededRecent,
          deployments_failed_recent: stats.deploymentsFailedRecent,
          sources_by_runtime: stats.sourcesByRuntime,
          recent_window_days: stats.recentWindowDays,
        },
        deployments: deployments.map((row) => ({
          project_id: row.projectId,
          project_display_name: row.projectDisplayName,
          runtime: row.runtime,
          ...row.deployment,
        })),
        deployments_limit: DEPLOYMENT_LIST_LIMIT,
      },
    };
  },
});

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Update the deployments platform fusebox",
    description: "Turns the creation of new deployments on or off across this whole Hexclave instance. Internal, platform-admin only.",
    tags: ["Deploy"],
    hidden: true,
  },
  request: yupObject({
    auth: authSchema,
    body: yupObject({
      deployments_enabled: yupBoolean().defined(),
    }).defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: fuseboxSchema,
  }),
  handler: async ({ auth, body }) => {
    await ensureInternalPlatformAdmin(auth);
    const config = await updateDeploymentsPlatformConfig({
      deploymentsEnabled: body.deployments_enabled,
    });
    return {
      statusCode: 200,
      bodyType: "json" as const,
      body: { deployments_enabled: config.deploymentsEnabled },
    };
  },
});
