// Platform-wide (cross-tenant) switches for the Deployments app, and the guard
// that enforces them.
//
// These are the OPERATOR's controls over the deployments alpha as a whole, not a
// project's settings: they live in a singleton row of DeploymentsPlatformConfig
// and are flipped from the internal dashboard's Deploy Admin page. Nothing here
// is per-project — see the model's doc comment for why an override table is
// deliberately not modelled yet.

import { BooleanTrue } from "@/generated/prisma/client";
import { globalPrismaClient } from "@/prisma-client";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export type DeploymentsPlatformConfig = {
  deploymentsEnabled: boolean,
};

const configSelect = {
  deploymentsEnabled: true,
} as const;

// Matches the Prisma schema defaults, which are today's behaviour. A missing row
// is the normal state on an instance where nobody has ever flipped a switch, so
// it has to read as "everything on" rather than as an error.
const defaultConfig: DeploymentsPlatformConfig = {
  deploymentsEnabled: true,
};

export async function getDeploymentsPlatformConfig(): Promise<DeploymentsPlatformConfig> {
  const result = await globalPrismaClient.deploymentsPlatformConfig.findFirst({
    where: { singleton: BooleanTrue.TRUE },
    select: configSelect,
  });
  return result ?? defaultConfig;
}

export async function updateDeploymentsPlatformConfig(updates: DeploymentsPlatformConfig): Promise<DeploymentsPlatformConfig> {
  // Upsert rather than update: the row is created by the first operator who
  // flips something, not by the migration (which must not be able to turn
  // deploys off). Writes are rare and manual, so the upsert's cost is irrelevant.
  return await globalPrismaClient.deploymentsPlatformConfig.upsert({
    where: { singleton: BooleanTrue.TRUE },
    create: { singleton: BooleanTrue.TRUE, ...updates },
    update: updates,
    select: configSelect,
  });
}

/**
 * Refuses to create a new deployment while the fusebox is off.
 *
 * Called from the two routes that START work — POST /deployments/deployments and
 * POST /deployments/uploads. The upload is gated too so the CLI fails in a
 * second instead of after pushing a source tarball it can never deploy.
 *
 * Deliberately NOT called from anywhere else: a deployment already in flight
 * runs to completion, its status and logs stay readable, and tearing services
 * down (PUT /deployments/services) keeps working — an operator who has just cut
 * deploys off needs those paths more than ever, not less.
 *
 * 503 rather than 403: this is a temporary platform state the caller can do
 * nothing about, which is also how the global capacity guard answers.
 */
export async function assertDeploymentsEnabled(): Promise<void> {
  const config = await getDeploymentsPlatformConfig();
  if (config.deploymentsEnabled) return;
  throw new StatusError(503, [
    "Deployments are temporarily disabled on this Hexclave instance.",
    "",
    // Says whose problem it is and what still works, for the same reason the
    // capacity guard does: the reader's next move is "wait or ask", not "edit my
    // deploy file".
    "This is a platform-wide pause, not a limit on your project, and the Hexclave team is aware of it. Services you already have deployed keep running; please try again later, or contact support if this is blocking you.",
  ].join("\n"));
}
